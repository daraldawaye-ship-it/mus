import type { LegalDocumentReview } from "../../../../packages/contracts/src/legal-document-review.ts";

// r is the permission-filtered legal record. The old checkbox is positive
// evidence for an outstanding manual transcription, never evidence of its absence.
export const pendingManualTranscriptionSql=`(COALESCE(r.transcription_status,'unknown') NOT IN ('complete','duplicate','archived')
  AND (r.document_review->>'importanceScore' IS NOT NULL OR r.document_review->>'priority'='high')
  AND r.document_review->>'manualTranscription'='true'
  AND NULLIF(btrim(r.document_review->>'missingPassage'),'') IS NOT NULL)`;
export const automationWorkStateSql=`COALESCE(r.document_review->>'automationWorkStatus','unknown')`;
export const manualWorkStateSql=`CASE WHEN ${pendingManualTranscriptionSql} THEN 'remaining'
  ELSE COALESCE(r.document_review->>'manualWorkStatus','unknown') END`;

export function preserveDocumentWorkStatuses(prior:LegalDocumentReview|null|undefined,next:LegalDocumentReview):LegalDocumentReview{
  // Existing clients replace the review object. Omitted status fields are not a request to reset them.
  return {
    ...(prior?.automationWorkStatus!==undefined?{automationWorkStatus:prior.automationWorkStatus}:{}),
    ...(prior?.manualWorkStatus!==undefined?{manualWorkStatus:prior.manualWorkStatus}:{}),
    ...next,
  };
}
