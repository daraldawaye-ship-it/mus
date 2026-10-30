import { api } from "./api";
import { storePersonalAnswer, announcePersonalAnswerChanges, readCatalogProgress, saveCatalogProgress } from "./offline-storage";
type HistoryPage={items:{questionId:number;selectedAnswer:number;correct:boolean;correctAnswer:number|null;correctText?:string|null;points:number;comment:string|null;otherOptionCounts:number[]}[];total:number};
export async function syncMyHistory(userId:number,companyId:number|null){
  for(const id of companyId?[0,companyId]:[0]){
    if(!navigator.onLine)return;
    const base=id?"/companies/"+id+"/questions/my-history":"/questions/my-history";
    const scope=id?"company:"+id:"public";
    const old=await readCatalogProgress(userId,id,"answer-history");
    const pages=[1,...(!old.complete?Array.from({length:6},(_,i)=>old.nextPage>1?old.nextPage+i:2+i):[])];
    let wrote=false;
    for(const page of pages){
      try {
        const data=await api<HistoryPage>(base+"?page="+page+"&pageSize=100");
        for(const entry of data.items){
          await storePersonalAnswer(userId,scope,entry.questionId,entry,false);
          wrote=true;
        }
        if(page>1 || page*100>=data.total || !old.complete)
          await saveCatalogProgress(userId,id,"answer-history",
            page===1 && page*100<data.total
              ?Math.max(2,old.nextPage):page+1,page*100>=data.total);
        if(page*100>=data.total)break;
      }catch{break;}
    }
    if(wrote)announcePersonalAnswerChanges();
  }
}
