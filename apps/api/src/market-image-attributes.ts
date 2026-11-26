// Compare the commercial name, explicit strength, and presentation separately.
// Any unmatched descriptor is retained in the commercial key; nothing guesses strength.
const forms:Record<string,string>={
 "اقراص":"tablet","قرص":"tablet","حبوب":"tablet","حبه":"tablet","tablets":"tablet","tablet":"tablet","tab":"tablet","tabs":"tablet",
 "كبسول":"capsule","كبسولات":"capsule","كبسوله":"capsule","cap":"capsule","caps":"capsule","capsule":"capsule","capsules":"capsule",
 "شراب":"syrup","syrup":"syrup","معلق":"suspension","susp":"suspension","suspension":"suspension",
 "مرهم":"ointment","ointment":"ointment","كريم":"cream","cream":"cream","جل":"gel","gel":"gel",
 "قطره":"drops","drops":"drops","drop":"drops","بخاخ":"spray","spray":"spray",
 "فيال":"vial","vial":"vial","امبول":"ampoule","امبوله":"ampoule","امبولات":"ampoule","amp":"ampoule","ampoule":"ampoule",
 "حقنه":"injection","حقن":"injection","injection":"injection","inj":"injection",
 "محلول":"solution","solution":"solution","sol":"solution","تحميله":"suppository","تحاميل":"suppository","suppository":"suppository",
 "كيس":"sachet","اكياس":"sachet","sachet":"sachet","sachets":"sachet",
};
const units:Record<string,readonly [string,number]> = {
 "مجم":["mass",1000],"ملجم":["mass",1000],"ملج":["mass",1000],"ملغ":["mass",1000],"مغ":["mass",1000],"مليجرام":["mass",1000],"مليغرام":["mass",1000],"mg":["mass",1000],
 "جم":["mass",1000000],"غم":["mass",1000000],"غ":["mass",1000000],"جرام":["mass",1000000],"غرام":["mass",1000000],"g":["mass",1000000],"gm":["mass",1000000],
 "ميكروغرام":["mass",1],"مكجم":["mass",1],"ميكروجرام":["mass",1],"mcg":["mass",1],"ug":["mass",1],"µg":["mass",1],"μg":["mass",1],
 "مل":["volume",1000],"مليلتر":["volume",1000],"ml":["volume",1000],
 "٪":["percent",1],"%":["percent",1],"iu":["iu",1],"وحدهدوليه":["iu",1],"وحده":["unit",1],
};
const extraForms:Record<string,string> = {
 "اقرص":"tablet","كبسويلات":"capsule","كبسله":"capsule","امبولز":"ampoule",
 "vials":"vial","ampoules":"ampoule","injections":"injection","suppositories":"suppository",
 "supp":"suppository","syr":"syrup","oint":"ointment",
};
const extraUnits:Record<string,readonly [string,number]> = {
 "ملىجرام":["mass",1000],"مليغرم":["mass",1000],"مغـ":["mass",1000],
 "ملليجرام":["mass",1000],"مليجرم":["mass",1000],"ملجرام":["mass",1000],
 "ملليلتر":["volume",1000],"مللتر":["volume",1000],
 "مليليتر":["volume",1000],"mls":["volume",1000],"مكغ":["mass",1],
};
const numeral = /^\d+(?:\.\d+)?$/u;
const numberKey = (n:number)=>String(Number(n.toPrecision(12)));
export function imageClinicalAttributes(raw:unknown, deeper=false){
 if(typeof raw!=="string"||/[?؟~]/.test(raw))return;
 let normalized=raw.normalize("NFC").toLowerCase()
  .replace(/[\u064b-\u065f\u0670\u0640]/g,"").replace(/[أإآٱ]/g,"ا").replace(/ى/g,"ي").replace(/ة/g,"ه")
  .replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-0x660)).replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-0x6f0))
  .replace(/٫/g,".").replace(/[／⁄]/g,"/").replace(/٪/g,"%").replace(/[×*]/g,"x")
  .replace(/\b(?:i[.]?u[.]?)\b/gi,"iu").replace(/وحده\s+دوليه/g,"وحدهدوليه")
  .replace(/(?<=\p{L})[‐‑–-](?=\p{L})/gu," ")
  .replace(/(?:^|\s)[‐‑–-](?=\s|$)/gu," ").replace(/[()\[\]]/g," ");
 if(deeper) normalized=normalized
  .replace(/(?<=\p{L})[’'ʼ](?=\p{L})/gu,"")
  .replace(/(?:\beye\s+drops?\b|قطره\s+(?:للعين|العين|عين)|(?:للعين|العين|عين)\s+قطره)/gu," قطعريني ")
  .replace(/(?:\bear\s+drops?\b|قطره\s+(?:للاذن|الاذن|اذن)|(?:للاذن|الاذن|اذن)\s+قطره)/gu," قطراذني ")
  .replace(/(?:\bnasal\s+spray\b|بخاخ\s+(?:للانف|الانف|انف)|(?:للانف|الانف|انف)\s+بخاخ)/gu," بخاخانفي ")
  ;
 const tokens=normalized.match(/\d+(?:\.\d+)?|[\p{L}]+|[^\s]/gu)??[];
 if(tokens.some(x=>[",","،",";","؛","-","–","‐","‑"].includes(x)))return; // unresolved ranges and mixed lists
 const used=new Set<number>(), shapes=new Set<string>(), strengths:string[]=[], packs:string[]=[];
 const unit=(i:number)=>Object.hasOwn(units,tokens[i])?units[tokens[i]]:deeper&&Object.hasOwn(extraUnits,tokens[i])?extraUnits[tokens[i]]:undefined;
 const specialForms:Record<string,string>={قطعريني:"eye-drops",قطراذني:"ear-drops",بخاخانفي:"nasal-spray"};
 const form=(i:number)=>Object.hasOwn(forms,tokens[i])?forms[tokens[i]]:
  deeper&&(Object.hasOwn(specialForms,tokens[i])||Object.hasOwn(extraForms,tokens[i]))?specialForms[tokens[i]]??extraForms[tokens[i]]:undefined;
 const massIsPack = tokens.some(t => ["cream","ointment","gel"].includes(forms[t]??""));
 for(let i=0;i<tokens.length;i++){
  if(used.has(i)||!numeral.test(tokens[i]))continue;
  const u=unit(i+1);
  if(!u){
   // A dual `875/125 mg` strength has one explicit trailing mass unit.
   // Never do this for a ratio with liters, a hyphen/range, or an unknown unit.
   if(deeper&&tokens[i+1]==="/"&&numeral.test(tokens[i+2]??"")&&unit(i+3)?.[0]==="mass"&&tokens[i+4]!=="/"){
    const scale=unit(i+3)![1], a=Number(tokens[i])*scale,b=Number(tokens[i+2])*scale;
    if(!(a>0&&b>0&&Number.isFinite(a)&&Number.isFinite(b)))return;
    strengths.push("mass:"+numberKey(a),"mass:"+numberKey(b));[i,i+1,i+2,i+3].forEach(x=>used.add(x));
   }
   continue;
  }
  const value=Number(tokens[i])*u[1];
  if(!(value>0&&Number.isFinite(value)))return;
  if(tokens[i+2]==="/"&&numeral.test(tokens[i+3]??"")&&unit(i+4)?.[0]==="volume"&&u[0]!=="volume"){
   const den=Number(tokens[i+3])*unit(i+4)![1];if(!den)return;
   strengths.push(u[0]+"/volume:"+numberKey(value/den));
   for(let j=i;j<=i+4;j++)used.add(j);
  }else if(tokens[i+2]==="/"&&unit(i+3)?.[0]==="volume"&&u[0]!=="volume"){
   strengths.push(u[0]+"/volume:"+numberKey(value/unit(i+3)![1]));
   for(let j=i;j<=i+3;j++)used.add(j);
  }else{
   if(u[0]==="volume"||(massIsPack&&u[0]==="mass"&&u[1]===1000000))
    packs.push((u[0]==="mass"?"packmass":u[0])+":"+numberKey(value));
   else strengths.push(u[0]+":"+numberKey(value));
   used.add(i);used.add(i+1);
  }
 }
 for(let i=0;i<tokens.length;i++){
  if(used.has(i))continue;
  const f=form(i);
  if(!f)continue;
  shapes.add(f);used.add(i);
  // Explicit ordinary counts only before a presentation, never consume a dose number.
  const j=i-1;
  if(j>=0&&!used.has(j)&&/^\d+$/u.test(tokens[j])&&Number(tokens[j])>0){
   if(j>=2&&tokens[j-1]==="x"&&!used.has(j-2)&&/^\d+$/u.test(tokens[j-2])){
    packs.push("count:"+String(Number(tokens[j-2])*Number(tokens[j])));
    [j-2,j-1,j].forEach(p=>used.add(p));
   }else if(form(i)==="tablet"||form(i)==="capsule"||form(i)==="sachet"||form(i)==="ampoule"||form(i)==="vial"){
    packs.push("count:"+String(Number(tokens[j])));used.add(j);
   }
  }
 }
 if(deeper&&strengths.length===2){
  for(let i=1;i<tokens.length-1;i++)if(tokens[i]==="/"&&used.has(i-1)&&used.has(i+1)){
   const left=unit(i-1),right=unit(i+2);
   if(left?.[0]==="mass"&&right?.[0]==="mass")used.add(i);
  }
 }
 if(shapes.size!==1||strengths.length===0||strengths.length>2)return;
 // Refuse incomplete concentrations, ratios, and numeric punctuation after extraction.
 const rest=tokens.filter((_,i)=>!used.has(i));
 if(rest.some(x=>!/^\p{L}+$/u.test(x)&&!numeral.test(x)))return;
 const name=rest.join(" ");
 if(!/[ء-يA-Za-z]{2}/.test(name))return;
 return {name,shape:[...shapes][0],strength:strengths.join("|"),packs:[...new Set(packs)].sort()};
}
export type AttributeCard={id:number;name:string};
type ParsedCard={card:AttributeCard;packs:string[]};
const key=(a:NonNullable<ReturnType<typeof imageClinicalAttributes>>,deeper=false)=>{
 // Spacing between Arabic letters is cosmetic. Keep digits, foreign suffixes and their boundaries.
 const name=deeper?a.name.replace(/(?<=[ء-ي])\s+(?=[ء-ي])/gu,""):a.name;
 return JSON.stringify([name,a.strength,a.shape]);
};
function packCompatible(a:string[],b:string[]){
 for(const type of ["volume:","count:","packmass:"]){
  const l=a.filter(v=>v.startsWith(type)),r=b.filter(v=>v.startsWith(type));
  if(l.length&&r.length&&l.join("|")!==r.join("|"))return false;
 }
 return true;
}
export function buildImageAttributeIndex(cards:AttributeCard[],deeper=false){
 const map=new Map<string,ParsedCard[]>();
 for(const card of cards){
  const a=imageClinicalAttributes(card.name,deeper);
  if(!a)continue;
  const k=key(a,deeper),bucket=map.get(k)??[];
  bucket.push({card,packs:a.packs});map.set(k,bucket);
 }
 return map;
}
export function matchImageAttributes(raw:unknown,index:Map<string,ParsedCard[]>,deeper=false){
 const a=imageClinicalAttributes(raw,deeper);if(!a)return undefined;
 const candidates=(index.get(key(a,deeper))??[]).filter(({packs})=>packCompatible(a.packs,packs));
 if(deeper&&candidates.length>1&&a.packs.length){
  // Prefer the only card corroborated by all explicit source packaging facts.
  const proven=candidates.filter(({packs})=>a.packs.every(p=>packs.includes(p)));
  if(proven.length===1)return proven[0].card;
 }
 return candidates.length>1?null:candidates[0]?.card;
}
