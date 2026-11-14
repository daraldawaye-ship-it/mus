import {useState,type FormEvent} from "react";
import {api,useSession} from "../api";
import {Button,Card,Notice,PageHeader} from "../ui";

type ReadResult={mode:"read";columns:string[];rows:(string|number|boolean|null)[][];rowCount:number;truncated:boolean};
const examples={
  main:"SELECT id, code, message, created_at FROM notifications WHERE message LIKE '%@%' ORDER BY created_at DESC;",
  market:"SELECT id, kind, name, status FROM medicine_market_cards ORDER BY id DESC;",
} as const;
const format=(v:unknown)=>v===null?"NULL":String(v);

export function OwnerSqlConsolePage(){
  const {user}=useSession();
  const [password,setPassword]=useState("");
  const [token,setToken]=useState<string|null>(null);
  const [database,setDatabase]=useState<"main"|"market">("main");
  const [sql,setSql]=useState<string>(examples.main);
  const [result,setResult]=useState<ReadResult|null>(null);
  const [running,setRunning]=useState(false);
  const [error,setError]=useState("");
  const issue=(e:unknown)=>{
    setError(e instanceof Error?e.message:"تعذرت العملية");
    if(e instanceof Error&&("code" in e)&&e.code==="sql_unlock_required"){
      setToken(null);setResult(null);
    }
  };
  const unlock=async(event:FormEvent)=>{
    event.preventDefault();setError("");setRunning(true);
    try{
      const out=await api<{token:string}>("/owner-sql/unlock",{method:"POST",body:{password}});
      setToken(out.token);setPassword("");setResult(null);
    }catch(e){issue(e);}finally{setRunning(false);}
  };
  const read=async()=>{
    if(!token||!sql.trim())return;
    setResult(null);setError("");
    if(!/^\s*SELECT\b/i.test(sql)){
      setError("هذه الصفحة للاستعراض فقط. استعلامات INSERT وUPDATE وDELETE تُنفّذ فقط عبر اتصال ChatGPT المصرّح به.");
      return;
    }
    setRunning(true);
    try{
      const out=await api<ReadResult>("/owner-sql/preview",{method:"POST",body:{database,token,sql}});
      setResult(out);
    }catch(e){issue(e);}finally{setRunning(false);}
  };
  if(!user?.owner)return <Notice tone="error">هذه الصفحة مخصصة لمالك المنصة فقط.</Notice>;
  return <main style={{maxWidth:1200,margin:"0 auto"}}>
    <PageHeader title={!token?"تسجيل الخروج":"استعلامات PostgreSQL"}
      description={!token?"أدخل كلمة المرور للمتابعة.":"استعراض قاعدة الرئيسي والسوق الرئيسي فقط. جميع تعديلات SQL عبر اتصال ChatGPT للمالك."}/>
    {!token?<Card title="تسجيل الخروج" description="أدخل كلمة المرور للمتابعة.">
      <form onSubmit={unlock} className="form-stack" style={{maxWidth:370}}>
        <label className="form-field">كلمة المرور
          <input type="password" autoComplete="off" value={password} onChange={e=>setPassword(e.target.value)} required/>
        </label>
        <div><Button type="submit" disabled={running||!password}>{running?"جارٍ التحقق…":"تأكيد"}</Button></div>
      </form>
    </Card>:<>
      <Card title="استعراض البيانات" description="استعلام SELECT واحد لكل مرة؛ اختيار السوق لا يخلط بياناته بقاعدة الرئيسي.">
        <label className="form-field" style={{maxWidth:420}}>قاعدة البيانات
          <select value={database} onChange={e=>{
            const next=e.target.value as "main"|"market";
            setDatabase(next);setSql(examples[next]);setResult(null);setError("");
          }}>
            <option value="main">الرئيسي — الشركات والصيدلية</option>
            <option value="market">السوق الرئيسي — قاعدة الأدوية المستقلة</option>
          </select>
        </label>
        <label className="form-field">SQL — للقراءة فقط
          <textarea dir="ltr" spellCheck={false} rows={8} value={sql}
            style={{width:"100%",fontFamily:"ui-monospace, SFMono-Regular, Consolas, monospace",
              fontSize:14,textAlign:"left",whiteSpace:"pre",lineHeight:1.5}}
            onChange={e=>{setSql(e.target.value);setResult(null);setError("");}}/>
        </label>
        <div className="form-actions" style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <Button disabled={running||!sql.trim()} onClick={()=>void read()}>{running?"جارٍ الاستعلام…":"عرض النتائج"}</Button>
          <Button variant="secondary" onClick={()=>{setToken(null);setPassword("");setResult(null);}}>إغلاق الصفحة المحمية</Button>
        </div>
      </Card>
      <p style={{fontSize:13,opacity:.85,marginBlock:12}}>
        عرض ما يصل إلى 200 صف و80 عمودًا. استعلامات الإضافة والتحديث والحذف غير متاحة من هذه الصفحة،
        حتى عبر استدعاء الواجهة البرمجية مباشرة؛ تنفيذها للمالك عبر ChatGPT بصلاحيات OAuth ومعاينة وتأكيد وتدقيق.
      </p>
      {result&&<Card title={"النتائج — "+result.rowCount+" صف"}>
        {result.truncated&&<Notice>اقتصر العرض على أول 200 صف أو 80 عمودًا؛ استخدم WHERE أو LIMIT لتحديد النتائج.</Notice>}
        {result.rows.length===0?<p>لا توجد نتائج.</p>:<div style={{overflowX:"auto",maxHeight:550,overflowY:"auto"}}>
          <table dir="ltr" style={{width:"max-content",minWidth:"100%",borderCollapse:"collapse",fontSize:13,textAlign:"left"}}>
            <thead><tr>{result.columns.map((c,i)=><th key={i} style={{padding:8,position:"sticky",top:0,background:"var(--card-bg, #fafafa)",borderBottom:"1px solid #999"}}>{c}</th>)}</tr></thead>
            <tbody>{result.rows.map((row,ri)=><tr key={ri}>{row.map((v,ci)=><td key={ci} style={{padding:8,verticalAlign:"top",maxWidth:420,overflowWrap:"anywhere",whiteSpace:"pre-wrap",borderBottom:"1px solid #ddd"}}>{format(v)}</td>)}</tr>)}</tbody>
          </table>
        </div>}
      </Card>}
    </>}
    {error&&<Notice tone="error">{error}</Notice>}
  </main>;
}
