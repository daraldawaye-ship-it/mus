import type { PoolClient } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { audit } from "./audit.ts";

/**
 * Credit monetary clearance earnings atomically with new posted sales.
 * The staff member who saved the invoice is the beneficiary. A return never
 * reverses, reduces or changes an existing employee earning; it only queues
 * an administrative review linked to the original sale.
 */
export async function accrueInvoiceClearance(
  client: PoolClient,
  companyId: number,
  invoiceId: number,
  user: User,
): Promise<void> {
  const employee = (await client.query<{id:number;name:string}>(
    `SELECT e.id,e.name FROM employees e
       JOIN users u ON u.id=e.user_id AND NOT u.archived
       WHERE e.company_id=$1 AND e.user_id=$2 AND e.active
       FOR SHARE OF e`,
    [companyId, user.id],
  )).rows[0];

  if (employee) {
    const credits = await client.query(
      `INSERT INTO employee_clearance_earnings(
         company_id,employee_id,employee_name,invoice_id,invoice_line_id,
         item_id,item_name,document_date,currency_id,currency_code,
         commission_rate,amount,created_by)
       SELECT i.company_id,$3,$4,i.id,l.id,l.item_id,l.item_name,
         i.document_date,i.currency_id,i.currency_code,
         l.commission_rate,l.commission_amount,$5
       FROM invoice_lines l JOIN invoices i
         ON i.company_id=l.company_id AND i.id=l.invoice_id
       WHERE i.company_id=$1 AND i.id=$2 AND i.kind='sale' AND i.posted
         AND l.quantity>0 AND l.commission_amount>0
       ON CONFLICT (company_id,invoice_line_id) DO NOTHING
       RETURNING id,invoice_line_id,item_name,amount::text,currency_code,commission_rate::text`,
      [companyId, invoiceId, employee.id, employee.name, user.id],
    );
    for (const row of credits.rows)
      await audit(client, user, "clearance.earn", "clearance-earning",
        row.id, null, {
          invoiceId, invoiceLineId: row.invoice_line_id,
          employeeId: employee.id, employeeName: employee.name,
          itemName: row.item_name, amount: row.amount,
          currencyCode: row.currency_code, commissionRate: row.commission_rate,
        }, companyId);
  }

  // Do this even if the employee who accepted the return has no wallet.
  const returns = await client.query(
    `INSERT INTO employee_clearance_return_reviews(
       company_id,invoice_id,invoice_line_id,original_invoice_line_id,
       original_employee_id,item_name,document_date,currency_code,candidate_amount)
     SELECT i.company_id,i.id,l.id,l.original_line_id,
       earned.employee_id,l.item_name,i.document_date,i.currency_code,
       abs(l.commission_amount)
     FROM invoice_lines l JOIN invoices i
       ON i.company_id=l.company_id AND i.id=l.invoice_id
     LEFT JOIN employee_clearance_earnings earned
       ON earned.company_id=l.company_id AND earned.invoice_line_id=l.original_line_id
     WHERE i.company_id=$1 AND i.id=$2 AND i.kind='sale' AND i.posted
       AND l.quantity<0 AND l.original_line_id IS NOT NULL
       AND l.commission_rate>0
     ON CONFLICT (company_id,invoice_line_id) DO NOTHING
     RETURNING id,invoice_line_id,original_invoice_line_id,candidate_amount::text`,
    [companyId, invoiceId],
  );
  for (const row of returns.rows)
    await audit(client, user, "clearance.return-queue", "clearance-return",
      row.id, null, {
        returnInvoiceId: invoiceId,
        returnLineId: row.invoice_line_id,
        originalLineId: row.original_invoice_line_id,
        suggestedReviewAmount: row.candidate_amount,
        deductedFromEmployee: false,
      }, companyId);
}
