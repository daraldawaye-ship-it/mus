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


## Sales deferred, purchases-only manual completion — 2026-10-28

The owner explicitly stopped the general run and requested extracting remaining
purchases only, deferring remaining sales into a separate file until further
instruction. Then the owner explicitly authorized posting the purchases only.
The general run remains **paused**. Do not resume sales without a NEW explicit request.
The website and unrelated restored automatic tasks remain enabled.

At pause (`2026-10-28T20:24:45.852Z`) there were41 pending purchases and1,807 pending
sales. Full source exports were saved privately outside Git, with original hashes
verified for all1,848 documents. Purchases had475 lines; deferred sales had6,156.
Using the existing owner transaction-import API (not the general worker),38 purchases
posted successfully in5 original-date batches. Three invalid whole purchase documents
were retained for manual correction; quantities were never rounded. Three documents
used the already authorized half-up unit-price policy, with original values retained.
The owner stage-ack API marked38 completed and3 failed. No sales were submitted.

Verified production source status afterward:66,006 completed,2,162 failed,17,236
previously excluded sales,1,807 pending sales, **zero pending purchases**, total87,211.
The general run still reports paused. Its per-worker imported/failed counters exclude
these38/3 manually processed purchases; read actual staging status for overall totals.
Do not derive overall pending/completed totals solely from those old run counters.

Private output directory: `/workspace/outputs/paused-invoices-2026-10-28/`.
`purchases-only.zip` includes the original41-source snapshot, Excel review and posting
results. `deferred-sales.zip` includes all1,807 deferred sales in JSON/Excel, with exact
raw source preservation and manifest checksums. Financial payloads stay out of Git.


## CURRENT: explicit owner resumption of deferred sales — 2026-10-29 (Asia/Aden)

The owner now explicitly authorized continuing the deferred October sales.
The existing owner API action resumed the same run from paused to running; no new
source data was loaded, no excluded old sale was restored, and failed documents
remain for manual correction. Baseline deferred/pending sales:1,807; pending
purchases:0. The previously posted38 manual purchases and3 manually failed purchases
remain outside the per-worker counters, so overall totals must still come from staging.
Worker baseline at resumption:imported65,912, existing5, failed2,159, excluded17,236.
The original source identities, cutoff2026-07-18, deduplication, website access and
restored automatic tasks remain intact. Prior sales hold is superseded by this
explicit resumption. Receipt/payment voucher posting remains a separate unfinished step.
