import { api } from "./api";
import { offlineUser, readCatalogProgress, rememberRead, saveCatalogProgress, savedRead } from "./offline-storage";

export type OfflineQuestionCard = {
  id:number; companyId:number|null; category:string;priority:number;question:string;
  options:string[]; optionCount:number; correctAnswer:number; revision:number;
  active:boolean; points:number; [key:string]:unknown;
};
type Pack={items:OfflineQuestionCard[];total:number;page:number;pageSize:number};
const pageSize=100;
const root=(companyId:number|null)=>companyId===null?"/questions":"/companies/"+companyId+"/questions";
const path=(companyId:number|null,page:number)=>
  root(companyId)+"/offline-pack?page="+page+"&pageSize="+pageSize;

/** Keep answer keys in user-scoped IndexedDB snapshots, never shared cache. */
export async function loadOfflineQuestionPack(userId:number,companyId:number|null):
  Promise<OfflineQuestionCard[]> {
  if(offlineUser()!==userId)return [];
  const records=new Map<number,OfflineQuestionCard>();
  for(let page=1;page<=20;page++){
    const data=await savedRead<Pack>(path(companyId,page)).catch(()=>undefined);
    if(!data?.items?.length)continue;
    for(const q of data.items)if(q.active && Number.isInteger(q.correctAnswer) &&
        q.correctAnswer>=1 && q.correctAnswer<=q.options.length)
      records.set(q.id,q);
  }
  return [...records.values()];
}

const running=new Map<string,Promise<void>>();
export function syncOfflineQuestionPack(userId:number,companyId:number|null):Promise<void> {
  const key=userId+":"+(companyId??0);
  if(running.has(key))return running.get(key)!;
  const work=(async()=>{
    if(offlineUser()!==userId || !navigator.onLine)return;
    const scope=companyId??0;
    const progress=await readCatalogProgress(userId,scope,"private-question-pack");
    // Recheck the first page, and rotate through remaining pages even
    // after completion. New and edited answer keys must reach this private cache.
    const pages=[1,...Array.from({length:5},(_,i)=>
      Math.max(2,progress.nextPage)+i).filter(page=>page<=20)];
    for(const page of new Set(pages)){
      if(offlineUser()!==userId||!navigator.onLine||
         document.visibilityState==="hidden")return;
      const url=path(companyId,page);
      let data:Pack;
      try{data=await api<Pack>(url);}catch{return;}
      // Await durable persistence before advancing the cursor.
      await rememberRead(url,data);
      const complete=page*pageSize>=data.total;
      if(page>1 || complete)await saveCatalogProgress(userId,scope,
        "private-question-pack",complete?2:page+1,complete);
      if(complete)break;
    }
  })().finally(()=>running.delete(key));
  running.set(key,work);
  return work;
}

/** The source question revision must match the cached answer key. */
export function gradeOfflineQuestion(
  question:{id:number;revision:number;options:string[]},
  keys:readonly OfflineQuestionCard[],selectedAnswer:number,
):{correct:boolean;correctAnswer:number;correctText:string}|null {
  const answer=keys.find(item=>item.id===question.id &&
    item.revision===question.revision);
  if(!answer || answer.options.length!==question.options.length ||
     answer.options.some((text,i)=>text!==question.options[i]))return null;
  const correctText=question.options[answer.correctAnswer-1];
  if(!correctText)return null;
  return {
    correct:selectedAnswer===answer.correctAnswer,
    correctAnswer:answer.correctAnswer,correctText,
  };
}
