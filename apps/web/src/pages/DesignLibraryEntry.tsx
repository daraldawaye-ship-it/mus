import { useEffect, useId, useRef, useState } from "react";
import { Check, Minus, Pencil, Plus, X } from "lucide-react";
import { Example, Group, SectionIntro } from "./DesignLibraryWebartShared";
import "./DesignLibraryEntry.css";

// Original local demonstrations. Inputs never send, store, or alter business data.
const source = (slug: string) => `https://webartdevelopers.com/blog/${slug}/`;
const digits = (value: string) => value
  .replace(/[٠-٩]/g, char => String(char.charCodeAt(0) - 0x660))
  .replace(/[۰-۹]/g, char => String(char.charCodeAt(0) - 0x6f0));
const positiveInteger = (value: string) => /^[1-9]\d{0,5}$/.test(value);

function PhoneMask() {
  const [value, setValue] = useState("");
  const hintId = useId();
  const formatted = value.match(/.{1,3}/g)?.join(" ") ?? "";
  return <div className="wa-stack">
    <label className="wa-field">رقم الهاتف التجريبي
      <input type="tel" inputMode="numeric" autoComplete="off" dir="ltr"
        value={formatted} placeholder="000 000 000" aria-describedby={hintId}
        onChange={event => setValue(digits(event.target.value).replace(/\D/g, "").slice(0, 9))} />
    </label>
    <p id={hintId} className="wa-muted" role="status">{value.length === 9
      ? "اكتملت 9 أرقام في هذا المثال؛ لم يُتصل بالرقم."
      : `${value.length} من 9 أرقام؛ يقبل الأرقام العربية ويقسمها إلى مجموعات.`}</p>
  </div>;
}

function MonthYearMask() {
  const [value, setValue] = useState("");
  const hintId = useId();
  const match = /^(\d{2})\/(\d{4})$/.exec(value);
  const month = match ? Number(match[1]) : 0;
  const year = match ? Number(match[2]) : 0;
  const valid = !!match && month >= 1 && month <= 12 && year >= 1900 && year <= 2199;
  const names = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
  return <div className="wa-stack">
    <label className="wa-field">شهر وسنة الصلاحية
      <input type="text" inputMode="numeric" dir="ltr" value={value} placeholder="MM/YYYY"
        maxLength={7} aria-describedby={hintId} aria-invalid={value.length === 7 && !valid}
        onChange={event => {
          const next = digits(event.target.value).replace(/\D/g, "").slice(0, 6);
          setValue(next.length > 2 ? `${next.slice(0, 2)}/${next.slice(2)}` : next);
        }} />
    </label>
    <p id={hintId} className={value.length === 7 && !valid ? "we-error" : "wa-muted"} role="status">
      {valid ? `${names[month - 1]} ${year} — شهر وسنة فقط.` : value.length === 7
        ? "اكتب شهرًا من 01 إلى 12 وسنة من 1900 إلى 2199."
        : "مثال: 11/2027. يُضاف الفاصل بعد رقمَي الشهر."}
    </p>
  </div>;
}

function DecimalInput() {
  const [value, setValue] = useState("");
  const hintId = useId();
  const valid = /^-?\d+(?:\.\d{1,2})?$/.test(value);
  return <div className="wa-stack">
    <label className="wa-field">قيمة عشرية تجريبية
      <input type="text" inputMode="decimal" dir="ltr" value={value} maxLength={24}
        placeholder="12.50" aria-describedby={hintId} aria-invalid={!!value && !valid}
        onChange={event => setValue(digits(event.target.value).replace(/٫/g, "."))} />
    </label>
    <p id={hintId} className={value && !valid ? "we-error" : "wa-muted"} role="status">
      {!value ? "يقبل الأرقام العربية وعلامة عشرية واحدة؛ حتى منزلتين."
        : valid ? `القيمة كما أُدخلت: ${value}` : "اكتب رقمًا مثل 12.50 أو -12.50 دون فواصل آلاف."}
    </p>
  </div>;
}

function QuantityStepper() {
  const [value, setValue] = useState("6");
  const [step, setStep] = useState(6);
  const hintId = useId();
  const quantityId = useId();
  const valid = positiveInteger(value);
  const amount = valid ? Number(value) : 0;
  return <div className="wa-stack">
    <div className="we-two-fields">
      <div className="wa-field"><label htmlFor={quantityId}>الكمية التجريبية</label>
        <span className="we-stepper">
          <button type="button" className="button button-secondary button-compact" aria-label={`إنقاص ${step}`}
            disabled={!valid || amount - step < 1} onClick={() => setValue(String(amount - step))}><Minus size={14} /></button>
          <input id={quantityId} type="text" inputMode="numeric" dir="ltr" value={value} maxLength={6}
            aria-describedby={hintId} aria-invalid={!valid} onChange={event => setValue(digits(event.target.value))} />
          <button type="button" className="button button-secondary button-compact" aria-label={`زيادة ${step}`}
            disabled={!valid || amount + step > 999999} onClick={() => setValue(String(amount + step))}><Plus size={14} /></button>
        </span>
      </div>
      <label className="wa-field">خطوة الزيادة
        <select value={step} onChange={event => setStep(Number(event.target.value))}>
          {[1, 6, 12].map(option => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
    </div>
    <p id={hintId} className={valid ? "wa-muted" : "we-error"} role="status">{valid
      ? `كل ضغطة تغيّر الكمية بمقدار ${step}. الحد الأدنى في هذا المثال 1.`
      : "أدخل عددًا صحيحًا موجبًا من 1 إلى 999999."}</p>
  </div>;
}

function NumberRange() {
  const [from, setFrom] = useState("10");
  const [to, setTo] = useState("50");
  const hintId = useId();
  const numeric = /^\d{1,6}$/.test(from) && /^\d{1,6}$/.test(to);
  const valid = numeric && Number(from) <= Number(to);
  return <div className="wa-stack">
    <div className="we-two-fields">
      <label className="wa-field">الحد الأدنى
        <input type="text" inputMode="numeric" value={from} maxLength={6} dir="ltr"
          aria-describedby={hintId} aria-invalid={!valid} onChange={event => setFrom(digits(event.target.value))} />
      </label>
      <label className="wa-field">الحد الأعلى
        <input type="text" inputMode="numeric" value={to} maxLength={6} dir="ltr"
          aria-describedby={hintId} aria-invalid={!valid} onChange={event => setTo(digits(event.target.value))} />
      </label>
    </div>
    <p id={hintId} className={valid ? "wa-result" : "we-error"} role="status">{!numeric
      ? "أكمل الحدّين بأرقام صحيحة من 0 إلى 999999."
      : !valid ? "الحد الأدنى يجب ألا يتجاوز الحد الأعلى."
        : `نطاق تجريبي شامل: من ${from} إلى ${to}.`}</p>
  </div>;
}

const dependentChoices = {
  "مستلزمات": ["شاش تجريبي", "قفازات تجريبية", "كمامات تجريبية"],
  "أدوات قياس": ["ميزان تجريبي", "مقياس حرارة تجريبي"],
  "مواد تغليف": ["أكياس تجريبية", "علب تجريبية"],
};
type Category = keyof typeof dependentChoices;
function DependentChoices() {
  const [category, setCategory] = useState<Category>("مستلزمات");
  const [item, setItem] = useState(dependentChoices["مستلزمات"][0]);
  return <div className="wa-stack">
    <div className="we-two-fields">
      <label className="wa-field">التصنيف
        <select value={category} onChange={event => {
          const next = event.target.value as Category;
          setCategory(next);
          setItem(dependentChoices[next][0]);
        }}>{Object.keys(dependentChoices).map(key => <option key={key}>{key}</option>)}</select>
      </label>
      <label className="wa-field">النوع المتاح
        <select value={item} onChange={event => setItem(event.target.value)}>
          {dependentChoices[category].map(option => <option key={option}>{option}</option>)}
        </select>
      </label>
    </div>
    <p className="wa-result" role="status">{category} / {item}</p>
  </div>;
}

function TagEditor() {
  const [tags, setTags] = useState(["هام", "للمراجعة"]);
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState("");
  const hintId = useId();
  const add = () => {
    const tag = draft.trim();
    if (!tag) { setMessage("اكتب الوسم أولًا."); return; }
    if (tags.some(value => value.toLocaleLowerCase() === tag.toLocaleLowerCase())) { setMessage("هذا الوسم موجود في المثال."); return; }
    if (tags.length >= 5) { setMessage("الحد الأقصى في المثال 5 وسوم."); return; }
    setTags(old => [...old, tag]); setDraft(""); setMessage(`أُضيف الوسم: ${tag}.`);
  };
  return <div className="wa-stack">
    <div className="wa-inline we-tag-entry">
      <label className="wa-field">وسم جديد
        <input value={draft} maxLength={24} placeholder="اكتب ثم اضغط Enter" aria-describedby={hintId}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); add(); } }} />
      </label>
      <button type="button" className="button button-secondary button-compact" onClick={add}><Plus size={13} /> إضافة</button>
    </div>
    <div className="wa-inline we-tags" aria-label="الوسوم التجريبية">
      {tags.map(tag => <button type="button" key={tag} className="wa-chip" aria-label={`إزالة الوسم ${tag}`}
        onClick={() => { setTags(old => old.filter(value => value !== tag)); setMessage(`أُزيل الوسم: ${tag}.`); }}>
        {tag}<X size={12} /></button>)}
    </div>
    <p id={hintId} className="wa-muted" role="status">{message || "حتى 5 وسوم؛ اضغط الوسم لإزالته."}</p>
  </div>;
}

function TextCounter() {
  const [value, setValue] = useState("");
  const hintId = useId();
  return <div className="wa-stack">
    <label className="wa-field">ملاحظة قصيرة
      <textarea rows={3} value={value} maxLength={120} placeholder="اكتب ملاحظة توضيحية…"
        aria-describedby={hintId} onChange={event => setValue(event.target.value)} />
    </label>
    <div className="we-counter"><span id={hintId} className="wa-muted">حد النص 120 حرفًا</span>
      <output className={value.length === 120 ? "we-limit" : "wa-muted"} aria-live="polite">متبقي {120 - value.length}</output></div>
    <meter min={0} max={120} value={value.length} aria-label="طول الملاحظة من 120" />
  </div>;
}

function InlineEdit() {
  const [value, setValue] = useState("ملاحظة تجريبية قصيرة");
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const errorId = useId();
  useEffect(() => {
    if (editing) inputRef.current?.focus();
    else if (wasEditing.current) editRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  const cancel = () => { setEditing(false); setError(""); setMessage("أُلغي التعديل؛ بقيت القيمة السابقة."); };
  return <div className="wa-stack">
    {editing ? <form className="wa-stack" noValidate onSubmit={event => {
      event.preventDefault();
      if (!draft.trim()) { setError("اكتب ملاحظة قبل التأكيد."); inputRef.current?.focus(); return; }
      setValue(draft.trim()); setEditing(false); setError(""); setMessage("حُفظ التغيير داخل المثال فقط.");
    }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); cancel(); } }}>
      <label className="wa-field">تعديل الملاحظة
        <input ref={inputRef} value={draft} maxLength={80} aria-invalid={!!error} aria-describedby={error ? errorId : undefined}
          onChange={event => { setDraft(event.target.value); setError(""); }} />
      </label>
      {error && <p id={errorId} className="we-error" role="alert">{error}</p>}
      <div className="wa-inline"><button type="submit" className="button button-primary button-compact"><Check size={13} /> حفظ تجريبي</button>
        <button type="button" className="button button-secondary button-compact" onClick={cancel}>إلغاء</button></div>
    </form> : <div className="we-inline-record"><span>{value}</span>
      <button ref={editRef} type="button" className="button button-secondary button-compact" onClick={() => {
        setDraft(value); setError(""); setMessage(""); setEditing(true);
      }}><Pencil size={13} /> تعديل</button></div>}
    <p className="wa-muted" role="status">{message || "يفتح التعديل في مكان القيمة؛ Enter للحفظ وEscape للإلغاء."}</p>
  </div>;
}

type DemoLine = { id: number; name: string; quantity: string };
function DynamicRows() {
  const [rows, setRows] = useState<DemoLine[]>([{ id: 1, name: "مستلزم تجريبي أ", quantity: "2" }]);
  const [tried, setTried] = useState(false);
  const [message, setMessage] = useState("");
  const nextId = useRef(2);
  const prefix = useId();
  const update = (id: number, field: "name" | "quantity", value: string) => {
    setRows(old => old.map(row => row.id === id ? { ...row, [field]: value } : row));
    setMessage("");
  };
  return <form className="wa-stack" noValidate onSubmit={event => {
    event.preventDefault(); setTried(true);
    const valid = rows.length > 0 && rows.every(row => row.name.trim() && positiveInteger(row.quantity));
    setMessage(valid ? `تمت مراجعة ${rows.length} صفوف تجريبية بنجاح.` : "أكمل اسم كل صف وكمية صحيحة موجبة؛ أضف صفًا إن كانت القائمة فارغة.");
  }}>
    <div className="we-repeat-rows">
      {rows.map((row, index) => <div key={row.id} className="we-repeat-row">
        <label className="wa-field">اسم الصف {index + 1}
          <input value={row.name} maxLength={60} aria-invalid={tried && !row.name.trim()}
            aria-describedby={tried && !row.name.trim() ? `${prefix}-name-${row.id}` : undefined}
            onChange={event => update(row.id, "name", event.target.value)} />
          {tried && !row.name.trim() && <small id={`${prefix}-name-${row.id}`} className="we-error">الاسم مطلوب.</small>}
        </label>
        <label className="wa-field">الكمية
          <input type="text" inputMode="numeric" value={row.quantity} maxLength={6}
            aria-label={`كمية الصف ${index + 1}`} aria-invalid={tried && !positiveInteger(row.quantity)}
            aria-describedby={tried && !positiveInteger(row.quantity) ? `${prefix}-qty-${row.id}` : undefined}
            onChange={event => update(row.id, "quantity", digits(event.target.value))} />
          {tried && !positiveInteger(row.quantity) && <small id={`${prefix}-qty-${row.id}`} className="we-error">عدد موجب.</small>}
        </label>
        <button type="button" className="button button-secondary button-compact we-remove" aria-label={`حذف الصف ${index + 1}`}
          onClick={() => { setRows(old => old.filter(item => item.id !== row.id)); setMessage(""); }}><X size={14} /></button>
      </div>)}
      {!rows.length && <p className="wa-empty">القائمة فارغة. أضف صفًا لتجربة النموذج.</p>}
    </div>
    <div className="wa-inline"><button type="button" className="button button-secondary button-compact" disabled={rows.length >= 5} onClick={() => {
      const id = nextId.current++;
      setRows(old => [...old, { id, name: "", quantity: "1" }]); setMessage("");
    }}><Plus size={13} /> إضافة صف</button>
      <button type="submit" className="button button-primary button-compact">مراجعة الصفوف</button><span className="wa-muted">{rows.length} / 5</span></div>
    <p className="wa-muted" role="status">{message || "أضف أو احذف الصفوف؛ كل القيم داخل هذه المعاينة."}</p>
  </form>;
}

function ValidationSummary() {
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [message, setMessage] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const quantityRef = useRef<HTMLInputElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const prefix = useId();
  const nameError = !name.trim();
  const quantityError = !positiveInteger(quantity);
  const hasErrors = nameError || quantityError;
  useEffect(() => { if (attempt && hasErrors) summaryRef.current?.focus(); }, [attempt]);
  return <form className="wa-stack" noValidate onSubmit={event => {
    event.preventDefault(); setAttempt(value => value + 1);
    setMessage(hasErrors ? "" : "جميع الحقول صحيحة في هذا المثال. لم يُنشأ سجل.");
  }}>
    {attempt > 0 && hasErrors && <div ref={summaryRef} className="we-error-summary" tabIndex={-1} role="alert">
      <strong>راجع الحقول التالية</strong><ul>
        {nameError && <li><button type="button" onClick={() => nameRef.current?.focus()}>اسم الصنف مطلوب</button></li>}
        {quantityError && <li><button type="button" onClick={() => quantityRef.current?.focus()}>الكمية يجب أن تكون عددًا صحيحًا موجبًا</button></li>}
      </ul>
    </div>}
    <label className="wa-field">اسم الصنف التجريبي
      <input ref={nameRef} value={name} maxLength={60} required aria-invalid={attempt > 0 && nameError}
        aria-describedby={attempt > 0 && nameError ? `${prefix}-name` : undefined}
        onChange={event => { setName(event.target.value); setMessage(""); }} />
      {attempt > 0 && nameError && <small id={`${prefix}-name`} className="we-error">اكتب اسمًا.</small>}
    </label>
    <label className="wa-field">الكمية المطلوبة
      <input ref={quantityRef} type="text" inputMode="numeric" value={quantity} maxLength={6} required
        aria-invalid={attempt > 0 && quantityError} aria-describedby={attempt > 0 && quantityError ? `${prefix}-quantity` : undefined}
        onChange={event => { setQuantity(digits(event.target.value)); setMessage(""); }} />
      {attempt > 0 && quantityError && <small id={`${prefix}-quantity`} className="we-error">اكتب عددًا من 1 إلى 999999.</small>}
    </label>
    <button type="submit" className="button button-secondary button-compact">تحقق من النموذج</button>
    <p className="wa-muted" role="status">{message || "جرّب التحقق والحقول فارغة، ثم اضغط اسم الخطأ للانتقال إلى الحقل."}</p>
  </form>;
}

function StepForm() {
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("مستلزمات");
  const [quantity, setQuantity] = useState("1");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [finished, setFinished] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const quantityRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const errorId = useId();
  useEffect(() => {
    if (mounted.current) headingRef.current?.focus();
    mounted.current = true;
  }, [step, finished]);
  const reset = () => {
    setName(""); setCategory("مستلزمات"); setQuantity("1"); setNote(""); setError(""); setFinished(false); setStep(1);
  };
  return <div className="wa-stack">
    <ol className="we-steps" aria-label="خطوات الطلب التجريبي">{["البيانات", "التفاصيل", "المراجعة"].map((title, index) =>
      <li key={title} className={step === index + 1 ? "is-current" : step > index + 1 ? "is-done" : ""}
        aria-current={step === index + 1 ? "step" : undefined}><span>{step > index + 1 ? <Check size={12} /> : index + 1}</span>{title}</li>)}</ol>
    {finished ? <div className="wa-stack"><h3 ref={headingRef} className="we-step-title" tabIndex={-1}>اكتمل النموذج التجريبي</h3>
      <p className="wa-result" role="status">عُرض الطلب «{name}» بكمية {quantity} داخل المعاينة فقط.</p>
      <button type="button" className="button button-secondary button-compact" onClick={reset}>ابدأ تجربة جديدة</button>
    </div> : <form className="wa-stack" noValidate onSubmit={event => {
      event.preventDefault();
      if (step === 1 && !name.trim()) { setError("اكتب اسم الطلب قبل المتابعة."); nameRef.current?.focus(); return; }
      if (step === 2 && !positiveInteger(quantity)) { setError("أدخل كمية صحيحة موجبة من 1 إلى 999999."); quantityRef.current?.focus(); return; }
      setError("");
      if (step < 3) setStep(value => value + 1); else setFinished(true);
    }}>
      <h3 ref={headingRef} className="we-step-title" tabIndex={-1}>{["بيانات الطلب", "تفاصيل الطلب", "راجع قبل التأكيد"][step - 1]}</h3>
      {step === 1 && <>
        <label className="wa-field">اسم الطلب التجريبي
          <input ref={nameRef} value={name} maxLength={60} required aria-invalid={!!error}
            aria-describedby={error ? errorId : undefined} onChange={event => { setName(event.target.value); setError(""); }} />
        </label>
        <label className="wa-field">التصنيف
          <select value={category} onChange={event => setCategory(event.target.value)}>
            <option>مستلزمات</option><option>أدوات قياس</option><option>مواد تغليف</option>
          </select>
        </label>
      </>}
      {step === 2 && <>
        <label className="wa-field">الكمية
          <input ref={quantityRef} type="text" inputMode="numeric" value={quantity} maxLength={6} required
            aria-invalid={!!error} aria-describedby={error ? errorId : undefined}
            onChange={event => { setQuantity(digits(event.target.value)); setError(""); }} />
        </label>
        <label className="wa-field">ملاحظة اختيارية
          <textarea value={note} maxLength={120} rows={2} onChange={event => setNote(event.target.value)} />
        </label>
      </>}
      {step === 3 && <dl className="we-review"><dt>اسم الطلب</dt><dd>{name.trim()}</dd><dt>التصنيف</dt><dd>{category}</dd>
        <dt>الكمية</dt><dd>{quantity}</dd><dt>الملاحظة</dt><dd>{note.trim() || "لا توجد"}</dd></dl>}
      {error && <p className="we-error" role="alert" id={errorId}>{error}</p>}
      <div className="wa-inline">
        {step > 1 && <button type="button" className="button button-secondary button-compact" onClick={() => { setStep(value => value - 1); setError(""); }}>السابق</button>}
        <button type="submit" className="button button-primary button-compact">{step === 3 ? "تأكيد تجريبي" : "التالي"}</button>
      </div>
    </form>}
  </div>;
}

export default function DesignLibraryEntry() {
  const [revision, setRevision] = useState(0);
  return <div className="design-webart design-webart-entry">
    <SectionIntro onReset={() => setRevision(value => value + 1)}>
      أفكار الأقنعة والنماذج المتدرجة من <a href="https://webartdevelopers.com/blog/" target="_blank" rel="noopener noreferrer">WebArtDevelopers</a> بتصميم عربي يناسب الرئيسي.
    </SectionIntro>
    <div className="wa-stack we-groups" key={revision}>
      <Group title="الأرقام والصيغ المختصرة">
        <Example code="د-01" title="قناع رقم الهاتف" note="تجميع الأرقام أثناء الكتابة؛ لا اتصال أو إرسال." source={source("jquery-simple-mask")}><PhoneMask /></Example>
        <Example code="د-02" title="إدخال شهر وسنة" note="صلاحية بصيغة MM/YYYY مع تنبيه للشهر غير الصحيح." source={source("datable-js")}><MonthYearMask /></Example>
        <Example code="د-03" title="قيمة عشرية مع تحقق" note="يحافظ على النص والمدخلات غير الصحيحة لتصحيحها، دون تقريب." source={source("decimal-mask")}><DecimalInput /></Example>
        <Example code="د-04" title="كمية بخطوة قابلة للاختيار" note="زيادة ونقصان بمقدار وحدة تختارها؛ لا يغيّر كرت صنف." source={source("jquery-mask-as-number")}><QuantityStepper /></Example>
      </Group>
      <Group title="حقول مترابطة وتحرير سريع">
        <Example code="د-05" title="نطاق رقمي مترابط" note="يكشف انقلاب الحد الأدنى والأعلى مباشرة." source={source("jquery-masked-input")}><NumberRange /></Example>
        <Example code="د-06" title="قائمتان مترابطتان" note="عند تغيير التصنيف تتغير خيارات النوع وتُصفّر القيمة السابقة."><DependentChoices /></Example>
        <Example code="د-07" title="محرر وسوم قابل للإضافة" note="Enter للإضافة مع منع التكرار وإزالة الوسم بالضغط." source={source("fancy-multiple-select")}><TagEditor /></Example>
        <Example code="د-08" title="ملاحظة بعداد المتبقي" note="يبين المساحة المتاحة قبل بلوغ الحد الأقصى للنص."><TextCounter /></Example>
      </Group>
      <Group title="إكمال النموذج ومراجعته">
        <Example code="د-09" title="تعديل مباشر مع حفظ وإلغاء" note="الرجوع يحافظ على القيمة السابقة؛ الحفظ داخل المعاينة."><InlineEdit /></Example>
        <Example code="د-10" title="صفوف إدخال قابلة للتكرار" note="إضافة وحذف حتى 5 صفوف مع مراجعة الاسم والكمية."><DynamicRows /></Example>
        <Example code="د-11" title="ملخص أخطاء ينقل للحقل" note="اضغط الخطأ لنقل التركيز إلى الحقل المعني." source={source("jquery-masked-input")}><ValidationSummary /></Example>
        <Example code="د-12" title="نموذج خطوات مع مراجعة" note="التالي والسابق يحتفظان بالقيم؛ يمنع تجاوز الحقل الناقص." source={source("multi-step-form-with-progress-bar-using-jquery-and-css3")}><StepForm /></Example>
      </Group>
    </div>
  </div>;
}
