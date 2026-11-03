import assert from "node:assert/strict";
import test from "node:test";
import type { ColumnDef } from "@tanstack/react-table";
import { actionColumnsFirst, arrangeInvoiceListColumns } from "../apps/web/src/table-column-order.ts";

type Row = { id: number; name: string };
const col = (id: string, header?: string): ColumnDef<Row, unknown> => ({ id, header: header ?? id });

test("row buttons precede records in item/account/finance/invoice lists", () => {
  for (const action of ["actions", "open", "links"]) {
    const input = [col("name"), col("id"), col(action), col("date")];
    assert.deepEqual(actionColumnsFirst(input).map((x) => x.id),
      [action, "name", "id", "date"]);
    assert.deepEqual(input.map((x) => x.id), ["name", "id", action, "date"]);
  }
});

test("public-user edit is an action but page-permission edit is not", () => {
  const users = [col("name"), col("edit", "الإجراءات"), col("id")];
  assert.deepEqual(actionColumnsFirst(users).map((x) => x.id), ["edit", "name", "id"]);
  const permissions = [col("name"), col("edit", "تعديل"), col("links", "الرابط")];
  assert.deepEqual(actionColumnsFirst(permissions).map((x) => x.id), ["links", "name", "edit"]);
});

test("lists lacking row actions or already ordered keep their identity", () => {
  const plain = [col("name"), col("date")];
  assert.equal(actionColumnsFirst(plain), plain);
  const leading = [col("actions"), col("name"), col("id")];
  assert.equal(actionColumnsFirst(leading), leading);
});

test("sales invoice list starts with opening, printing, net, account and date", () => {
  const input: ColumnDef<Row, unknown>[] = [
    {accessorKey:"number",header:"رقم الفاتورة"},
    {accessorKey:"documentDate",header:"التاريخ"},
    col("return","العملية"),
    {accessorKey:"counterpartyAccountName",header:"الحساب"},
    col("saleCustomer","العميل"),
    {accessorKey:"currencyCode",header:"العملة"},
    {accessorKey:"total",header:"الصافي"},
    col("print","طباعة"), col("open","فتح"),
    {accessorKey:"description",header:"الملاحظات"},
  ];
  const key=(c:ColumnDef<Row,unknown>): string =>
    "id" in c && typeof c.id==="string" ? c.id :
      "accessorKey" in c ? String(c.accessorKey) : "";
  const wanted=["open","print","total","counterpartyAccountName","saleCustomer","documentDate","number","description"];
  assert.deepEqual(arrangeInvoiceListColumns("sale",input).map(key),wanted);
  assert.deepEqual(actionColumnsFirst(arrangeInvoiceListColumns("sale",input)).map(key),wanted);
  assert.equal(arrangeInvoiceListColumns("purchase",input),input);
});
