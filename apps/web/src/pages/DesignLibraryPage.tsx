import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import {
  AlertTriangle, Bell, Check, CheckCircle2, ChevronDown,
  CircleHelp, Copy, FileText, Info, Layers, ListFilter, MoreHorizontal,
  Plus, Search, Settings2, ShieldAlert,
} from "lucide-react";
import "./DesignLibraryPage.css";

type SectionKey = "fields" | "buttons" | "colors" | "surfaces" | "tables" | "text";
const sections: { key: SectionKey; title: string; detail: string; symbol: string }[] = [
  { key: "fields", title: "الحقول والاختيارات", detail: "الكتابة والبحث والقوائم والتواريخ والاختيارات", symbol: "ح" },
  { key: "buttons", title: "الأزرار والإجراءات", detail: "أنواع الأزرار وحالاتها وأحجامها ومجموعاتها", symbol: "ز" },
  { key: "colors", title: "الألوان والشارات", detail: "ألوان المظهر والحالات والشارات والتمييز", symbol: "ل" },
  { key: "surfaces", title: "البطاقات والأقسام", detail: "البطاقات واللوحات والأحزمة والتبويبات", symbol: "ق" },
  { key: "tables", title: "الجداول والقوائم", detail: "أعمدة وصفوف وجداول وإجراءات مصغّرة", symbol: "ج" },
  { key: "text", title: "النصوص والتنبيهات", detail: "العناوين والشروح والرسائل ومؤشرات التقدم", symbol: "ن" },
];

function Sample({ code, title, note, children }: {
  code: string; title: string; note?: string; children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(title + " — " + code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return <article className="design-sample">
    <header className="design-sample-heading">
      <div><strong>{title}</strong><span className="design-sample-code">{code}</span></div>
      <button type="button" className="design-copy" onClick={() => void copy()} title="انسخ اسم النموذج ورمزه" aria-label={"نسخ " + title}>
        {copied ? <Check size={14}/> : <Copy size={14}/>} {copied ? "نُسخ" : "نسخ الاسم"}
      </button>
    </header>
    <div className="design-sample-body">{children}</div>
    {note && <p className="design-sample-note">{note}</p>}
  </article>;
}
function Group({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return <section className="design-group"><div className="design-group-heading"><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
    <div className="design-sample-grid">{children}</div></section>;
}
function Swatch({ name, token, description }: { name: string; token: string; description: string }) {
  return <div className="design-swatch">
    <span className="design-swatch-color" style={{ background: "var(" + token + ")" }}/>
    <span><strong>{name}</strong><small>{description}</small></span>
  </div>;
}
function DemoFields() {
  const [choice, setChoice] = useState("الفعال");
  const [checked, setChecked] = useState(true);
  const [radio, setRadio] = useState("الأول");
  return <>
    <Group title="الكتابة والبحث" subtitle="أمثلة حقيقية يمكن الكتابة داخلها، ولا تُحفظ في بيانات الموقع.">
      <Sample code="ح-01" title="حقل نصي عادي — متوسط"><label className="design-field">اسم الصنف<input placeholder="اكتب الاسم هنا"/></label></Sample>
      <Sample code="ح-02" title="حقل بحث بأيقونة"><label className="design-field">البحث في الأصناف<span className="design-input-wrap"><Search size={15}/><input type="search" placeholder="اسم الصنف أو الرمز"/></span></label></Sample>
      <Sample code="ح-03" title="حقل رقمي"><label className="design-field">الكمية<input type="number" min="0" placeholder="0"/></label></Sample>
      <Sample code="ح-04" title="حقل متعدد الأسطر"><label className="design-field">الملاحظات<textarea rows={2} placeholder="اكتب شرحًا مختصرًا"/></label></Sample>
      <Sample code="ح-05" title="حقول بأحجام مختلفة" note="صغير، متوسط، كبير؛ ويمكن طلب الحجم مع الاسم."><div className="design-stack"><input className="design-size-sm" placeholder="صغير"/><input placeholder="متوسط"/><input className="design-size-lg" placeholder="كبير"/></div></Sample>
      <Sample code="ح-06" title="حقل معطّل أو للقراءة"><div className="design-stack"><input value="للقراءة فقط" readOnly aria-label="للقراءة فقط"/><input disabled value="غير متاح" aria-label="حقل معطل" readOnly/></div></Sample>
    </Group>
    <Group title="الاختيارات والملفات" subtitle="أنواع الحقول التي لا تتطلب كتابة نصية مباشرة.">
      <Sample code="ح-07" title="قائمة منسدلة"><label className="design-field">حالة الصنف<select value={choice} onChange={e => setChoice(e.target.value)}><option>الفعال</option><option>المؤرشف</option><option>الكل</option></select></label></Sample>
      <Sample code="ح-08" title="اختيار متعدد بعلامات"><div className="design-stack"><label className="design-check"><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)}/> إظهار الأصناف المتوفرة</label><label className="design-check"><input type="checkbox"/> إظهار المؤرشفة</label></div></Sample>
      <Sample code="ح-09" title="اختيار واحد دائري"><div className="design-stack">{["الأول","الثاني"].map(v=><label className="design-check" key={v}><input type="radio" name="design-radio" checked={radio===v} onChange={() => setRadio(v)}/>{v}</label>)}</div></Sample>
      <Sample code="ح-10" title="مفتاح تشغيل وإيقاف"><label className="design-toggle"><input type="checkbox" defaultChecked/><span className="design-switch-track"/><span>تفعيل التنبيهات</span></label></Sample>
      <Sample code="ح-11" title="حقل تاريخ"><label className="design-field">اختر التاريخ<input type="date" defaultValue="2026-11-14"/></label></Sample>
      <Sample code="ح-12" title="اختيار ملف"><label className="design-field">إرفاق مستند<input type="file" aria-label="إرفاق مستند"/></label></Sample>
    </Group>
  </>;
}
function DemoButtons() {
  const [last, setLast] = useState("");
  return <>
    <Group title="أنواع الأزرار" subtitle="كل زر هنا للتجربة فقط، ولن ينشئ أي مستند أو يحذف شيئًا.">
      <Sample code="ز-01" title="زر أساسي"><button className="button button-primary" onClick={() => setLast("الزر الأساسي")}>حفظ التغيير</button></Sample>
      <Sample code="ز-02" title="زر ثانوي"><button className="button button-secondary" onClick={() => setLast("الزر الثانوي")}>عرض الكشف</button></Sample>
      <Sample code="ز-03" title="زر خفيف"><button className="button button-ghost" onClick={() => setLast("الزر الخفيف")}>المزيد</button></Sample>
      <Sample code="ز-04" title="زر تحذيري"><button className="button button-danger" onClick={() => setLast("الزر التحذيري")}>حذف تجريبي</button></Sample>
      <Sample code="ز-05" title="زر بإيقونة ونص"><button className="button button-primary" onClick={() => setLast("زر الإضافة")}><Plus size={15}/> إضافة جديد</button></Sample>
      <Sample code="ز-06" title="زر أيقونة فقط"><button className="button button-secondary design-icon-only" title="إعدادات — نموذج" aria-label="إعدادات — نموذج" onClick={() => setLast("زر الإعدادات")}><Settings2 size={16}/></button></Sample>
    </Group>
    <Group title="الأحجام والحالات" subtitle="اختيار الحجم مستقل عن نوع الزر.">
      <Sample code="ز-07" title="أحجام الأزرار"><div className="design-inline"><button className="button button-secondary design-btn-sm" onClick={() => setLast("زر صغير")}>صغير</button><button className="button button-secondary" onClick={() => setLast("زر متوسط")}>متوسط</button><button className="button button-secondary design-btn-lg" onClick={() => setLast("زر كبير")}>كبير</button></div></Sample>
      <Sample code="ز-08" title="زر معطّل"><button className="button button-secondary" disabled>غير متاح</button></Sample>
      <Sample code="ز-09" title="مجموعة أزرار متصلة"><div className="design-segments"><button className="active" onClick={() => setLast("اليوم")}>اليوم</button><button onClick={() => setLast("الأسبوع")}>الأسبوع</button><button onClick={() => setLast("الشهر")}>الشهر</button></div></Sample>
      <Sample code="ز-10" title="زر بأيقونة قائمة"><button className="button button-secondary" onClick={() => setLast("إجراءات")}><MoreHorizontal size={16}/> إجراءات <ChevronDown size={13}/></button></Sample>
      <Sample code="ز-11" title="زر تنقل لصفحة"><Link className="button button-secondary" to="/design-library/fields"><FileText size={14}/> افتح قسم الحقول</Link></Sample>
      <Sample code="ز-12" title="نتيجة التفاعل"><p className="design-result" aria-live="polite">{last ? "تم ضغط: " + last : "اضغط أي زر لمعاينة الاستجابة هنا."}</p></Sample>
    </Group>
  </>;
}
function DemoColors() {
  const kinds = ["أساسي","ثانوي","نجاح","تحذير","خطر","معلومات"];
  return <>
    <Group title="لوحة ألوان المظهر" subtitle="تتغير الألوان تلقائيًا بحسب الوضع الفاتح أو الداكن ولون التمييز الذي يختاره المستخدم.">
      <Sample code="ل-01" title="ألوان الواجهة"><div className="design-swatch-grid">
        <Swatch name="لون التمييز" token="--primary" description="زر أساسي وتحديد"/>
        <Swatch name="خلفية الصفحة" token="--bg" description="السطح الخارجي"/>
        <Swatch name="سطح البطاقة" token="--surface" description="البطاقات والألواح"/>
        <Swatch name="خلفية الحقل" token="--field-bg" description="الإدخال والاختيار"/>
        <Swatch name="خلفية هادئة" token="--soft" description="تظليل ثانوي"/>
        <Swatch name="لون التركيز" token="--focus" description="الحقل أو الزر النشط"/>
      </div></Sample>
      <Sample code="ل-02" title="ألوان الدلالة"><div className="design-swatch-grid">
        <Swatch name="نجاح" token="--success-solid" description="عملية ناجحة"/>
        <Swatch name="تحذير" token="--warning-solid" description="تنبيه يحتاج انتباه"/>
        <Swatch name="خطر" token="--error-solid" description="خطأ أو حذف"/>
        <Swatch name="معلومات" token="--info-solid" description="مساعدة وتوضيح"/>
      </div></Sample>
    </Group>
    <Group title="الشارات والعلامات" subtitle="صغيرة ومناسبة للجداول والكروت، وهي ليست أزرارًا.">
      <Sample code="ل-03" title="شارة ممتلئة"><div className="design-inline">{kinds.map((v,i)=><span key={v} className={"design-badge design-badge-solid design-badge-" + (i%4)}>{v}</span>)}</div></Sample>
      <Sample code="ل-04" title="شارة خفيفة"><div className="design-inline">{["جديد","مراجع","منجز","مؤجل"].map(v=><span key={v} className="design-badge design-badge-soft">{v}</span>)}</div></Sample>
      <Sample code="ل-05" title="شارة بإطار"><div className="design-inline">{["إداري","مبيعات","تقارير"].map(v=><span key={v} className="design-badge design-badge-outline">{v}</span>)}</div></Sample>
      <Sample code="ل-06" title="شارة مع نقطة"><div className="design-inline"><span className="design-badge design-badge-dot"><i/>متاح</span><span className="design-badge design-badge-dot"><i/>قيد المتابعة</span></div></Sample>
      <Sample code="ل-07" title="عداد عدد"><div className="design-inline"><span className="design-count">8</span><span className="design-count design-count-accent">24</span></div></Sample>
      <Sample code="ل-08" title="شارة بحجمين"><div className="design-inline"><span className="design-badge design-badge-soft design-badge-sm">صغيرة</span><span className="design-badge design-badge-soft">متوسطة</span></div></Sample>
    </Group>
  </>;
}
function DemoSurfaces() {
  return <>
    <Group title="البطاقات واللوحات" subtitle="الفرق بين بطاقة تحمل معلومة، ولوحة تحتوي مجموعة أدوات أو بيانات.">
      <Sample code="ق-01" title="بطاقة عادية"><div className="design-card-surface"><strong>رصيد الصندوق</strong><p>ملخص مستقل داخل بطاقة</p></div></Sample>
      <Sample code="ق-02" title="بطاقة بإطار بارز"><div className="design-card-surface design-card-emphasis"><strong>بطاقة مهمة</strong><p>تظهر بحد أقوى من بقية البطاقات.</p></div></Sample>
      <Sample code="ق-03" title="بطاقة رقمية"><div className="design-stat"><span>عدد المستندات</span><strong>١٢٨</strong><small>مثال للعرض فقط</small></div></Sample>
      <Sample code="ق-04" title="لوحة بعنوان وأدوات"><div className="design-panel"><div className="design-panel-head"><strong>لوحة المتابعة</strong><button className="button button-secondary design-btn-sm" type="button">تصفية</button></div><p>توضع الأدوات والبيانات المرتبطة داخل لوحة واحدة.</p></div></Sample>
    </Group>
    <Group title="الأحزمة والتقسيم" subtitle="تنظيم الصفحة دون زيادة كبيرة في الهوامش أو ارتفاع الشاشات.">
      <Sample code="ق-05" title="حزام معلومات"><div className="design-band"><Info size={16}/><span>هذا حزام يعرض معلومة سريعة أعلى القسم.</span></div></Sample>
      <Sample code="ق-06" title="حزام إجراءات"><div className="design-band design-band-actions"><strong>إجراءات المجموعة</strong><button className="button button-secondary design-btn-sm" type="button"><Plus size={13}/> إضافة</button><button className="button button-ghost design-btn-sm" type="button">المزيد</button></div></Sample>
      <Sample code="ق-07" title="تبويبات داخل لوحة"><div className="design-tabs"><span className="selected">الكل</span><span>مفتوح</span><span>منجز</span></div><p className="design-hint">نموذج لشكل التبويبات داخل قسم واحد.</p></Sample>
      <Sample code="ق-08" title="قسم قابل للطي"><details className="design-collapse"><summary>عرض تفاصيل القسم</summary><p>تظهر التفاصيل عند الضغط مع الاحتفاظ بمساحة الصفحة.</p></details></Sample>
      <Sample code="ق-09" title="بطاقتان متجاورتان"><div className="design-two-col"><div className="design-card-surface">بطاقة أولى</div><div className="design-card-surface">بطاقة ثانية</div></div></Sample>
      <Sample code="ق-10" title="فاصل بين الأقسام"><div className="design-rule"><span>عنوان القسم التالي</span></div></Sample>
    </Group>
  </>;
}
function DemoTables() {
  return <>
    <Group title="أشكال الجداول" subtitle="أمثلة ببيانات وهمية، لا تعرض بيانات فعلية ولا تحفظ تعديلات.">
      <Sample code="ج-01" title="جدول عادي"><div className="design-table-scroll"><table className="design-table"><thead><tr><th>الصنف</th><th>الكمية</th><th>الحالة</th></tr></thead><tbody><tr><td>صنف تجريبي أ</td><td>12</td><td>فعال</td></tr><tr><td>صنف تجريبي ب</td><td>4</td><td>مؤرشف</td></tr></tbody></table></div></Sample>
      <Sample code="ج-02" title="جدول مضغوط"><div className="design-table-scroll"><table className="design-table design-table-dense"><thead><tr><th>رقم</th><th>اسم</th><th>رصيد</th></tr></thead><tbody>{[1,2,3,4].map(i=><tr key={i}><td>{i}</td><td>عنصر تجريبي {i}</td><td>{i*10}</td></tr>)}</tbody></table></div></Sample>
      <Sample code="ج-03" title="جدول بخطوط متناوبة"><div className="design-table-scroll"><table className="design-table design-table-striped"><thead><tr><th>المستخدم</th><th>الوقت</th></tr></thead><tbody><tr><td>مثال أول</td><td>09:00</td></tr><tr><td>مثال ثانٍ</td><td>10:00</td></tr><tr><td>مثال ثالث</td><td>11:00</td></tr></tbody></table></div></Sample>
      <Sample code="ج-04" title="جدول مع حالة وإجراء"><div className="design-table-scroll"><table className="design-table"><thead><tr><th>المهمة</th><th>الحالة</th><th>الإجراء</th></tr></thead><tbody><tr><td>متابعة تجريبية</td><td><span className="design-badge design-badge-soft">منجز</span></td><td><button className="design-icon-button" title="إجراءات" aria-label="إجراءات"><MoreHorizontal size={16}/></button></td></tr></tbody></table></div></Sample>
    </Group>
    <Group title="القوائم والتنقل" subtitle="طرق مختصرة لعرض العناصر دون فتح بطاقات ضخمة.">
      <Sample code="ج-05" title="قائمة عناصر"><div className="design-list"><div>الصنف الأول <span>12</span></div><div>الصنف الثاني <span>4</span></div><div>الصنف الثالث <span>8</span></div></div></Sample>
      <Sample code="ج-06" title="سطر مع إجراءات"><div className="design-list"><div><strong>طلب تجريبي</strong><button className="button button-secondary design-btn-sm">فتح</button></div></div></Sample>
      <Sample code="ج-07" title="شريط تصفية أعلى الجدول"><div className="design-inline"><button className="button button-secondary design-btn-sm"><ListFilter size={13}/> الفلاتر</button><label className="design-short-search"><Search size={13}/><input placeholder="بحث في النتائج"/></label></div></Sample>
      <Sample code="ج-08" title="تنقل بين الصفحات"><div className="design-pagination"><button>السابق</button><span className="selected">1</span><span>2</span><span>3</span><button>التالي</button></div></Sample>
    </Group>
  </>;
}
function DemoText() {
  return <>
    <Group title="الخطوط والعناوين" subtitle="درجات النص وأماكن استخدامها في الصفحة.">
      <Sample code="ن-01" title="عناوين متدرجة"><div className="design-stack"><h2 className="design-title-lg">عنوان الصفحة</h2><h3 className="design-title-md">عنوان القسم</h3><strong className="design-title-sm">عنوان البطاقة</strong></div></Sample>
      <Sample code="ن-02" title="نص أساسي ونص مساعد"><div className="design-stack"><p>هذا نص أساسي يشرح وظيفة عنصر.</p><p className="design-muted">وهذا نص مساعد بدرجة أقل من التباين.</p></div></Sample>
      <Sample code="ن-03" title="شرح مختصر بمساعدة"><p className="design-hint"><CircleHelp size={15}/> اضغط على علامة المساعدة لمعرفة التفاصيل دون ازدحام الصفحة.</p></Sample>
      <Sample code="ن-04" title="نص مميز داخل السياق"><p>تمت <mark className="design-mark">مراجعة الطلب</mark> بنجاح.</p></Sample>
    </Group>
    <Group title="التنبيهات والتقدم" subtitle="دلالات مستقلة عن لون المظهر الشخصي، مع نص واضح للحالة.">
      <Sample code="ن-05" title="رسالة نجاح"><div className="design-notice design-notice-success"><CheckCircle2 size={16}/> تم حفظ النموذج بنجاح (مثال فقط).</div></Sample>
      <Sample code="ن-06" title="رسالة تحذير"><div className="design-notice design-notice-warning"><AlertTriangle size={16}/> توجد بيانات تحتاج إلى مراجعة.</div></Sample>
      <Sample code="ن-07" title="رسالة خطأ"><div className="design-notice design-notice-error"><ShieldAlert size={16}/> تعذر تنفيذ المثال.</div></Sample>
      <Sample code="ن-08" title="رسالة معلومات"><div className="design-notice design-notice-info"><Info size={16}/> يمكن قراءة التفاصيل في وصف القسم.</div></Sample>
      <Sample code="ن-09" title="شريط تقدم"><div className="design-stack"><span className="design-muted">نسبة الإنجاز: 65%</span><div className="design-progress"><span style={{width:"65%"}}/></div></div></Sample>
      <Sample code="ن-10" title="تنبيه بعداد"><div className="design-inline"><Bell size={18}/><span>التنبيهات</span><span className="design-count design-count-accent">5</span></div></Sample>
    </Group>
  </>;
}
const contentBySection: Record<SectionKey, () => ReactNode> = {
  fields: DemoFields, buttons: DemoButtons, colors: DemoColors,
  surfaces: DemoSurfaces, tables: DemoTables, text: DemoText,
};

export default function DesignLibraryPage() {
  const { section } = useParams<{section?: string}>();
  const selected = sections.find(item=>item.key===section) ?? sections[0];
  const Content = contentBySection[selected.key];
  const position = sections.findIndex(item=>item.key===selected.key);
  const next = sections[(position+1)%sections.length];
  return <div className="design-library" dir="rtl">
    <div className="design-library-head">
      <div><h1><Layers size={21}/> مكتبة التصاميم</h1><p>مرجع المالك لأشكال الموقع، بأسماء عربية ثابتة وأمثلة قابلة للتجربة.</p></div>
      <span className="design-library-private"><Check size={14}/> للمالك فقط</span>
    </div>
    <div className="design-library-tip"><Info size={16}/><span>للطلب لاحقًا قل مثلًا: «أريد زر ز-02 صغير» أو «اجعل الحقل مثل ح-07». كل الرموز ثابتة، والأمثلة هنا للعرض فقط ولا تغيّر بيانات الموقع.</span></div>
    <nav className="design-library-nav" aria-label="أقسام مكتبة التصاميم">
      {sections.map(item=><Link key={item.key} to={"/design-library/"+item.key}
        className={item.key===selected.key?"selected":""}
        aria-current={item.key===selected.key?"page":undefined}><span>{item.symbol}</span>{item.title}</Link>)}
    </nav>
    <div className="design-library-section-title"><div><h2>{selected.title}</h2><p>{selected.detail}</p></div>
      <span>الصفحة {position+1} من {sections.length}</span>
    </div>
    <Content/>
    <div className="design-library-bottom"><span>يمكن تغيير لون المظهر والوضع الفاتح أو الداكن من إعدادات المظهر أعلى الموقع.</span><Link className="button button-secondary" to={"/design-library/"+next.key}>التالي: {next.title}</Link></div>
  </div>;
}
