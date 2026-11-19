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
export type LegalDocumentReview = {
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
  hearingDate?:string;
  hearingGroup?:string;
  canonicalRecordId?:number;
  verifiedOn?:string;
};
