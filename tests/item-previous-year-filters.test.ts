import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { itemOptionsPresetFiltersSchema } from "../packages/contracts/src/item-options-presets.ts";
const read=(path:string)=>readFileSync(path,"utf8");

test("frozen annual sales snapshot imports only positive legacy counts and treats absent rows as zero",()=>{
  const sql=read("apps/api/migrations/20261103_item_previous_year_sale_times_snapshot.sql");
  assert.match(sql,/CREATE TABLE IF NOT EXISTS company_item_previous_year_sale_times/);
  assert.match(sql,/PRIMARY KEY \(company_id,legacy_id\)/);
  assert.match(sql,/WHERE EXISTS \(SELECT 1 FROM companies c WHERE c.id=source.company_id\)/);
  assert.match(sql,/ON CONFLICT \(company_id,legacy_id\) DO NOTHING/);
  const pairs=sql.split("\n").filter(line=>/^\(2,'[0-9]+',[0-9]+\),?$/.test(line));
  assert.equal(pairs.length,4680);
  assert.ok(pairs.every(line=>Number(line.match(/,([0-9]+)\),?$/)?.[1])>0));
  assert.ok(pairs.includes("(2,'8252',9999),"));
  assert.ok(pairs.includes("(2,'8248',482),"));
  assert.equal(new Set(pairs.map(line=>line.split("'")[1])).size,4680);
  assert.ok(!/UPDATE items SET/i.test(sql),"historical values must not rewrite item master cards");
});

test("prior-year and reserve min max appear in query and both layouts",()=>{
  const api=read("apps/api/src/routes-item-options-list.ts");
  const ui=read("apps/web/src/pages/ItemOptionsListPage.tsx");
  for(const name of ["previousYearMin","previousYearMax","reserveMin","reserveMax"]) {
    assert.ok(api.includes(name),"server filter "+name);
    assert.ok(ui.includes(name),"visible filter "+name);
  }
  assert.match(api,/COALESCE\(previous\.sale_times,0\) AS sale_times_previous_year/);
  assert.match(api,/previous\.legacy_id=i\.legacy_id/);
  assert.match(api,/saleTimesPreviousYear: String\(row\.sale_times_previous_year\)/);
  assert.match(ui,/sortHeader\("previousYear", "مرات عام السابق"\)/);
  assert.ok(ui.includes('row.saleTimesPreviousYear'));
  assert.match(api,/reserveMin, "m\.reserve_quantity"/);
  assert.match(ui,/sortHeader\("reserve", "كمية احتياط"\)/);
});

test("existing named filters gain blank defaults instead of becoming invalid",()=>{
  const old={
    q:"", active:"active",stockMin:"",stockMax:"10",
    monthMin:"1",monthMax:"5",fourMonthsMin:"",fourMonthsMax:"",
    allTimeMin:"",allTimeMax:"",coverageMin:"",coverageMax:"",
    excludeZero:true,useReserve:true,sortBy:"allTime",sortDir:"desc",
  };
  const restored=itemOptionsPresetFiltersSchema.parse(old);
  assert.equal(restored.previousYearMin,"");
  assert.equal(restored.previousYearMax,"");
  assert.equal(restored.reserveMin,"");
  assert.equal(restored.reserveMax,"");
  const fresh=itemOptionsPresetFiltersSchema.parse({
    ...old,previousYearMin:"0",previousYearMax:"9999",reserveMin:"1",reserveMax:"10",
    sortBy:"previousYear",
  });
  assert.equal(fresh.previousYearMax,"9999");
  assert.equal(fresh.sortBy,"previousYear");
});
