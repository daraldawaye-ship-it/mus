import type { PoolClient } from "pg";
import type {
  WalletEntry, WalletTaskAggregate, WalletTaskDetail,
  WalletTaskPostingStatus, WalletTaskReport,
} from "../../../../packages/contracts/src/wallet.ts";
import { walletEntryDTO, walletEntryQuery } from "./wallet.ts";

/**
 * Employee wallet points are pooled, so conversions do not reference
 * individual awards. Attribute conversions to the oldest still-available
 * credits first (FIFO). This is a reporting allocation, not a journal entry.
 * Other debits and reversals reduce available credits but never become
 * additional earned tasks or additional postings.
 */
type Grant = {
  entry: WalletEntry;
  available: bigint;
  posted: bigint;
};
const adenDay = (iso: string): string => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Aden", day: "2-digit", month: "2-digit", year: "numeric",
  }).formatToParts(new Date(iso));
  const lookup = (kind: string) => parts.find((part) => part.type === kind)?.value ?? "";
  return `${lookup("year")}-${lookup("month")}-${lookup("day")}`;
};
const labels: Record<string, string> = {
  attendance: "مكافأة الحضور والدوام",
  clearance: "عمولة التصريف",
  manual: "إضافة نقاط إدارية",
  automatic: "مكافأة آلية",
};
function entryKey(entry: WalletEntry): string {
  return entry.kind === "automatic" && entry.taskCode
    ? `task:${entry.taskCode}`
    : `kind:${entry.kind}`;
}
function consume(grants: Grant[], amount: bigint, posted: boolean, preferredId: number | null) {
  let remaining = amount;
  const use = (grant: Grant) => {
    if (remaining <= 0n || grant.available <= 0n) return;
    const moved = grant.available < remaining ? grant.available : remaining;
    grant.available -= moved;
    if (posted) grant.posted += moved;
    remaining -= moved;
  };
  if (preferredId !== null && !posted) {
    const target = grants.find((item) => item.entry.id === preferredId);
    if (target) use(target);
  }
  for (const grant of grants) {
    if (!remaining) break;
    use(grant);
  }
}
export async function walletTaskReport(
  client: PoolClient,
  companyId: number,
  employeeId: number,
  fromDate: string,
  toDate: string,
  posting: WalletTaskPostingStatus,
  selectedTask: string | null,
  page: number,
  pageSize: number,
): Promise<WalletTaskReport> {
  const [ledger, definitions] = await Promise.all([
    client.query(
      walletEntryQuery +
        " WHERE l.company_id=$1 AND l.employee_id=$2 ORDER BY l.created_at ASC,l.id ASC",
      [companyId, employeeId],
    ),
    client.query("SELECT code,name FROM reward_task_definitions"),
  ]);
  const taskNames = new Map<string, string>(
    definitions.rows.map((row) => [String(row.code), String(row.name)]),
  );
  const grants: Grant[] = [];
  for (const raw of ledger.rows) {
    const entry = walletEntryDTO(raw);
    const points = BigInt(entry.points);
    if (points > 0n) {
      grants.push({ entry, available: points, posted: 0n });
    } else if (points < 0n) {
      consume(
        grants, -points, entry.kind === "conversion",
        entry.kind === "reversal" ? entry.referenceId : null,
      );
    }
  }
  const grouped = new Map<string, { name: string; points: bigint; count: number }>();
  const details: WalletTaskDetail[] = [];
  for (const grant of grants) {
    const { entry } = grant;
    const day = adenDay(entry.createdAt);
    if (day < fromDate || day > toDate) continue;
    const amount = posting === "posted"
      ? grant.posted
      : posting === "unposted"
        ? grant.available
        : grant.posted + grant.available;
    if (amount <= 0n) continue;
    const key = entryKey(entry);
    const name = entry.taskCode && entry.kind === "automatic"
      ? taskNames.get(entry.taskCode) ?? entry.taskCode
      : labels[entry.kind] ?? "مكافأة أخرى";
    const group = grouped.get(key) ?? { name, points: 0n, count: 0 };
    group.points += amount;
    group.count++;
    grouped.set(key, group);
    if (selectedTask === key) {
      const status = grant.posted > 0n && grant.available > 0n
        ? "mixed" as const
        : grant.posted > 0n ? "posted" as const : "unposted" as const;
      details.push({ entry, countedPoints: amount.toString(), status });
    }
  }
  const tasks: WalletTaskAggregate[] = Array.from(grouped, ([key, group]) => ({
    key, name: group.name, count: group.count, points: group.points.toString(),
  }));
  tasks.sort((a, b) => {
    const delta = BigInt(b.points) - BigInt(a.points);
    if (delta > 0n) return 1;
    if (delta < 0n) return -1;
    return a.name.localeCompare(b.name, "ar");
  });
  details.sort((a, b) =>
    b.entry.createdAt.localeCompare(a.entry.createdAt) || b.entry.id - a.entry.id,
  );
  return {
    tasks,
    totalPoints: tasks.reduce((sum, row) => sum + BigInt(row.points), 0n).toString(),
    totalCount: tasks.reduce((sum, row) => sum + row.count, 0),
    details: details.slice((page - 1) * pageSize, page * pageSize),
    detailTotal: details.length,
    detailPage: page,
    detailPageSize: pageSize,
  };
}
