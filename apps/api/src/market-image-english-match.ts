// Package transcription is independent corroboration; the filename alone cannot link in this mode.
import { imageClinicalAttributes } from "./market-image-attributes.ts";
type Attributes=NonNullable<ReturnType<typeof imageClinicalAttributes>>;
export type EnglishCard={id:number;name:string;englishName?:string|null};
const englishKey=(x:string)=>x.normalize("NFKC").toLowerCase().replace(/[®™]/g,"").trim().replace(/[‐‑–-]/g," ").replace(/\s+/g," ");
const withoutCoating=(x:string)=>x.replace(/\b(?:film[- ]coated|f\.?c\.?|coated)\b/gi," ").trim();
const clean=(x:string)=>x.normalize("NFKC").replace(/[®™]/g,"").replace(/[,،]/g," ").trim();
const qualifications=[
 /\b(?:xr|er|sr|cr|mr|xl|la|retard|extended.release|sustained.release|modified.release|prolonged.release)\b|ممتد|مديد|ريتارد/i,
 /\benteric\b|معوي/i,/\bdispersible\b|للتشتت/i,/\bchewable\b|للمضغ/i,
 /\beffervescent\b|فوار/i,/\bnasal\b|لل[أا]نف/i,/\bophthalmic\b|للعين/i,
 /\botic\b|لل[أا]ذن/i,/\bintravenous\b|وريدي/i,/\bintramuscular\b|عضلي/i,
 /\bsublingual\b|تحت اللسان/i,/\bvaginal\b|مهبلي/i,/\brectal\b|شرجي/i,
];
const route=(x:string)=>qualifications.map(r=>+r.test(x)).join("");
const arKey=(x:string)=>x.replace(/\s+/g,"");
function near(a:string,b:string){
 if(a===b)return true;
 // A one-character spelling difference is allowed only with independently identical English brand.
 if(Math.min(a.length,b.length)<5 || Math.abs(a.length-b.length)>1 || /\d/.test(a+b))return false;
 if(a.length>b.length)[a,b]=[b,a];
 let i=0,j=0,d=0;
 while(i<a.length&&j<b.length){if(a[i]===b[j]){i++;j++;}else{if(++d>1)return false;j++;if(a.length===b.length)i++;}}
 return d+(b.length-j)<=1;
}
function enAttributes(raw:string, shape?:string){
 const s=withoutCoating(clean(raw));
 return imageClinicalAttributes(s,true) ?? (shape?imageClinicalAttributes(s+" "+shape,true):undefined);
}
function enKeys(raw:string, a?:Attributes){
 const keys=new Set([englishKey(raw)]);
 if(a)keys.add(englishKey(a.name));
 return [...keys].filter(k=>/^[a-z][a-z0-9 .'+/]*$/.test(k)&&/[a-z]{3}/.test(k));
}
function sameClinical(a:Attributes,b:Attributes){
 return a.shape===b.shape&&a.strength===b.strength&&a.packs.every(p=>b.packs.includes(p));
}
export function buildEnglishImageIndex(cards:EnglishCard[]){
 const index=new Map<string,{card:EnglishCard;ar?:Attributes;en?:Attributes;raw:string}[]>();
 for(const card of cards){
  const raw=(card.englishName || (/^[A-Za-z]/.test(card.name)?card.name:"")).trim();
  if(!raw)continue;
  const ar=imageClinicalAttributes(withoutCoating(clean(card.name)),true),en=enAttributes(raw);
  for(const key of enKeys(raw,en)) {
   const group=index.get(key)??[];group.push({card,ar,en,raw});index.set(key,group);
  }
 }
 return index;
}
export function matchEnglishImageName(english:unknown, arabic:unknown,index:ReturnType<typeof buildEnglishImageIndex>){
 if(typeof english!=="string"||typeof arabic!=="string")return undefined;
 const a=imageClinicalAttributes(clean(arabic),true);
 if(!a)return undefined;
 const e=enAttributes(english,a.shape);
 if(e&&(e.shape!==a.shape||e.strength!==a.strength))return undefined;
 const opts=new Map<number,EnglishCard>();
 for(const k of enKeys(english,e))for(const {card,ar,en,raw} of index.get(k)??[]){
  // An English/Arabic conflict on the destination, or any packaging conflict, is not a match.
  if(ar&&en&&(ar.shape!==en.shape||ar.strength!==en.strength||ar.packs.some(p=>en.packs.some(q=>p.split(":")[0]===q.split(":")[0])&&!en.packs.includes(p))))continue;
  const b=ar??en;
  if(!b||!sameClinical(a,b))continue;
  if(e&&e.packs.some(p=>!b.packs.includes(p)&&!en?.packs.includes(p)))continue;
  const sourceQualified=route(arabic+" "+english),targetQualified=route(card.name+" "+raw);
  if(sourceQualified!==targetQualified)continue;
  const sourceArabic=/[ء-ي]/.test(a.name),targetArabic=/[ء-ي]/.test(b.name);
  if((sourceArabic&&targetArabic)&&!near(arKey(a.name),arKey(b.name)))continue;
  // For a Latin-only card, the English brand and both clinical attributes remain mandatory.
  opts.set(card.id,card);
 }
 return opts.size>1?null:opts.values().next().value;
}
