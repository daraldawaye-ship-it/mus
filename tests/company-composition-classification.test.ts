import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  itemCompositionSchema,itemCompositionPatchSchema,compositionClassificationLabels,
} from "../packages/contracts/src/items.ts";
import { itemCompositionDTO } from "../apps/api/src/repositories/items.ts";

const base={arabicName:"Composition",englishName:"Composition"};
test("company composition accepts only explicit optional single choices and clear",()=>{
  const legacy=itemCompositionSchema.parse({...base,idempotencyKey:"8e10c861-6675-4e02-aa4b-376f54f3445f"});
  assert.equal(Object.hasOwn(legacy,"classification"),false,"old idempotent payload remains unchanged");
  const patch={...base,revision:1};
  assert.equal(Object.hasOwn(itemCompositionPatchSchema.parse(patch),"classification"),false);
  assert.equal(itemCompositionPatchSchema.parse({...patch,classification:null}).classification,null);
  assert.deepEqual(Object.values(compositionClassificationLabels),["مستلزمات طبية","مستلزمات صحية","دواء"]);
  for(const classification of Object.keys(compositionClassificationLabels))
    assert.equal(itemCompositionPatchSchema.parse({...patch,classification}).classification,classification);
  for(const classification of ["","unknown",["medicine","medical_supplies"]])
    assert.equal(itemCompositionPatchSchema.safeParse({...patch,classification}).success,false);
});

test("company composition migration preserves old blank, supports explicit clear, and rejects storage outside enum",async()=>{
  const db=await PGlite.create();
  try {
    await db.exec(`CREATE TABLE item_compositions(id int DEFAULT 2,company_id int,arabic_name text,english_name text,
      description text,sale_notes text,product_form text,active bool,identical_alternative bool,non_interchangeable bool,
      price_split_threshold numeric,original_item_id int,created_by int,idempotency_key uuid,creation_payload jsonb,revision int,created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),PRIMARY KEY(company_id,id));
      INSERT INTO item_compositions(id,company_id,arabic_name,english_name,revision)
      VALUES(1,1,'Composition','Composition',1),(1,2,'Other company','Other',1);`);
    const migration=new URL("../apps/api/migrations/20261121_zzzzz_company_composition_classification.sql",import.meta.url);
    await db.exec(await readFile(migration,"utf8"));
    const routes=await readFile(new URL("../apps/api/src/routes-items.ts",import.meta.url),"utf8");
    const sql=routes.match(/UPDATE item_compositions\s+SET arabic_name=.*?WHERE company_id=\$11 AND id=\$12/s)?.[0];
    assert.ok(sql,"run actual composition PATCH SQL");
    const insert=routes.match(/INSERT INTO item_compositions\s+\(company_id,arabic_name,english_name,description,sale_notes,product_form,active,[^)]*creation_payload,classification\)\s+VALUES\([^)]*\) RETURNING id/)?.[0];
    assert.ok(insert,"run actual composition POST SQL");
    const input=itemCompositionSchema.parse({...base,idempotencyKey:"8e10c861-6675-4e02-aa4b-376f54f3445f",classification:"health_supplies"});
    const newRow=await db.query<{id:number}>(insert,[1,input.arabicName,input.englishName,input.description,input.saleNotes,
      input.productForm,input.active,input.identicalAlternative,input.nonInterchangeable,input.priceSplitThreshold,1,
      input.idempotencyKey,JSON.stringify(input),input.classification??null]);
    assert.equal(newRow.rows[0]?.id,2);
    assert.equal((await db.query<{classification:string}>("SELECT classification FROM item_compositions WHERE id=2")).rows[0]?.classification,"health_supplies");
    const read=async(companyId:number)=>itemCompositionDTO((await db.query<Record<string,unknown>>(
      "SELECT * FROM item_compositions WHERE company_id=$1 AND id=1",[companyId])).rows[0]!);
    async function patch(classification?: unknown) {
      const before=await read(1);
      const input=itemCompositionPatchSchema.parse({...base,revision:before.revision,
        ...(classification!==undefined?{classification}:{})});
      await db.query(sql!,[input.arabicName,input.englishName,input.description,input.saleNotes,input.productForm,input.active,
        input.identicalAlternative,input.nonInterchangeable,input.priceSplitThreshold,input.originalItemId,1,1,
        input.classification===undefined?before.classification:input.classification]);
      return read(1);
    }
    assert.equal((await read(1)).classification,null);
    assert.equal((await patch("medical_supplies")).classification,"medical_supplies");
    assert.equal((await patch()).classification,"medical_supplies");
    assert.equal((await patch(null)).classification,null);
    assert.equal((await read(2)).classification,null);
    await assert.rejects(db.exec("UPDATE item_compositions SET classification='wrong' WHERE company_id=1"),{code:"23514"});
  }finally{await db.close();}
});
