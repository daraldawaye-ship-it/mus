export function legalTaskState(status: string) {
  if (["verified", "done", "completed", "حُرر الحجز — 5/5 موثق", "انتهت الدفعة — الحجز محرر"].includes(status)) return "done";
  if (/^(superseded$|ملغى$|تاريخي|أرشفة|مؤجل)/.test(status)) return "inactive";
  if (status === "waiting_human") return "human";
  if (status === "waiting_source" || /^بانتظار أصل/.test(status)) return "source";
  if (status === "working" || /^(جارٍ|قيد المتابعة)/.test(status)) return "working";
  if (status === "pending" || status === "مفتوحة") return "pending";
  return "other";
}
