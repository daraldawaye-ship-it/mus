import { Client } from "pg";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const controlSchema = "_alraesy_migration";
const backupSchema = "_alraesy_render_preview_backup";
const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
const fail = (code) => Object.assign(new Error(code), { code });
const tableQuery = `SELECT n.nspname AS schema, c.relname AS name
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind IN ('r','p') AND n.nspname !~ '^pg_'
    AND n.nspname NOT IN ('information_schema','${controlSchema}','${backupSchema}')
  ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C"`;

function connection(url, source = false) {
  return new Client({ connectionString: url.href, connectionTimeoutMillis: 15000,
    statement_timeout: 300000,
    ...(source && url.hostname !== "127.0.0.1" && url.hostname !== "localhost"
      ? { ssl: { rejectUnauthorized: false } } : {}) });
}

function toolEnvironment(url, source, toolDir) {
  const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGCONNECT_TIMEOUT: "15",
    PGSSLMODE: source && !["127.0.0.1", "localhost"].includes(url.hostname) ? "require" : "prefer",
    PGAPPNAME: "alraesy_migration", LD_LIBRARY_PATH: join(toolDir, "lib") };
  // Connection URLs and passwords never appear in command arguments or logs.
  delete env.PGSERVICE;
  delete env.PGSERVICEFILE;
  return env;
}

async function tool(executable, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let detail = "";
    child.stderr.on("data", (chunk) => {
      if (detail.length < 65536) detail += chunk.toString();
    });
    child.on("error", () => reject(fail("TOOL_START_FAILED")));
    child.on("exit", (code) => code === 0 ? resolve() : reject(
      Object.assign(fail("POSTGRES_TOOL_FAILED"), { privateDetail: detail })));
  });
}

async function restorePublicAtomically(archive,url,toolDir) {
  // psql owns one transaction spanning the schema rename and the complete dump.
  // No old preview row is merged with source data. On any stream/SQL error the
  // connection closes and PostgreSQL rolls the transaction back.
  const env=toolEnvironment(url,false,toolDir);
  const listing=await new Promise((resolve,reject)=>{
    const child=spawn(join(toolDir,"bin/pg_restore"),["--list",archive],{env,stdio:["ignore","pipe","ignore"]});
    let text="";child.stdout.on("data",chunk=>{text+=chunk;});
    child.on("error",()=>reject(fail("TOOL_START_FAILED")));
    child.on("close",code=>code===0?resolve(text):reject(fail("ARCHIVE_LIST_FAILED")));
  });
  const createsPublic=/;[^\n]*\bSCHEMA\s+-\s+public\s/m.test(listing);
  return new Promise((resolve,reject)=>{
    const loader=spawn(join(toolDir,"bin/psql"),["--no-psqlrc","--quiet","--single-transaction","--set=ON_ERROR_STOP=on","--file=-"],{env,stdio:["pipe","ignore","pipe"]});
    const exporter=spawn(join(toolDir,"bin/pg_restore"),["--no-owner","--no-acl","--file=-",archive],{env,stdio:["ignore","pipe","pipe"]});
    let detail="",exportCode,loadCode,finished=false;
    const finish=()=>{
      if(finished || exportCode===undefined || loadCode===undefined) return;
      finished=true;
      if(exportCode===0&&loadCode===0)resolve();
      else reject(Object.assign(fail("ATOMIC_RESTORE_FAILED"),{privateDetail:detail}));
    };
    const error=()=>{exporter.kill("SIGTERM");loader.kill("SIGTERM");};
    for(const child of [loader,exporter]){
      child.stderr.on("data",chunk=>{if(detail.length<65536)detail+=chunk.toString();});
      child.on("error",error);
    }
    loader.stdin.on("error",()=>exporter.kill("SIGTERM"));
    loader.stdin.write(`ALTER SCHEMA public RENAME TO ${quote(backupSchema)};\n`+
      (createsPublic?"":"CREATE SCHEMA public;\n"));
    exporter.stdout.pipe(loader.stdin,{end:false});
    exporter.on("close",code=>{exportCode=code??-1;if(code===0)loader.stdin.end("\n");else loader.kill("SIGTERM");finish();});
    loader.on("close",code=>{loadCode=code??-1;if(code!==0)exporter.kill("SIGTERM");finish();});
  });
}

async function beginSnapshot(client) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  await client.query("SET LOCAL DateStyle TO 'ISO, YMD'");
  await client.query("SET LOCAL IntervalStyle TO 'postgres'");
  await client.query("SET LOCAL bytea_output TO 'hex'");
  await client.query("SET LOCAL extra_float_digits TO 3");
}

// PG18 deparses a varchar-literal array cast as ARRAY[...]::text[]; PG17
// deparses the same parsed expression as ARRAY[literal::varchar::text,...].
// Normalize only these unbounded string-literal casts and all-text arrays.
export function portableDefinition(definition) {
  const string = "(?<!')('(?:[^']|'')*')(?!')";
  let result = definition
    .replace(new RegExp("\\(" + string + "::character varying\\)::text", "g"), "$1::text")
    .replace(new RegExp(string + "::character varying(?:::text)?(?![a-z_(])", "g"), "$1::text");
  const element = "'(?:[^']|'')*'::text";
  const array = "ARRAY\\[" + element + "(?:, " + element + ")*\\]";
  result = result.replace(new RegExp("\\((" + array + ")\\)::text\\[\\]", "g"), "$1");
  return result.replace(new RegExp("(" + array + ")::text\\[\\]", "g"), "$1");
}

// Hash exact serialized values on the server, retaining duplicate rows. Fetching
// only hashes in bounded batches avoids decoding NUMERIC/bytea into JS values.
export async function fingerprint(client) {
  const tables = (await client.query(tableQuery)).rows;
  const data = [];
  for (const table of tables) {
    const qualified = quote(table.schema) + "." + quote(table.name);
    await client.query(`DECLARE migration_rows NO SCROLL CURSOR FOR
      SELECT h FROM (SELECT encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') AS h
      FROM ${qualified} AS t) AS hashes ORDER BY h COLLATE "C"`);
    const digest = createHash("sha256");
    let count = 0n;
    try {
      for (;;) {
        const result = await client.query("FETCH FORWARD 2000 FROM migration_rows");
        if (!result.rows.length) break;
        for (const row of result.rows) digest.update(row.h + "\n");
        count += BigInt(result.rows.length);
      }
    } finally { await client.query("CLOSE migration_rows"); }
    data.push({ ...table, rows: count.toString(), sha256: digest.digest("hex") });
  }
  const sequences = [];
  const sequenceNames = await client.query(`SELECT n.nspname AS schema,c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind='S' AND n.nspname !~ '^pg_' AND n.nspname NOT IN ('${controlSchema}','${backupSchema}')
    ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"`);
  for (const sequence of sequenceNames.rows) {
    const value = await client.query(`SELECT last_value::text, is_called FROM ${quote(sequence.schema)}.${quote(sequence.name)}`);
    sequences.push({ ...sequence, ...value.rows[0] });
  }
  const catalog = (await client.query(`
    SELECT 'function' AS kind,n.nspname AS schema,p.proname AS name,
      pg_get_function_identity_arguments(p.oid) AS identity,pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname NOT IN ('information_schema','${controlSchema}','${backupSchema}') AND p.prokind IN ('f','p')
    UNION ALL SELECT 'constraint',n.nspname,c.relname,co.conname,
      pg_get_constraintdef(co.oid,true)||':'||co.convalidated::text
      FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      -- PG18 also catalogs NOT NULL here; PG17 represents it only on columns.
      -- Column attnotnull is compared below on both versions.
      WHERE co.contype <> 'n' AND n.nspname !~ '^pg_' AND n.nspname NOT IN ('information_schema','${controlSchema}','${backupSchema}')
    UNION ALL SELECT 'index',n.nspname,c.relname,'',pg_get_indexdef(c.oid)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind='i' AND n.nspname !~ '^pg_' AND n.nspname NOT IN ('${controlSchema}','${backupSchema}')
    UNION ALL SELECT 'trigger',n.nspname,c.relname,t.tgname,pg_get_triggerdef(t.oid,true)||':'||t.tgenabled::text
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname !~ '^pg_' AND n.nspname NOT IN ('${controlSchema}','${backupSchema}')
    UNION ALL SELECT 'view',n.nspname,c.relname,'',pg_get_viewdef(c.oid,true)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('v','m') AND n.nspname !~ '^pg_' AND n.nspname NOT IN ('information_schema','${controlSchema}','${backupSchema}')
    UNION ALL SELECT 'column',n.nspname,c.relname,a.attname,
      format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text||':'||a.attidentity::text||':'||a.attgenerated::text||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),'')
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
      AND n.nspname !~ '^pg_' AND n.nspname NOT IN ('information_schema','${controlSchema}','${backupSchema}')
  `)).rows.map(row => ["constraint","index"].includes(row.kind)
      ? {...row,definition:portableDefinition(row.definition)} : row)
    .sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"));
  const extensions = (await client.query("SELECT extname,extversion FROM pg_extension ORDER BY extname")).rows;
  return { data, sequences, catalog, extensions };
}

// Railway can pause service deployments during an outage. A database-scoped
// read-only default plus draining existing application sessions gives the final
// dump a stable write boundary without deleting or modifying business records.
export async function sourceReadOnly({sourceUrl,adminUrl,runId,restore=false,enforceHosts=false}) {
  if (!/^[a-z0-9_]{8,35}$/.test(runId ?? "")) throw fail("INVALID_RUN_ID");
  const source=new URL(sourceUrl),admin=new URL(adminUrl);
  if (enforceHosts && (source.hostname!=="centerbeam.proxy.rlwy.net" || source.port!=="29292" ||
      !admin.hostname.startsWith("dpg-dbdltoo473hc73cqrkqg-a"))) throw fail("UNEXPECTED_DATABASE_HOST");
  if(source.host===admin.host && source.pathname===admin.pathname) throw fail("SOURCE_EQUALS_TARGET");
  const manager=connection(admin);
  const controller=connection(source,true);
  controller.connectionParameters.options="-c default_transaction_read_only=off";
  let locked=false,probe;
  try {
    await manager.connect();
    locked=(await manager.query("SELECT pg_try_advisory_lock(hashtext('alraesy-source-freeze')) AS locked")).rows[0].locked;
    if(!locked) throw fail("ANOTHER_FREEZE_RUNNING");
    await manager.query(`CREATE SCHEMA IF NOT EXISTS ${quote(controlSchema)}`);
    await manager.query(`CREATE TABLE IF NOT EXISTS ${quote(controlSchema)}.source_freezes
      (run_id text PRIMARY KEY,previous_value text,frozen boolean NOT NULL DEFAULT false,
       created_at timestamptz NOT NULL DEFAULT now(),restored_at timestamptz)`);
    await controller.connect();
    let record=(await manager.query(`SELECT previous_value,frozen FROM ${quote(controlSchema)}.source_freezes WHERE run_id=$1`,[runId])).rows[0];
    if(restore && !record) throw fail("FREEZE_RECORD_MISSING");
    if(!record) {
      const settings=(await controller.query(`SELECT setconfig FROM pg_db_role_setting
        WHERE setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database()) AND setrole=0`)).rows[0]?.setconfig ?? [];
      const previous=settings.find(x=>x.startsWith("default_transaction_read_only="))?.split("=")[1] ?? null;
      await manager.query(`INSERT INTO ${quote(controlSchema)}.source_freezes(run_id,previous_value) VALUES($1,$2)`,[runId,previous]);
      record={previous_value:previous,frozen:false};
    }
    const database=(await controller.query("SELECT current_database() AS name")).rows[0].name;
    if(restore) {
      if(record.previous_value===null) await controller.query(`ALTER DATABASE ${quote(database)} RESET default_transaction_read_only`);
      else await controller.query(`ALTER DATABASE ${quote(database)} SET default_transaction_read_only TO ${literal(record.previous_value)}`);
    } else await controller.query(`ALTER DATABASE ${quote(database)} SET default_transaction_read_only TO 'on'`);
    // In-flight work rolls back; committed records are retained. Reconnecting
    // application sessions inherit the database's read-only default.
    await controller.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname=current_database() AND usename=current_user AND pid<>pg_backend_pid()
      AND backend_type='client backend'`);
    probe=connection(source,true); await probe.connect();
    const value=(await probe.query("SHOW default_transaction_read_only")).rows[0].default_transaction_read_only;
    if(!restore && value!=="on") throw fail("SOURCE_FREEZE_NOT_APPLIED");
    await manager.query(`UPDATE ${quote(controlSchema)}.source_freezes SET frozen=$2,
      restored_at=CASE WHEN $2 THEN NULL ELSE now() END WHERE run_id=$1`,[runId,!restore]);
    return {run_id:runId,source_read_only:value};
  } finally {
    await probe?.end().catch(()=>{});await controller.end().catch(()=>{});
    if(locked) await manager.query("SELECT pg_advisory_unlock(hashtext('alraesy-source-freeze'))").catch(()=>{});
    await manager.end().catch(()=>{});
  }
}

export async function discardCandidate({adminUrl,runId}) {
  if(!/^[a-z0-9_]{8,35}$/.test(runId??""))throw fail("INVALID_RUN_ID");
  const c=connection(new URL(adminUrl));await c.connect();
  try {
    const row=(await c.query(`SELECT database_name,archive_sha256,
      expected->'data'=actual->'data' AS contents_checked,
      EXISTS(SELECT 1 FROM ${quote(controlSchema)}.dump_chunks c WHERE c.run_id=r.run_id) AS has_archive
      FROM ${quote(controlSchema)}.runs r WHERE run_id=$1`,[runId])).rows[0];
    if(!row||!row.contents_checked||!row.has_archive||!row.archive_sha256||row.database_name!=="alraesy_mig_"+runId)
      throw fail("CANDIDATE_DISCARD_NOT_SAFE");
    const current=(await c.query("SELECT current_database() AS name")).rows[0].name;
    if(row.database_name===current)throw fail("CANNOT_DISCARD_CURRENT_DATABASE");
    const exists=(await c.query("SELECT datdba=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned FROM pg_database WHERE datname=$1",[row.database_name])).rows[0];
    if(exists&&!exists.owned)throw fail("UNEXPECTED_CANDIDATE_OWNER");
    if(exists)await c.query(`DROP DATABASE ${quote(row.database_name)}`);
    console.log("MIGRATION_UNUSED_CANDIDATE_REMOVED "+runId);
  } finally {await c.end();}
}

export async function stageMigration({ sourceUrl, adminUrl, runId, enforceHosts = false, toolDir = "/opt/pg18",inPlace=false }) {
  if (!/^[a-z0-9_]{8,35}$/.test(runId ?? "")) throw fail("INVALID_RUN_ID");
  const source = new URL(sourceUrl), admin = new URL(adminUrl);
  if (![source,admin].every(url => ["postgres:","postgresql:"].includes(url.protocol))) throw fail("INVALID_PROTOCOL");
  if (enforceHosts && (source.hostname !== "centerbeam.proxy.rlwy.net" || source.port !== "29292" ||
      !admin.hostname.startsWith("dpg-dbdltoo473hc73cqrkqg-a"))) throw fail("UNEXPECTED_DATABASE_HOST");
  if (source.host === admin.host && source.pathname === admin.pathname) throw fail("SOURCE_EQUALS_TARGET");
  const databaseName = inPlace ? decodeURIComponent(admin.pathname.slice(1)) : "alraesy_mig_" + runId;
  const candidate = new URL(admin); candidate.pathname = "/" + databaseName;
  const management = connection(admin), original = connection(source, true);
  let restored, directory, locked = false, recorded = false;
  try {
    await management.connect();
    locked = (await management.query("SELECT pg_try_advisory_lock(hashtext('alraesy-migration')) AS locked")).rows[0].locked;
    if (!locked) throw fail("ANOTHER_MIGRATION_RUNNING");
    await management.query(`CREATE SCHEMA IF NOT EXISTS ${quote(controlSchema)}`);
    await management.query(`CREATE TABLE IF NOT EXISTS ${quote(controlSchema)}.runs (
      run_id text PRIMARY KEY, state text NOT NULL, database_name text NOT NULL,
      summary jsonb, expected jsonb, actual jsonb, archive_sha256 text,
      error_detail text, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz)`);
    await management.query(`CREATE TABLE IF NOT EXISTS ${quote(controlSchema)}.dump_chunks (
      run_id text REFERENCES ${quote(controlSchema)}.runs(run_id),part integer, bytes bytea NOT NULL,
      PRIMARY KEY(run_id,part))`);
    const previous = (await management.query(`SELECT state,summary FROM ${quote(controlSchema)}.runs WHERE run_id=$1`,[runId])).rows[0];
    if (previous?.state === "verified") return previous.summary;
    if (previous) throw fail("RUN_ALREADY_STARTED_REVIEW_REQUIRED");
    if (!inPlace && (await management.query("SELECT 1 FROM pg_database WHERE datname=$1",[databaseName])).rowCount)
      throw fail("CANDIDATE_ALREADY_EXISTS");
    if(inPlace){
      const schemas=(await management.query(`SELECT nspname FROM pg_namespace WHERE nspname !~ '^pg_'
        AND nspname NOT IN ('information_schema','${controlSchema}') ORDER BY nspname`)).rows;
      if(schemas.length!==1||schemas[0].nspname!=="public")throw fail("REVIEW_TARGET_SCHEMAS_BEFORE_REPLACEMENT");
    }
    await management.query(`INSERT INTO ${quote(controlSchema)}.runs(run_id,state,database_name) VALUES($1,'preparing',$2)`,[runId,databaseName]);
    recorded = true;
    await original.connect();
    await beginSnapshot(original);
    if ((await original.query("SELECT 1 FROM pg_namespace WHERE nspname=ANY($1)",[[controlSchema,backupSchema]])).rowCount)
      throw fail("RESERVED_SOURCE_SCHEMA");
    const snapshot = (await original.query("SELECT pg_export_snapshot() AS snapshot")).rows[0].snapshot;
    const sourceVersion = (await original.query("SHOW server_version")).rows[0].server_version;
    const sourceBytes = BigInt((await original.query("SELECT pg_database_size(current_database())::text AS bytes")).rows[0].bytes);
    const adminBytes = BigInt((await management.query(`SELECT coalesce(sum(pg_database_size(oid)),0)::text AS bytes
      FROM pg_database WHERE datname=current_database() OR datname LIKE 'alraesy_mig_%'`)).rows[0].bytes);
    if (enforceHosts && sourceBytes * 2n + adminBytes + 134217728n > 1073741824n)
      throw fail("REVIEW_STORAGE_HEADROOM");
    directory = await mkdtemp(join(tmpdir(), "alraesy-migration-"));
    const archive = join(directory,"source.dump");
    console.log("MIGRATION_PROGRESS exporting_consistent_snapshot");
    await tool(join(toolDir,"bin/pg_dump"),["--format=custom","--compress=6","--no-owner","--no-acl",
      "--quote-all-identifiers","--snapshot="+snapshot,"--file="+archive],toolEnvironment(source,true,toolDir));
    const archiveDigest = createHash("sha256");
    let part = 0;
    for await (const bytes of createReadStream(archive,{highWaterMark:1048576})) {
      archiveDigest.update(bytes);
      await management.query(`INSERT INTO ${quote(controlSchema)}.dump_chunks(run_id,part,bytes) VALUES($1,$2,$3)`,[runId,part++,bytes]);
    }
    const archiveSha256 = archiveDigest.digest("hex");
    console.log("MIGRATION_PROGRESS fingerprinting_source");
    const expected = await fingerprint(original);
    await management.query(`UPDATE ${quote(controlSchema)}.runs SET state='restoring',expected=$2,archive_sha256=$3 WHERE run_id=$1`,[runId,JSON.stringify(expected),archiveSha256]);
    const locale = (await original.query(`SELECT pg_encoding_to_char(encoding) AS encoding,
      datcollate,datctype,datlocprovider,datlocale FROM pg_database WHERE datname=current_database()`)).rows[0];
    if (locale.encoding !== "UTF8" || locale.datlocprovider !== "c") throw fail("REVIEW_DATABASE_LOCALE");
    if(inPlace){
      const targetLocale=(await management.query(`SELECT pg_encoding_to_char(encoding) AS encoding,
        datcollate,datctype,datlocprovider FROM pg_database WHERE datname=current_database()`)).rows[0];
      for(const key of ['encoding','datcollate','datctype','datlocprovider'])
        if(targetLocale[key].toLowerCase()!==locale[key].toLowerCase())throw fail("TARGET_DATABASE_LOCALE_DIFFERS");
      console.log("MIGRATION_PROGRESS replacing_preview_schema_atomically");
      await restorePublicAtomically(archive,admin,toolDir);
    } else {
      await management.query(`CREATE DATABASE ${quote(databaseName)} TEMPLATE template0 ENCODING 'UTF8'
        LOCALE_PROVIDER libc LC_COLLATE ${literal(locale.datcollate)} LC_CTYPE ${literal(locale.datctype)}`);
      console.log("MIGRATION_PROGRESS restoring_isolated_candidate");
      await tool(join(toolDir,"bin/pg_restore"),["--no-owner","--no-acl","--exit-on-error","--single-transaction", "--dbname="+databaseName,archive],toolEnvironment(candidate,false,toolDir));
    }
    restored = connection(candidate); await restored.connect(); await beginSnapshot(restored);
    const actual = await fingerprint(restored);
    const targetVersion = (await restored.query("SHOW server_version")).rows[0].server_version;
    await restored.query("ROLLBACK");
    await management.query(`UPDATE ${quote(controlSchema)}.runs SET actual=$2 WHERE run_id=$1`,[runId,JSON.stringify(actual)]);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw fail("RESTORE_FINGERPRINT_MISMATCH");
    const table = name => expected.data.find(t => t.schema === "public" && t.name === name)?.rows ?? "0";
    const summary = { run_id:runId,database_name:databaseName,source_version:sourceVersion,target_version:targetVersion,
      source_database_bytes:sourceBytes.toString(),archive_bytes:(await stat(archive)).size.toString(),
      archive_sha256:archiveSha256,tables_verified:expected.data.length,sequences_verified:expected.sequences.length,
      schema_objects_verified:expected.catalog.length,users:table("users"),companies:table("companies"),media_assets:table("media_assets"),
      manifest_sha256:createHash("sha256").update(JSON.stringify(expected)).digest("hex"),in_place:inPlace };
    if(inPlace)await management.query(`DROP SCHEMA ${quote(backupSchema)} CASCADE`);
    await management.query(`UPDATE ${quote(controlSchema)}.runs SET state='verified',summary=$2,finished_at=now() WHERE run_id=$1`,[runId,JSON.stringify(summary)]);
    return summary;
  } catch (error) {
    if(inPlace && (await management.query("SELECT 1 FROM pg_namespace WHERE nspname=$1",[backupSchema]).catch(()=>({rowCount:0}))).rowCount){
      await management.query("BEGIN");
      try {
        await management.query("DROP SCHEMA public CASCADE");
        await management.query(`ALTER SCHEMA ${quote(backupSchema)} RENAME TO public`);
        await management.query("COMMIT");
      } catch {await management.query("ROLLBACK").catch(()=>{});}
    }
    if (recorded) await management.query(`UPDATE ${quote(controlSchema)}.runs SET state='failed',error_detail=$2,finished_at=now() WHERE run_id=$1`,
      [runId, error.privateDetail ?? error.code ?? "MIGRATION_FAILED"]).catch(()=>{});
    throw error;
  } finally {
    await original.end().catch(()=>{});
    await restored?.end().catch(()=>{});
    if (locked) await management.query("SELECT pg_advisory_unlock(hashtext('alraesy-migration'))").catch(()=>{});
    await management.end().catch(()=>{});
    if (directory) await rm(directory,{recursive:true,force:true});
  }
}
