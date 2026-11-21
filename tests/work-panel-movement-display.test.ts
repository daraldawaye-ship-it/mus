import test from "node:test";
import assert from "node:assert/strict";
import { stockMovementKinds } from "../packages/contracts/src/inventory.ts";
import { signedStockMovementQuantity, workPanelMovementKindLabels, workPanelPurchaseSupplier } from "../apps/web/src/stock-movement-display.ts";

test("work-board movement labels are compact without relabeling returns or reversals as sales", () => {
  assert.deepEqual(Object.keys(workPanelMovementKindLabels).sort(), [...stockMovementKinds].sort());
  assert.equal(workPanelMovementKindLabels.sale, "مبيع");
  assert.equal(workPanelMovementKindLabels.purchase, "شراء");
  for (const kind of ["transfer_in", "transfer_out"] as const) assert.equal(workPanelMovementKindLabels[kind], "مناقلة");
  for (const kind of ["adjustment_surplus", "adjustment_shortage"] as const) assert.equal(workPanelMovementKindLabels[kind], "تسوية");
  assert.notEqual(workPanelMovementKindLabels.sales_return, workPanelMovementKindLabels.sale);
  assert.notEqual(workPanelMovementKindLabels.purchase_return, workPanelMovementKindLabels.purchase);
  assert.equal(signedStockMovementQuantity("9007199254740993"), "+9007199254740993");
  assert.equal(signedStockMovementQuantity("-15"), "-15");
});

test("work-board purchase shows only the direct posted invoice supplier", () => {
  const row = { kind: "purchase", invoiceId: 1, originalMovementId: null,
    supplierInferenceSource: null, supplierAccountName: "  المورد الفعلي  " } as const;
  assert.equal(workPanelPurchaseSupplier(row), "المورد الفعلي");
  for (const source of ["invoice", "prior_purchase", "item_estimate"] as const)
    assert.equal(workPanelPurchaseSupplier({...row, supplierInferenceSource: source}), null);
  assert.equal(workPanelPurchaseSupplier({...row, supplierAccountName: null}), null);
  assert.equal(workPanelPurchaseSupplier({...row, invoiceId: null}), null);
  assert.equal(workPanelPurchaseSupplier({...row, originalMovementId: 27}), null);
  assert.equal(workPanelPurchaseSupplier({...row, kind: "sale"}), null);
});
