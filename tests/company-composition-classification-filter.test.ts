import type { Request } from "express";
import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { masterPage } from "../apps/api/src/services/masters.ts";
import type { Database } from "../apps/api/src/db.ts";
import { compositionClassifications } from "../packages/contracts/src/items.ts";

test("composition choices filter exact classifications and NULL before count and pagination",async()=>{
  const db=await PGlite.create();
  try{
    await db.exec(`CREATE TABLE item_compositions(company_id int,id int,name text,active bool,classification text);
      INSERT INTO item_compositions VALUES
      (1,1,'A test',true,NULL),(1,2,'B test',true,'medical_supplies'),(1,3,'C test',true,'health_supplies'),
      (1,4,'D test',false,'medicine'),(1,5,'E test',true,'medical_and_health_supplies'),
      (1,6,'Other',true,'medical_supplies'),(2,7,'Foreign test',true,NULL);`);
    const pool={query:db.query.bind(db)} as unknown as Database;
    const run=(query:Record<string,unknown>)=>masterPage(pool,{query} as Request,1,
      "SELECT f.* FROM item_compositions f","FROM item_compositions f","f",
      {id:"f.id",name:"f.name",active:"f.active",classification:"f.classification"},["f.name"],row=>row.id as number,
      {active:"boolean",classification:{values:compositionClassifications,nullValue:"unclassified",noneValue:"none"}},"id:asc");
    assert.deepEqual((await run({classification:"unclassified"})).items,[1]);
    assert.deepEqual((await run({classification:"medical_and_health_supplies"})).items,[5]);
    const options={classification:"unclassified,medical_supplies",q:"test",active:"true",sort:"name:desc",pageSize:"1"};
    const first=await run(options), second=await run({...options,page:"2"});
    assert.deepEqual([first.total,first.items,second.total,second.items],[2,[2],2,[1]]);
    const all=[...compositionClassifications,"unclassified"].join(",");
    assert.deepEqual(await run({classification:all}),await run({}));
    assert.deepEqual((await run({classification:"none"})).items,[]);
    assert.equal((await run({classification:"none"})).total,0);
    for(const classification of ["",["medicine"],"medicine,none","medicine,medicine","invented","medicine,"]) {
      await assert.rejects(run({classification}),{code:"invalid_query"});
    }
  }finally{await db.close();}
});
