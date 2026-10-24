// Automatic legal follow-up ordering. Deterministic, reviewable and based only on
// stored facts: explicit owner-defined priority, filed deadlines and risk keywords.
// An AI assistant can also update owner priorities using the dedicated route.
export type TaskPriorityInput = {
  title:string;body:string;due_at:string|null;status:string;
  task_priority:number|null;task_priority_reason:string|null;
  case_title?:string|null;case_summary?:string|null;next_hearing?:string|null;
};
const urgencyWords: {test:RegExp; priority:number;reason:string}[] = [
  {test:/لطف الزبيري|أمر الأداء.*تظلم|التظلم.*أمر الأداء/,priority:1,reason:"مهلة تظلم قضائي"},
  {test:/العجف والقرشي.*سند الاستئناف|سند الاستئناف.*2566|قطع سند الاستئناف/,priority:2,reason:"قيد استئناف وأسباب الطعن"},
  {test:/ريمان فارما.*(نقض|الطعن)|طعن النقض.*ريمان/,priority:3,reason:"قيد طعن بالنقض"},
  {test:/رويال فارما.*(ميعاد|استئناف|طعن)/,priority:3,reason:"التحقق من ميعاد الاستئناف"},
  {test:/برايم لايف|بريم لايف|649\/1446/,priority:4,reason:"خطر التنفيذ على الصيدلية"},
  {test:/محبوسية|محبوسيات|أمر الحبس|وقف الحبس|رفع الحبس|أسام الكبسي.*تنفيذ/,priority:4,reason:"إجراء يمس الحرية أو التنفيذ"},
  {test:/عمر العطاس.*(تنفيذ|استئناف)|1189\/1447/,priority:4,reason:"تنفيذ وحبس مع استئناف"},
  {test:/عدنان.*(السرحي|استئناف|إكراه)|السرحي.*عدنان/,priority:5,reason:"تحضير رد وجلسة محددة"},
  {test:/بيع جهاز|مزاد|بيع الرنين|بيع المقطعية|حجز جهاز|تنفيذ ناتكو|تنفيذ الشهاري/,priority:5,reason:"خطر التصرف في أجهزة المركز"},
  {test:/وقف التنفيذ|محضر النطق|الاستئناف|نقض|ميعاد الطعن/,priority:6,reason:"إجراء طعن أو تنفيذ قضائي"},
  {test:/التفتيش القضائي|شكوى التفتيش|التفتيش/,priority:8,reason:"متابعة رقابية"},
];
function dueDateOf(raw:string|undefined|null):number|null{
  if(!raw) return null;
  const ms=Date.parse(raw);
  return Number.isFinite(ms)?ms:null;
}
export function calculateLegalTaskPriority(t:TaskPriorityInput,now=Date.now()){
  const manual=t.task_priority;
  if(manual!==null&&manual!==undefined&&manual>=1&&manual<=10) return {priority:manual,reason:t.task_priority_reason||"أولوية حددها المالك",source:"manual" as const};
  const info=t.title+" "+t.body+" "+(t.case_title||"");
  let priority=9,reason="متابعة عادية تحتاج ترتيبًا";
  const explicit=t.title.match(/\[أولوية\s+(\d{1,2})\]/);
  if(explicit&&+explicit[1]>=1&&+explicit[1]<=10){priority=Math.max(1,Math.min(10,+explicit[1]));reason="ترتيب عاجل محدد سابقًا من المالك";}
  else for(const rule of urgencyWords) if(rule.test(info)){priority=rule.priority;reason=rule.reason;break;}
  const due=dueDateOf(t.due_at);
  const hearing=dueDateOf(t.next_hearing);
  const closest=[due,hearing].filter((x):x is number=>x!==null).sort((a,b)=>a-b)[0];
  if(closest!==undefined && t.status!=="verified"){
    const days=(closest-now)/86400000;
    if(days<0){priority=Math.min(priority,2);reason+="؛ موعد مسجل فائت يستلزم التحقق";}
    else if(days<=2){priority=Math.min(priority,3);reason+="؛ الموعد خلال يومين";}
    else if(days<=7){priority=Math.min(priority,5);reason+="؛ الموعد خلال أسبوع";}
  }
  return {priority,reason,source:"automatic" as const};
}
