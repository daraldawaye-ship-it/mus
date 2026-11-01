# Sales pledge cash transfers — 1 November 2026

## Owner instruction and existing permissions
The owner explicitly requested enabling **"إضافة إلى رهن" (pay money to an existing pledge)** and **"استلام من رهن" (receive money back)** for sales staff at Pharmacy Dar Al-Dawaa, companyId=2.

Before the change, all active sales-position employees reviewed at company 2 had `commerce.manage`, `commerce.view`, `finance.post` and `finance.view`, but not `finance.manage`. The cashier's pledge transfer buttons were disabled by a UI check for `finance.manage`, and generic `POST /financial-documents` also requires `finance.manage`. Giving all sellers that general permission would enable arbitrary financial voucher creation; **do not do that**.

## Implementation
- The user-facing actions in the Sales invoice's existing `SalesHeaderActionsDropdown` remain **"صرف مبلغ لرهن"** and **"استلام مبلغ من رهن"**. They are enabled for a sales-position employee with a linked active sales cashbox, existing commerce-create/finance-post permissions and an unlocked invoice; managers keep the existing capabilities.
- A salesperson without `finance.manage` calls the **restricted** `POST /api/companies/:companyId/pledges/:accountId/transfer` endpoint with `{idempotencyKey,mode:"pay"|"receive",amount,notes}`. No generic finance-management permission or generalized voucher create grant is issued.
- The endpoint validates `commerce.manage` AND `finance.post`, a current active employee with the `sales` position (or company general manager), the **user's own** `employee_account_links.account_kind='sales_cash'` account, an active pledged account in `account_pledges`, active YER currency, positive amount, current Aden business date, balanced debit and credit sides, and existing financial validation/limits. An employee cannot choose a different cashbox.
- A single PostgreSQL transaction uses the existing `insertDraft`, `postDraft`, `checkDocumentReferences`, and date/currency checks. Any posting failure rolls back the draft and entries together. `findIdempotent` uses a stable logical operation payload, so a retry of the same key cannot duplicate a posted movement or silently change the amount or pledge. The result includes the standard posted financial document for the receipt link. Normal financial audit events are written for create/post.
- `requestPermissionTargets` maps this restricted endpoint to Sales view and the relevant receipt/payment POST permission rules; explicit denials on those pages still apply. Direct generic finance routes and other cashboxes remain unchanged.
- The old generic draft/post flow remains in `PledgeDialogs` for managers with `finance.manage`. Creation of a **new** pledge and full pledge-list management stay under existing privileges.

Files: `apps/api/src/routes-pledges.ts`, `apps/api/src/services/permission-rules.ts`, `apps/web/src/pages/CommercePages.tsx`, `apps/web/src/PledgeDialogs.tsx`. Deployed source commit: `4d383b0f2d31b58be9d8621e2bcfbe2a620bab7e`. Render deploy: `dep-dbjn6tflk1mc739osid0` reported `live` on 2026-11-01. The Docker build runs `npm run check && npm run build`, so TypeScript and Vite validation passed. **No live cash voucher was created during testing**: testing a real POST should use an explicitly authorized, supervised test account/transaction, not a made-up financial transfer.

## Regression acceptance checks
1. Sales employee with own active sales cashbox sees both buttons enabled and can browse eligible pledges; an employee without it must not access them.
2. A cash movement credits the employee's linked cash account and debits the pledge for pay, reverse for receive. The posting is atomic, logged, and exactly once on retry.
3. Company isolation, account ownership, inactive or non-pledge accounts, disabled company page grants, invalid or negative amounts all fail without posting.
4. Regular sales invoice editing and posting, normal financial voucher creation privileges, and managers' existing pledge operations remain unchanged.
