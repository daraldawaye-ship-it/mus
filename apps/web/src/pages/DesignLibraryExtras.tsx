import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle, ArrowLeft, Bell, Check, CheckCircle2, ChevronDown,
  ChevronLeft, Clock3, Copy, Download, FileText, Info, LayoutGrid,
  ListFilter, LoaderCircle, MoreHorizontal, Search,
  SlidersHorizontal, X,
} from "lucide-react";
import "./DesignLibraryExtras.css";

/** Original demonstrations built for Alraesy; inspiration category:
 * FreeFrontend CSS components. Never fetch scripts or CSS from other sites. */
function Exhibit({ code, title, note, children }: {
  code: string; title: string; note?: string; children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const copyLabel = () => {
    void navigator.clipboard?.writeText(title + " — " + code).then(
      () => setCopied(true), () => setCopied(false),
    );
  };
  return <article className="design-sample">
    <header className="design-sample-heading">
      <div><strong>{title}</strong><span className="design-sample-code">{code}</span></div>
      <button className="design-copy" type="button" onClick={copyLabel} title="نسخ الاسم والرمز">
        {copied ? <Check size={13}/> : <Copy size={13}/>} {copied ? "نُسخ" : "نسخ الاسم"}
      </button>
    </header>
    <div className="design-sample-body">{children}</div>
    {note && <p className="design-sample-note">{note}</p>}
  </article>;
}
function ExtraGrid({ title, detail, children }: { title: string; detail: string; children: ReactNode }) {
  return <section className="design-group design-extras">
    <div className="design-group-heading"><h2>{title}</h2><p>{detail}</p></div>
    <div className="design-sample-grid">{children}</div>
  </section>;
}
export default function DesignLibraryExtras({ section }: { section: string }) {
  const [level, setLevel] = useState(42);
  const [tokens, setTokens] = useState(["فعال"]);
  const [armed, setArmed] = useState(false);
  const [action, setAction] = useState("");
  const [row, setRow] = useState(1);
  const [activeFilter, setActiveFilter] = useState("الكل");
  const [activeTab, setActiveTab] = useState("المبيعات");
  const [step, setStep] = useState(1);
  const [toast, setToast] = useState(true);
  const [showMenu, setShowMenu] = useState(false);
  if (section === "fields") return <ExtraGrid title="أفكار إضافية للحقول" detail="مستوحاة من حقول الإدخال والتحقق، مع أحجام مناسبة للاستخدام اليومي.">
    <Exhibit code="ح-13" title="حقل بعنوان عائم" note="العنوان يبقى ظاهرًا عندما تكتب.">
      <label className="design-ex-floating"><input type="text" required placeholder=" "/><span>اسم الطبيب أو الممرض</span></label>
    </Exhibit>
    <Exhibit code="ح-14" title="حقل بتحقق فوري" note="جرّب كتابة بريد صحيح أو غير صحيح؛ لا يُرسل شيء.">
      <label className="design-field design-ex-validate">البريد الإلكتروني
        <input type="email" required placeholder="name@example.com"/>
        <small>الحدود تتغير بحسب صحة التنسيق.</small>
      </label>
    </Exhibit>
    <Exhibit code="ح-15" title="حقل بحث مع إجراء">
      <div className="design-ex-input-action"><input placeholder="ابحث باسم الصنف" aria-label="البحث باسم الصنف"/><button className="button button-secondary" type="button" onClick={()=>setAction("نموذج زر البحث") }><Search size={14}/> بحث</button></div>
    </Exhibit>
    <Exhibit code="ح-16" title="شريط اختيار نسبة">
      <label className="design-field">النسبة: {level}%<input type="range" min={0} max={100} value={level} onChange={event => setLevel(Number(event.target.value))}/></label>
    </Exhibit>
    <Exhibit code="ح-17" title="اختيارات على شكل شرائح" note="تُستخدم في فلاتر قصيرة بدل قائمة طويلة.">
      <div className="design-ex-choice-chips">{["فعال","مؤرشف","خاص"].map(x=><button type="button" key={x} aria-pressed={tokens.includes(x)} className={tokens.includes(x)?"selected":""} onClick={()=>setTokens(old=>old.includes(x)?old.filter(v=>v!==x):[...old,x])}>{tokens.includes(x)&&<Check size={12}/>} {x}</button>)}</div>
    </Exhibit>
  </ExtraGrid>;

  if (section === "buttons") return <ExtraGrid title="أشكال جديدة للأزرار" detail="مشتقة من أزرار الإطار والعمق والتقسيم، دون مؤثرات مزعجة.">
    <Exhibit code="ز-13" title="زر بإطار فقط">
      <button type="button" className="button design-ex-outline" onClick={()=>setAction("زر بإطار فقط")}>عرض التفاصيل</button>
    </Exhibit>
    <Exhibit code="ز-14" title="زر مرتفع قليلًا">
      <button type="button" className="button design-ex-raised" onClick={()=>setAction("زر مرتفع")}>استلام السند</button>
    </Exhibit>
    <Exhibit code="ز-15" title="زر منقسم مع قائمة">
      <div className="design-ex-split"><button type="button" onClick={()=>setAction("حفظ")}>حفظ</button><button type="button" onClick={()=>setShowMenu(v=>!v)} aria-expanded={showMenu} aria-label="خيارات الحفظ"><ChevronDown size={15}/></button></div>
      {showMenu && <div className="design-ex-menu"><button onClick={()=>{setAction("حفظ نسخة");setShowMenu(false);}}>حفظ نسخة</button><button onClick={()=>{setAction("معاينة");setShowMenu(false);}}>معاينة</button></div>}
    </Exhibit>
    <Exhibit code="ز-16" title="زر بتأكيد ثانٍ" note="التأكيد هنا تجريبي ولا يحذف أي شيء.">
      <div className="design-ex-inline"><button type="button" className={armed?"button button-danger":"button button-secondary"} onClick={()=>{setArmed(!armed);setAction(armed?"تأكيد تجريبي":"طلب تأكيد");}}>{armed?"اضغط لتأكيد المثال":"حذف تجريبي"}</button>{armed&&<button type="button" className="button button-ghost" onClick={()=>setArmed(false)}>إلغاء</button>}</div>
    </Exhibit>
    <Exhibit code="ز-17" title="زر في حالة انتظار">
      <button className="button button-primary" type="button" disabled><LoaderCircle size={14} className="design-ex-spin"/> جارٍ الحفظ…</button>
    </Exhibit>
    <Exhibit code="ز-18" title="زر تنزيل بأيقونة">
      <button type="button" className="button button-secondary" onClick={()=>setAction("زر تنزيل تجريبي")}><Download size={14}/> تنزيل التقرير</button>
      <small className="design-ex-muted" aria-live="polite">{action? "آخر تفاعل: "+action : "هذه الأزرار للمعاينة فقط."}</small>
    </Exhibit>
  </ExtraGrid>;

  if (section === "colors") return <ExtraGrid title="شارات وحالات إضافية" detail="تُحافظ على ألوان الحالات الدلالية، لا تعتمد لون المستخدم للحذف أو التحذير.">
    <Exhibit code="ل-09" title="حالة بحزام جانبي"><div className="design-ex-side"><strong>طلب يحتاج مراجعة</strong><small>حزام لوني بديل عن تلوين البطاقة بالكامل.</small></div></Exhibit>
    <Exhibit code="ل-10" title="حالات مصغّرة في جدول"><div className="design-ex-inline"><span className="design-ex-tag good">منجز</span><span className="design-ex-tag warn">معلق</span><span className="design-ex-tag bad">متأخر</span></div></Exhibit>
    <Exhibit code="ل-11" title="شارة مع أيقونة"><div className="design-ex-inline"><span className="design-ex-tag good"><CheckCircle2 size={12}/> مكتمل</span><span className="design-ex-tag neutral"><Clock3 size={12}/> انتظار</span></div></Exhibit>
    <Exhibit code="ل-12" title="عداد فوق عنوان"><div className="design-ex-count-label"><Bell size={17}/><strong>التنبيهات</strong><span>12</span></div></Exhibit>
  </ExtraGrid>;

  if (section === "surfaces") return <ExtraGrid title="لوحات وبطاقات عملية" detail="تأثيرات خفيفة على البطاقات تصلح لشاشات الحسابات والمخزون.">
    <Exhibit code="ق-11" title="بطاقة تبرز عند المرور"><div className="design-ex-lift"><strong>حركة الأصناف</strong><small>مرر المؤشر لإظهار الحد والظل.</small></div></Exhibit>
    <Exhibit code="ق-12" title="بطاقات متراكبة"><div className="design-ex-stack-cards"><div>مسودة أولى</div><div>مسودة ثانية</div><div>مسودة ثالثة</div></div></Exhibit>
    <Exhibit code="ق-13" title="بطاقة بشريط حالة"><div className="design-ex-side"><strong>مهمة لم تُراجع</strong><small>معلومة أساسية وحالة واضحة.</small></div></Exhibit>
    <Exhibit code="ق-14" title="لوحة بعنوان وإجراءات"><div className="design-ex-toolbar"><div><strong>طلبات الشراء</strong><small>الإجراءات بجانب العنوان</small></div><button type="button" className="button button-secondary design-btn-sm"><SlidersHorizontal size={13}/> خيارات</button></div></Exhibit>
    <Exhibit code="ق-15" title="بطاقة حالة فارغة"><div className="design-ex-empty"><LayoutGrid size={21}/><strong>لا توجد طلبات</strong><small>تظهر حالة فارغة بدل جدول بلا صفوف.</small></div></Exhibit>
  </ExtraGrid>;

  if (section === "tables") return <ExtraGrid title="تطوير أسلوب الجداول" detail="التمييز والإجراءات تظهر عند الحاجة، مع الحفاظ على كثافة الصفوف.">
    <Exhibit code="ج-09" title="جدول يبرز السطر عند المرور">
      <div className="design-ex-table-scroll"><table className="design-ex-table design-ex-hover"><thead><tr><th>الصنف</th><th>الرصيد</th></tr></thead><tbody><tr><td>صنف أول</td><td>12</td></tr><tr><td>صنف ثان</td><td>4</td></tr><tr><td>صنف ثالث</td><td>7</td></tr></tbody></table></div>
    </Exhibit>
    <Exhibit code="ج-10" title="سطر محدد من جدول">
      <div className="design-ex-table-scroll"><table className="design-ex-table"><thead><tr><th>الاختيار</th><th>المهمة</th></tr></thead><tbody>{[1,2,3].map(i=><tr key={i} className={row===i?"design-ex-row-active":""}><td><button type="button" aria-pressed={row===i} aria-label={"اختيار السطر "+i} onClick={()=>setRow(i)}>{row===i?"✓":"○"}</button></td><td>مهمة {i}</td></tr>)}</tbody></table></div>
    </Exhibit>
    <Exhibit code="ج-11" title="شريط تصفية بشرائح"><div className="design-ex-choice-chips">{["الكل","المفتوح","المنجز"].map(x=><button key={x} className={activeFilter===x?"selected":""} aria-pressed={activeFilter===x} onClick={()=>setActiveFilter(x)}>{x}</button>)}</div></Exhibit>
    <Exhibit code="ج-12" title="عناوين مجموعات في جدول"><div className="design-ex-table-scroll"><table className="design-ex-table"><tbody><tr className="design-ex-table-group"><th colSpan={2}>فواتير اليوم</th></tr><tr><td>مبيعات</td><td>11</td></tr><tr className="design-ex-table-group"><th colSpan={2}>فواتير الأمس</th></tr><tr><td>مشتريات</td><td>3</td></tr></tbody></table></div></Exhibit>
    <Exhibit code="ج-13" title="شريط تمرير جدول عريض"><div className="design-ex-table-scroll"><table className="design-ex-table design-ex-wide"><thead><tr><th>الصنف</th><th>الكمية</th><th>السعر</th><th>المورد</th><th>التاريخ</th></tr></thead><tbody><tr><td>صنف تجريبي</td><td>13</td><td>500</td><td>مورد تجريبي</td><td>2026/11/14</td></tr></tbody></table></div><small className="design-ex-muted">مرر أفقيًا لرؤية بقية الأعمدة.</small></Exhibit>
  </ExtraGrid>;

  if (section === "navigation") return <>
    <ExtraGrid title="التنقل داخل الأقسام" detail="تجميع أدوات مرتبطة دون تزاحم روابط الصفحات.">
      <Exhibit code="ت-01" title="تبويبات علوية"><div className="design-ex-tabs">{["المبيعات","المشتريات","المرتجعات"].map(x=><button key={x} className={activeTab===x?"selected":""} onClick={()=>setActiveTab(x)} aria-selected={activeTab===x} role="tab">{x}</button>)}</div><small className="design-ex-muted">المحدد: {activeTab}</small></Exhibit>
      <Exhibit code="ت-02" title="أقسام قابلة للطي"><div className="design-ex-accordion"><details><summary>المعلومات الأساسية <ChevronDown size={14}/></summary><p>اسم الصنف، التركيب، الشكل والوكيل.</p></details><details><summary>بيانات إضافية <ChevronDown size={14}/></summary><p>خيارات المورد والملاحظات والتصنيف.</p></details></div></Exhibit>
      <Exhibit code="ت-03" title="مسار موقع الصفحة"><div className="design-ex-crumb"><span>الشركة</span><ChevronLeft size={13}/><span>المشتريات</span><ChevronLeft size={13}/><strong>الفواتير</strong></div></Exhibit>
      <Exhibit code="ت-04" title="قائمة من زر الإجراءات"><div className="design-ex-inline"><button className="button button-secondary" onClick={()=>setShowMenu(v=>!v)}><MoreHorizontal size={14}/> إجراءات <ChevronDown size={13}/></button>{showMenu && <div className="design-ex-mini-menu"><button type="button">فتح</button><button type="button">تعديل</button></div>}</div></Exhibit>
    </ExtraGrid>
    <ExtraGrid title="خطوات عمل مبسطة" detail="مناسب لطلبات المخزون أو نماذج متعددة الخطوات.">
      <Exhibit code="ت-05" title="شريط خطوات"><div className="design-ex-steps">{["اختيار","مراجعة","تأكيد"].map((x,i)=><button key={x} className={step===i+1?"active":step>i+1?"done":""} onClick={()=>setStep(i+1)} aria-current={step===i+1?"step":undefined}><span>{step>i+1?<Check size={12}/>:i+1}</span>{x}</button>)}</div></Exhibit>
      <Exhibit code="ت-06" title="قائمة انتقال مختصرة"><div className="design-ex-links"><Link to="/design-library/fields"><FileText size={14}/> حقول الإدخال <ArrowLeft size={13}/></Link><Link to="/design-library/tables"><ListFilter size={14}/> الجداول <ArrowLeft size={13}/></Link></div></Exhibit>
    </ExtraGrid>
  </>;

  if (section === "feedback") return <>
    <ExtraGrid title="حالات التحميل والانتظار" detail="تبين أن العملية مستمرة دون منع المستخدم من متابعة الصفحة.">
      <Exhibit code="م-01" title="صف هيكلي أثناء التحميل"><div className="design-ex-skeleton"><span/><span/><span/></div></Exhibit>
      <Exhibit code="م-02" title="بطاقة هيكلية"><div className="design-ex-skeleton-card"><span/><span/><span/></div></Exhibit>
      <Exhibit code="م-03" title="مؤشر دوران بسيط"><div className="design-ex-inline"><LoaderCircle className="design-ex-spin" size={19}/> جارٍ جلب النتائج...</div></Exhibit>
      <Exhibit code="م-04" title="شريط تقدم مجزأ"><div className="design-ex-progress-steps"><span className="done"/><span className="done"/><span className="active"/><span/></div><small className="design-ex-muted">3 من 4 مراحل</small></Exhibit>
    </ExtraGrid>
    <ExtraGrid title="مؤشرات وأحداث عملية" detail="بيانات توضيحية وأرقام غير حقيقية لغرض اختيار الشكل فقط.">
      <Exhibit code="م-05" title="مؤشر إحصائي بفرق"><div className="design-ex-metric"><span>عدد الفواتير</span><strong>128</strong><small>↑ 12% مقارنة بالفترة السابقة</small></div></Exhibit>
      <Exhibit code="م-06" title="أعمدة مقارنة صغيرة"><div className="design-ex-bars">{[35,58,46,80,66,92,72].map((x,i)=><span key={i} style={{height:x+"%"}} title={"بيان "+(i+1)}/>)}</div></Exhibit>
      <Exhibit code="م-07" title="خط زمني للأحداث"><ol className="design-ex-timeline"><li><strong>إنشاء الطلب</strong><small>09:00</small></li><li><strong>مراجعة الطلب</strong><small>10:15</small></li><li><strong>اعتماد نهائي</strong><small>قيد الانتظار</small></li></ol></Exhibit>
      <Exhibit code="م-08" title="تنبيه داخل الصفحة مع إغلاق">{toast?<div className="design-ex-toast"><Info size={15}/><span>تم تحديث العرض التجريبي.</span><button aria-label="إغلاق المثال" onClick={()=>setToast(false)}><X size={14}/></button></div>:<button className="button button-secondary design-btn-sm" onClick={()=>setToast(true)}>إظهار التنبيه</button>}</Exhibit>
    </ExtraGrid>
  </>;

  if (section === "text") return <ExtraGrid title="تفاصيل الشروح والتنبيهات" detail="مساعدة قصيرة قابلة للقراءة دون إطالة الصفحات.">
    <Exhibit code="ن-11" title="مساعدة تظهر عند المرور أو التركيز"><div className="design-ex-inline"><span>عدد القصاصات</span><button type="button" className="design-ex-tooltip" aria-label="شرح عدد القصاصات">؟<span role="tooltip">العدد الصحيح للقصاصات المستلمة.</span></button></div></Exhibit>
    <Exhibit code="ن-12" title="تنبيه مع إجراء جانبي"><div className="design-ex-alert"><AlertTriangle size={15}/><span>يحتاج هذا الحقل إلى مراجعة.</span><button className="button button-secondary design-btn-sm" type="button">مراجعة</button></div></Exhibit>
    <Exhibit code="ن-13" title="تلميح نصي أسفل الحقل"><label className="design-field">رقم المرجع<input placeholder="اكتب الرقم"/><small className="design-ex-muted">هذا الرقم يساعد على البحث لاحقًا.</small></label></Exhibit>
    <Exhibit code="ن-14" title="ملخص صغير قابل للفتح"><details className="design-ex-accordion"><summary>لماذا تظهر هذه المعلومة؟ <ChevronDown size={14}/></summary><p>يمكن إخفاء الشرح الطويل في التفاصيل وإبقاؤه متاحًا عند الطلب.</p></details></Exhibit>
  </ExtraGrid>;
  return null;
}
