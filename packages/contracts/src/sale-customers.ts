import { z } from "zod";

export const saleCustomerNumberSchema = z.string().trim().regex(/^\d{1,30}$/, "رقم العميل يجب أن يتكون من أرقام فقط (حتى 30 رقمًا)");
export const saleCustomerInputSchema = z.object({
  customerNumber: saleCustomerNumberSchema,
  name: z.string().trim().min(1, "أدخل اسم العميل").max(240),
}).strict();
export const saleCustomerPatchSchema = saleCustomerInputSchema.extend({
  revision: z.number().int().positive(),
}).strict();
export interface SaleCustomer {
  id: number;
  companyId: number;
  customerNumber: string;
  name: string;
  revision: number;
}
