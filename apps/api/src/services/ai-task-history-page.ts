export const aiTaskHistoryPageSize=10;
type Receipt = {
  id:number; startedAt:string|null; finishedAt:string|null;
  durationSeconds?:number|null; recordedAt:string; historicalReceipt?:boolean; archiveReceipt?:boolean;
};
export function isAiTaskJournalArchive(category:unknown,title:string) {
  // A stored copy is not an execution. Do not mistake general historical prose for the archive category.
  const categoryLabel=String(category??"").trim();
  return /^(?:أرشيف|ارشيف|archive)(?=$|[\s:—–-])/iu.test(categoryLabel)
    || /^(?:حفظ حرفي لسجل المهمة|أرشيف تاريخ مهمة|ارشيف تاريخ مهمة)(?=$|[\s:—–-])/u.test(title.trim());
}
export function isHistoricalAiTaskReceipt(category:unknown,title:string) {
  const archive=/(?:^(?:ملحق|أرشيف|ارشيف|أرشفة|مؤرشف|محفوظات|تجميع|archive\b)|(?:تاريخي|تاريخية|غير تشغيلي))/iu;
  return archive.test(String(category??"").trim()) || archive.test(title.trim());
}
export function pageAiTaskHistory<T extends Receipt>(runs:T[],view:"recent"|"older",page:number,activeStart:string|null) {
  // Newest actual finishes first; creation timestamps on imports cannot outrank them.
  const active=activeStart ? runs.filter(x=>!x.archiveReceipt&&!x.historicalReceipt&&!x.finishedAt&&x.startedAt===activeStart)
    .sort((a,b)=>b.id-a.id)[0] : undefined;
  const verified=runs.filter(x=>!x.archiveReceipt&&!x.historicalReceipt&&x.finishedAt&&x.startedAt&&typeof x.durationSeconds==="number")
    .sort((a,b)=>b.finishedAt!.localeCompare(a.finishedAt!)||b.id-a.id);
  const recent=[...(active?[active]:[]),...verified.slice(0,aiTaskHistoryPageSize-(active?1:0))];
  const recentIds=new Set(recent.map(x=>x.id));
  const older=runs.filter(x=>!recentIds.has(x.id)).sort((a,b)=>{
    const ta=a.archiveReceipt||a.historicalReceipt||a.durationSeconds==null?a.recordedAt:a.finishedAt??a.recordedAt;
    const tb=b.archiveReceipt||b.historicalReceipt||b.durationSeconds==null?b.recordedAt:b.finishedAt??b.recordedAt;
    return tb.localeCompare(ta)||b.id-a.id;
  });
  const selected=view==="recent"?recent:older.slice((page-1)*aiTaskHistoryPageSize,page*aiTaskHistoryPageSize);
  return {history:selected.map(({historicalReceipt,archiveReceipt,...run})=>({...run,historical:!!archiveReceipt || !!historicalReceipt || run.durationSeconds==null && !!run.finishedAt})),
    olderCount:older.length,page,pageSize:aiTaskHistoryPageSize,
    hasMore:view==="recent"?older.length>0:older.length>page*aiTaskHistoryPageSize};
}
