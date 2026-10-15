import { z } from "zod";
const id=z.number().int().positive().max(2147483647);
export const customerOrderSchema=z.object({
  idempotencyKey:z.uuid(),
  counterpartyAccountId:id,
  branchId:id,
  locationId:id,
  reservationIds:z.array(id).min(1).max(100).refine(xs=>new Set(xs).size===xs.length,
    "لا يمكن إضافة الحجز نفسه مرتين"),
  description:z.string().trim().max(1000).default(""),
}).strict();
export const customerOrderCancelSchema=z.object({
  idempotencyKey:z.uuid(),reason:z.string().trim().min(1).max(1000),
}).strict();
export type CustomerOrderInput=z.input<typeof customerOrderSchema>;
export interface CustomerOrderLine {
  id:number;reservationId:number;itemId:number;
  itemName:string;unit:1|2|3;unitName:string;
  quantity:string;smallestQuantity:string;expiryDate:string|null;
}
export interface CustomerOrder {
  id:number;companyId:number;number:string;
  counterpartyAccountId:number;counterpartyAccountName:string;
  branchId:number;locationId:number;locationName:string;
  status:"open"|"fulfilled"|"cancelled";
  description:string;createdAt:string;createdBy:number;
  fulfilledInvoiceId:number|null;cancelReason:string|null;
  lines:CustomerOrderLine[];
}
