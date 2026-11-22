import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";

test("existing legacy options are imported once without replacing traits or changing roles", async () => {
 const db=new PGlite();
 try {
  const migration = async name => db.exec(await readFile(new URL("../migrations/"+name+".sql",import.meta.url),"utf8"));
  await db.exec(`CREATE TABLE users(id integer PRIMARY KEY, kind text NOT NULL, editor boolean DEFAULT false, monitor boolean DEFAULT false);
   INSERT INTO users VALUES (1,'admin',false,true),(2,'supervisor',true,true),(3,'member',false,false),(4,'admin',false,false);`);
  await migration("20261122_zz_user_site_traits");
  await db.exec(`UPDATE user_site_traits SET traits=ARRAY['member','personallyKnown','editor'] WHERE user_id=2;
    UPDATE user_site_traits SET traits=ARRAY['admin1','member'] WHERE user_id=4;`);
  await migration("20261122_zzz_user_site_traits_legacy_backfill");
  const get = async () => (await db.query("SELECT user_id,traits,revision FROM user_site_traits ORDER BY user_id")).rows;
  assert.deepEqual(await get(),[
    {user_id:1,traits:["member","admin1","monitor"],revision:2},
    {user_id:2,traits:["member","personallyKnown","editor","marketSupervisor","monitor"],revision:2},
    {user_id:3,traits:["member"],revision:1},
    {user_id:4,traits:["admin1","member"],revision:1},
  ]);
  assert.equal((await db.query("UPDATE user_site_traits SET traits=ARRAY['approved'] WHERE user_id=2 AND revision=1 RETURNING user_id")).rows.length,0);
  await db.exec("UPDATE users SET editor=true WHERE id=3; INSERT INTO users VALUES (5,'admin',true,true);");
  assert.deepEqual((await get()).slice(2),[
    {user_id:3,traits:["member"],revision:1},{user_id:4,traits:["admin1","member"],revision:1},{user_id:5,traits:["member"],revision:1},
  ]);
  assert.deepEqual((await db.query("SELECT kind,editor,monitor FROM users WHERE id=2")).rows,[{kind:"supervisor",editor:true,monitor:true}]);
  await assert.rejects(db.query("UPDATE user_site_traits SET traits=ARRAY['admin2'] WHERE user_id=1"),{code:"23514"});
 } finally { await db.close(); }
});
