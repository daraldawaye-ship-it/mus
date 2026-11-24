export const documentPriorities = ["high","medium","low"] as const;
export type DocumentPriority = typeof documentPriorities[number];
export const documentPriorityLabels:Record<DocumentPriority,string> = {high:"عالية",medium:"متوسطة",low:"منخفضة"};
export const documentImageStates = ["internal","canonical","external","unverified"] as const;
export type DocumentImageState = typeof documentImageStates[number];
export const documentImageLabels:Record<DocumentImageState,string> = {
  internal:"محفوظة في هذا السجل",
  canonical:"محفوظة في سجل الأصل",
  external:"المصدر الخارجي فقط",
  unverified:"غير متحققة",
};
export const documentAutomationWorkStatuses=["unknown","remaining","completed"] as const;
export const documentManualWorkStatuses=["unknown","remaining","none"] as const;
export type DocumentAutomationWorkStatus=typeof documentAutomationWorkStatuses[number];
export type DocumentManualWorkStatus=typeof documentManualWorkStatuses[number];
export const documentAutomationWorkLabels:Record<DocumentAutomationWorkStatus,string>={
  unknown:"حالة المهام الآلية غير محددة",remaining:"متبقي مهام آلية",completed:"تمت المهام الآلية",
};
export const documentManualWorkLabels:Record<DocumentManualWorkStatus,string>={
  unknown:"حالة المهام اليدوية غير محددة",remaining:"متبقي مهام يدوية",none:"لا توجد مهام يدوية",
};
export function hasPendingManualTranscription(review:LegalDocumentReview|undefined,status:string|null) {
  return !["complete","duplicate","archived"].includes(status??"unknown") &&
    !!review?.manualTranscription && !!review.missingPassage?.trim() &&
    (review.importanceScore!=null || review.priority==="high");
}
export function documentWorkStatuses(review:LegalDocumentReview|undefined,transcriptionStatus:string|null) {
  return {
    automation:review?.automationWorkStatus??"unknown",
    manual:hasPendingManualTranscription(review,transcriptionStatus)?"remaining" as const:review?.manualWorkStatus??"unknown",
  };
}
export type LegalDocumentReview = {
  automationWorkStatus?:DocumentAutomationWorkStatus;
  manualWorkStatus?:DocumentManualWorkStatus;
  documentTitle?:string;
  sourceFilename?:string;
  sourcePage?:number;
  sourceUrl?:string;
  keywords?:string[];
  evidenceSummary?:string;
  missingPassage?:string;
  nextAction?:string;
  priority?:DocumentPriority;
  manualTranscription?:boolean;
  importanceScore?:number;
  hearingDate?:string;
  hearingGroup?:string;
  canonicalRecordId?:number;
  verifiedOn?:string;
};
export const documentImportanceScores = [10,9,8,7,6,5,4,3,2,1] as const;
