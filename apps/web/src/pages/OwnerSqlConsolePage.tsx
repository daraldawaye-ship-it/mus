import {useState,type FormEvent} from "react";
import {api,useSession} from "../api";
import {Button,Card,Notice,PageHeader} from "../ui";

type ReadResult={mode:"read";columns:string[];rows:(string|number|boolean|null)[][];rowCount:number;truncated:boolean};
type WritePreview={mode:"write";kind:"insert"|"update"|"delete";table:string;estimatedRows:number|null;
  confirmationId:string;expiresInSeconds:number;maxChangedRows:number};
type SQLPreview=ReadResult|WritePreview;
type Written={ok:true;kind:string;table:string;affectedRows:number};
const example="SELECT id, code, message, created_at FROM notifications WHERE message LIKE '%@%' ORDER BY created_at DESC;";
const format=(v:unknown)=>v===null?"NULL":String(v);

export function OwnerSqlConsolePage(){
  const {user}=useSession();
  const [password,setPassword]=useState("");
  const [token,setToken]=useState<string|null>(null);
  const [sql,setSql]=useState(example);
  const [preview,setPreview]=useState<SQLPreview|null>(null);
  const [confirmation,setConfirmation]=useState("");
  const [running,setRunning]=useState(false);
  const [error,setError]=useState("");
  const [saved,setSaved]=useState<Written|null>(null);

  const issue=(e:unknown)=>{
    setError(e instanceof Error?e.message:"تعذرت العملية");
    if(e instanceof Error && ("code" in e) && e.code==="sql_unlock_required"){
      setToken(null);setPreview(null);
    }
  };
  const unlock=async(event:FormEvent)=>{
    event.preventDefault();setError("");setRunning(true);
    try{
      const res=await api<{token:string}>("/owner-sql/unlock",{method:"POST",body:{password}});
      setToken(res.token);setPassword("");setPreview(null);setSaved(null);
    }catch(e){issue(e);}finally{setRunning(false);}
  };
  const runPreview=async()=>{
    if(!token||!sql.trim())return;
    setRunning(true);setError("");setPreview(null);setConfirmation("");setSaved(null);
    try{
      const result=await api<SQLPreview>("/owner-sql/preview",{method:"POST",body:{token,sql}});
      setPreview(result);
    }catch(e){issue(e);}finally{setRunning(false);}
  };
  const execute=async()=>{
    if(!token||!preview||preview.mode!=="write"||confirmation!=="تنفيذ")return;
    setRunning(true);setError("");
    try{
      const done=await api<Written>("/owner-sql/execute",{method:"POST",body:{
        token,sql,confirmationId:preview.confirmationId
      }});
      setSaved(done);setPreview(null);setConfirmation("");
    }catch(e){setPreview(null);setConfirmation("");issue(e);}finally{setRunning(false);}
  };
  if(!user?.owner)return <Notice tone="error">صفحة استعلامات PostgreSQL مخصصة لمالك المنصة فقط.</Notice>;
  return <main style={{maxWidth:1200,margin:"0 auto"}}>
    <PageHeader title="استعلامات PostgreSQL"
      description="لوحة قاعدة بيانات الرئيسي للمالك فقط. SELECT للقراءة، وINSERT وUPDATE وDELETE بعد المعاينة والتأكيد."/>
    {!token?<Card title="كلمة مرور الصفحة" description="يلزم تسجيل الدخول بحساب المالك ثم إدخال كلمة مرور إضافية عند كل فتح.">
      <form onSubmit={unlock} className="form-stack" style={{maxWidth:370}}>
        <label className="form-field">كلمة المرور
          <input type="password" autoComplete="off" value={password} onChange={e=>setPassword(e.target.value)} required/>
        </label>
        <div><Button type="submit" disabled={running||!password}>{running?"جارٍ التحقق…":"فتح صفحة الاستعلامات"}</Button></div>
      </form>
    </Card>:<>
      <Card title="محرر الاستعلام" description="قاعدة الرئيسي فقط، استعلام واحد في كل مرة. التغييرات لا تُحفظ عند المعاينة.">
        <label className="form-field">SQL
          <textarea dir="ltr" spellCheck={false} rows={9} value={sql}
            style={{width:"100%",fontFamily:"ui-monospace, SFMono-Regular, Consolas, monospace",
              fontSize:14,textAlign:"left",whiteSpace:"pre",lineHeight:1.5}}
            onChange={e=>{setSql(e.target.value);setPreview(null);setSaved(null);setConfirmation("");setError("");}}/>
        </label>
        <div className="form-actions" style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <Button onClick={()=>void runPreview()} disabled={running||!sql.trim()}>
            {running?"جارٍ الفحص…":"فحص / معاينة الاستعلام"}
          </Button>
          <Button variant="secondary" onClick={()=>{setToken(null);setPassword("");setPreview(null);setSaved(null);}}>
            إغلاق الصفحة المحمية
          </Button>
        </div>
      </Card>
      <p style={{fontSize:13,opacity:.85,marginBlock:12}}>
        الحماية: مالك المنصة فقط، كلمة مرور إضافية، مهلة تنفيذ قصيرة، حد 200 صف للعرض و500 صف للتغيير.
        أوامر تحديث وحذف الصفوف تتطلب WHERE؛ الجداول الأمنية محمية. أي تغيير مباشر يتجاوز إجراءات الحفظ المعتادة
        للموقع وقد يؤثر على الحسابات والمخزون، لذا راجع الاستعلام جيدًا.
      </p>
      {preview?.mode==="read"&&<Card title={"النتائج — "+preview.rowCount+" صف"}>
        {preview.truncated&&<Notice>اقتصر العرض على أول 200 صف أو أول 80 عمودًا. أضف WHERE أو LIMIT لتحديد النتائج.</Notice>}
        {preview.rows.length===0?<p>لا توجد نتائج.</p>:<div style={{overflowX:"auto",maxHeight:550,overflowY:"auto"}}>
          <table dir="ltr" style={{width:"max-content",minWidth:"100%",borderCollapse:"collapse",fontSize:13,textAlign:"left"}}>
            <thead><tr>{preview.columns.map((c,i)=><th key={i} style={{padding:8,position:"sticky",top:0,background:"var(--card-bg, #fafafa)",borderBottom:"1px solid #999"}}>{c}</th>)}</tr></thead>
            <tbody>{preview.rows.map((row,ri)=><tr key={ri}>{row.map((value,ci)=><td key={ci} style={{padding:8,verticalAlign:"top",maxWidth:420,overflowWrap:"anywhere",whiteSpace:"pre-wrap",borderBottom:"1px solid #ddd"}}>{format(value)}</td>)}</tr>)}</tbody>
          </table>
        </div>}
      </Card>}
      {preview?.mode==="write"&&<Card title="معاينة التغيير — لم تُعدَّل البيانات">
        <p><strong>نوع العملية:</strong> {preview.kind.toUpperCase()} | <strong>الجدول:</strong> {preview.table}</p>
        <p>العدد التقديري من مخطط PostgreSQL: <strong>{preview.estimatedRows??"غير محدد"}</strong>.
          قد يختلف العدد الفعلي، والمعاملة تُلغى إذا تجاوز التغيير 500 صف.</p>
        <Notice>تنبيه: هذه معاينة تخطيطية دون تشغيل عملية التعديل. تأكد من شروط WHERE والقيم قبل التنفيذ. ينتهي التأكيد بعد دقيقتين.</Notice>
        <label className="form-field" style={{maxWidth:350}}>اكتب كلمة «تنفيذ» لتأكيد الاستعلام
          <input value={confirmation} autoComplete="off" onChange={e=>setConfirmation(e.target.value)} placeholder="تنفيذ"/>
        </label>
        <Button variant="danger" disabled={running||confirmation!=="تنفيذ"} onClick={()=>void execute()}>
          {running?"جارٍ التنفيذ…":"تنفيذ التغيير نهائيًا"}
        </Button>
      </Card>}
      {saved&&<Notice>تم تنفيذ {saved.kind.toUpperCase()} على جدول {saved.table}. الصفوف المتأثرة: {saved.affectedRows}. سُجلت العملية في التدقيق.</Notice>}
    </>}
    {error&&<Notice tone="error">{error}</Notice>}
  </main>;
}
