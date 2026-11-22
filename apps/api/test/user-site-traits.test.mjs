import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";

const migration = await readFile(new URL("../migrations/20261122_zz_user_site_traits.sql", import.meta.url), "utf8");
const routes = await readFile(new URL("../src/routes-public.ts", import.meta.url), "utf8");
test("existing and newly created users receive member only; this is isolated from legacy roles", async () => {
  const db = new PGlite();
  try {
    await db.exec("CREATE TABLE users(id integer PRIMARY KEY, role text NOT NULL); INSERT INTO users VALUES (1, 'admin'),(2,'supervisor');");
    await db.exec(migration);
    await db.exec("INSERT INTO users VALUES(3,'member');");
    assert.deepEqual((await db.query("SELECT user_id,traits,revision FROM user_site_traits ORDER BY user_id")).rows,[
      {user_id:1,traits:["member"],revision:1},{user_id:2,traits:["member"],revision:1},{user_id:3,traits:["member"],revision:1},
    ]);
    await assert.rejects(db.query("UPDATE user_site_traits SET traits=ARRAY['owner'] WHERE user_id=1"), {code:"23514"});
    await assert.rejects(db.query("UPDATE user_site_traits SET traits=ARRAY[NULL]::text[] WHERE user_id=1"), {code:"23514"});
    const sql="UPDATE user_site_traits SET traits=$1, revision=revision+1,updated_by=$2 WHERE user_id=$3 AND revision=$4 RETURNING traits,revision";
    const changed=await db.query(sql,[["member","child"],1,2,1]);
    assert.deepEqual(changed.rows,[{traits:["member","child"],revision:2}]);
    assert.deepEqual((await db.query(sql,[["approved"],1,2,1])).rows,[]);
    assert.deepEqual((await db.query(sql,[[],1,2,2])).rows,[{traits:[],revision:3}]);
    assert.deepEqual((await db.query("SELECT role FROM users WHERE id=2")).rows,[{role:"supervisor"}]);
  } finally { await db.close(); }
});
test("production route source applies gates before reads/writes and discloses no extra fields", () => {
  const block=routes.slice(routes.indexOf("async function assertSiteTraitsAccess"),routes.indexOf("// Owner-issued one-hour"));
  assert.match(block,/currentActor\(db, sessionUser, action === "edit"\)[\s\S]*ownerOnly\(current\)[\s\S]*public\.users[\s\S]*assertDirectoryAccess\(entry, "view"\)[\s\S]*assertDirectoryAccess\(entry, "edit"\)/);
  assert.match(block,/assertSiteTraitsAccess\(client, actor\(req\), "view"\)[\s\S]*SELECT traits, revision FROM user_site_traits WHERE user_id=\$1/);
  assert.match(block,/assertSiteTraitsAccess\(client, actor\(req\), "edit"\)[\s\S]*UPDATE user_site_traits[\s\S]*WHERE user_id=\$3 AND revision=\$4[\s\S]*RETURNING traits, revision/);
  assert.equal((block.match(/private, no-store/g)??[]).length,2);
  assert.doesNotMatch(block,/audit\(|userDTO\(|UPDATE users/);
});
