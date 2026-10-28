# Pending invoice scope — 2026-10-28

The owner requested pausing the current invoice run, retaining **all remaining
purchases** and **only remaining sales from the last four calendar months**, then
resuming. The fixed inclusive sales cutoff is **2026-06-28** (request date 2026-10-28,
Asia/Aden). This does not remove or reverse any already posted sale or purchase.

Company2, source `dar-aldawa-legacy-2026-10`, run
`f03ead4a-40d9-4713-811c-6a366b7ec6c8` was paused through the authenticated owner API.
The paused snapshot had 53,401 completed and 1,195 failed source invoices. Of the
remaining32,615 pending invoices, 12,971 were sales before cutoff, 18,408 were sales
on/after cutoff, and 1,236 were purchases of all dates. Expected eligible remaining:
19,644. Failed invoices stay unchanged for manual repair.

Migration145 marks **only pending old sales** `excluded`, retaining every raw
source field/hash/date and both raw invoice copy tables. It records the reason,
excluded count, fixed cutoff and audit receipt, and leaves the run paused for
readback. Reapplying the migration does not exclude or count a row twice. Existing
worker selection handles only `pending`, so excluded sources cannot create journals
or stock. The owner API resumes the same run after deployment verification. The
website and all restored automatic tasks remain enabled. Historical accounting
posting of raw receipt/payment vouchers is a separate unfinished step.

## Narrower remaining-sales scope — 2026-10-28

The owner changed the remaining-sales window again to **three calendar months and
ten days**. The new fixed inclusive cutoff is **2026-07-18**. Migration146 excludes
only additional pending sales before this cutoff, leaving every pending purchase,
previously completed/failed invoice, and previously excluded source untouched. It
preserves source hashes, JSON, dates, and posted accounting/stock history; exclusions
are cumulative and idempotent. The same run is paused during deployment/readback,
then resumed through the owner API. Website and automatic tasks remain enabled.

Paused snapshot before this narrowing: 53,435 completed, 1,199 failed, 12,971 already
excluded. Additional pending old sales: 4,265. Retained pending purchases: 1,198;
retained pending sales from2026-07-18: 14,143. Expected eligible total15,341 and
cumulative excluded total17,236 at resumption. Already posted old sales are retained
because the request applies to the remaining queue only.
