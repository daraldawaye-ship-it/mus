export const transcriptionStates = ["deferred","partial","covered","complete","duplicate","unknown","archived"] as const;
export type TranscriptionState = typeof transcriptionStates[number];
export const transcriptionLabels: Record<TranscriptionState,string> = {
  deferred:"مؤجل بحسب الفهرس", partial:"محتوى محفوظ جزئيا", covered:"جميع الصفحات مسجلة؛ تحتاج تدقيق", complete:"مفرغ بالكامل",
  duplicate:"مكرر؛ المحتوى في الأصل", unknown:"يحتاج تحديد حالة التفريغ", archived:"محذوف من الفهرس النشط",
};
export type TranscriptionSummary = {counts:Record<TranscriptionState,number>;remaining:number;active:number;total:number};
