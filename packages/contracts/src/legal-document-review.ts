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
  importanceScore?:number;
  hearingDate?:string;
  hearingGroup?:string;
  canonicalRecordId?:number;
  verifiedOn?:string;
};
export const documentImportanceScores = [10,9,8,7,6,5,4,3,2,1] as const;

/** The server supplies score-sorted, filtered page data. Never rerank or include a legacy score. */
export function splitStarterBatch<T extends {document_review?:LegalDocumentReview;transcription_status?:string|null}>(items:T[],firstPage:boolean) {
 if(!firstPage)return {starter:[] as T[],rest:items};
 const scored=items.filter(item=>{
  const r=item.document_review,score=r?.importanceScore;
  return score!==undefined&&Number.isInteger(score)&&score>=1&&score<=10&&r?.manualTranscription&&Boolean(r.missingPassage?.trim())&&
   !["complete","duplicate","archived"].includes(item.transcription_status??"unknown");
 });
 const starter=scored.slice(0,Math.min(5,Math.ceil(scored.length/20)));
 const picked=new Set(starter);
 return {starter,rest:items.filter(item=>!picked.has(item))};
}
