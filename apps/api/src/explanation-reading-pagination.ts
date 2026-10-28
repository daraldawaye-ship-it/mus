/** Estimate rendered reading lines without loading the full node text from PostgreSQL.
 * A node may contain many wrapped lines: 50 nodes is NOT the same as 50 lines.
 * It is impossible to know exact browser wraps at API time, so use a conservative
 * line budget and load the next slice when the reader reaches its end.
 */
export type ReadingLength = {
  kind:string;
  title:string;
  body_chars:number;
  body_breaks:number;
  evidence_chars:number;
  evidence_breaks:number;
};
const CHARS_PER_LINE=65;
function wrappedLines(chars:number,breaks:number):number {
  if(chars<=0)return 0;
  // Preserve explicit line breaks while estimating variable-width Arabic text.
  return Math.max(1,Math.ceil(chars/CHARS_PER_LINE)+Math.max(0,breaks));
}
export function estimateReadingLines(record:ReadingLength):number {
  const headingLines=wrappedLines(record.title.length,0)||1;
  const textLines=wrappedLines(record.body_chars,record.body_breaks);
  const evidenceLines=wrappedLines(record.evidence_chars,record.evidence_breaks);
  // Headings require extra whitespace in the continuous reading layout.
  return headingLines+textLines+evidenceLines+(record.kind==="heading"?2:0);
}
export function takeReadingSlice<T extends {row:ReadingLength}>(
  ordered:readonly T[],offset:number,lineBudget=50,maxRecords=50,
):T[] {
  const result:T[]=[];
  let lines=0;
  for(let index=offset;index<ordered.length && result.length<maxRecords;index++){
    const record=ordered[index];
    const nextLines=estimateReadingLines(record.row);
    if(result.length>0&&lines+nextLines>lineBudget)break;
    result.push(record);
    lines+=nextLines;
    if(lines>=lineBudget)break;
  }
  return result;
}
