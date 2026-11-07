import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Building2,
  Check,
  ChevronLeft,
  FlaskConical,
  FileText,
  Heart,
  MessageCircle,
  Pencil,
  Pill,
  Plus,
  Search,
  ShieldCheck,
  Star,
  Users,
  X,
} from "lucide-react";
import { api, useScopeGuard, useSession } from "../api";
import { MarketImageUpload, prepareMarketImage } from "../MarketImageUpload";
import { MarketProductImage } from "../MarketProductImage";
import { errorMessage } from "../phase2";
import { Button, Card, Dialog, Field, Notice, Select } from "../ui";

import { isMarketAdministrativeKind } from "../../../../packages/contracts/src/medicine-market";
import type {
  MarketReferenceEntry,
  MarketKind as Kind,
  MarketFieldMeta as FieldDefinition,
  MarketMeta as Meta,
  MarketCard,
  MarketContribution as Contribution,
  MarketComment as Comment,
  MarketDetail as Detail,
} from "../../../../packages/contracts/src/medicine-market";
type Page<T> = { items: T[]; total: number; page: number; pageSize: number };
type Contact = { name: string; role?: string; phone: string };
type Ingredient = {
  scientificId: number;
  strength: string;
  unit: string;
  denominator?: string;
  denominatorUnit?: string;
};
type Mapping = { system: string; identifier: string };
const ROOT = "/medicine-market";
const statusLabels: Record<string, string> = {
  pending: "بانتظار المصادقة",
  approved: "معتمد",
  published: "منشور",
  rejected: "مرفوض",
  conflict: "تعارض يحتاج مراجعة",
};
const date = (v: string) =>
  new Intl.DateTimeFormat("ar-YE", {
    dateStyle: "medium",
    timeZone: "Asia/Aden",
  }).format(new Date(v));
const present = (v: unknown) =>
  v !== null &&
  v !== undefined &&
  v !== "" &&
  (!Array.isArray(v) || v.length > 0);
const readable = (v: unknown): string =>
  v === null || v === undefined || v === ""
    ? "غير مضاف"
    : typeof v === "boolean"
      ? v
        ? "نعم"
        : "لا"
      : Array.isArray(v)
        ? v
            .map((x) =>
              typeof x === "object" && x
                ? Object.entries(x)
                    .filter(([, value]) => present(value))
                    .map(([key, value]) =>
                      key === "scientificId"
                        ? `#${String(value)}`
                        : String(value),
                    )
                    .join(" · ")
                : String(x),
            )
            .join("\n")
        : typeof v === "object"
          ? Object.values(v).join(" · ")
          : String(v);
function KindIcon({ kind, size = 22 }: { kind: string; size?: number }) {
  return kind === "medicine" ? (
    <Pill size={size} />
  ) : kind === "prescription" ? (
    <FileText size={size} />
  ) : kind === "composition" || kind === "scientific-name" ? (
    <FlaskConical size={size} />
  ) : kind === "doctor" ? (
    <Users size={size} />
  ) : (
    <Building2 size={size} />
  );
}
function RelationName({
  id,
  onOpen,
}: {
  id: number;
  onOpen?: (id: number) => void;
}) {
  const { user } = useSession();
  const result = useQuery({
    queryKey: ["medicine-market", user?.id, "relation", id],
    queryFn: ({ signal }) => api<Detail>(`${ROOT}/cards/${id}`, { signal }),
    enabled: id > 0,
    staleTime: 60000,
  });
  const label = result.data?.card.name ?? `كرت #${id}`;
  return onOpen ? (
    <button
      type="button"
      className="medicine-market-link"
      onClick={() => onOpen(id)}
    >
      {label}
      <ChevronLeft size={13} />
    </button>
  ) : (
    <span>{label}</span>
  );
}
/**
 * Same typeahead conventions as invoice sales item search:
 * 3+ characters, short debounce, viewport-safe results, keyboard selection,
 * no stale suggestions, and paging. The query remains in the isolated market.
 */
function RelationPicker({
  kind,value,onChange,label,disabled=false,
}:{
  kind:Kind;
  value:number|null;
  onChange:(v:number|null)=>void;
  label:string;
  disabled?:boolean;
}){
  const {user}=useSession();
  const inputId=useId();
  const anchor=useRef<HTMLDivElement>(null);
  const popup=useRef<HTMLDivElement>(null);
  const [query,setQuery]=useState("");
  const [search,setSearch]=useState("");
  const [page,setPage]=useState(1);
  const [active,setActive]=useState(0);
  const [open,setOpen]=useState(false);
  const [placement,setPlacement]=useState({left:8,top:8,width:520,maxHeight:320});
  const enough=query.trim().length>=3;
  const expanded=open && !disabled && enough;
  const current=search===query.trim();
  useEffect(()=>{
    if(!open||!enough){setSearch("");return;}
    const timer=window.setTimeout(()=>{
      setSearch(query.trim());setPage(1);setActive(0);
    },60);
    return ()=>window.clearTimeout(timer);
  },[query,open,enough]);
  useEffect(()=>setActive(0),[page,search,kind]);
  useEffect(()=>{
    const dismiss=(event:PointerEvent)=>{
      if(anchor.current?.contains(event.target as Node) ||
        popup.current?.contains(event.target as Node))return;
      setOpen(false);
    };
    document.addEventListener("pointerdown",dismiss);
    return ()=>document.removeEventListener("pointerdown",dismiss);
  },[]);
  useLayoutEffect(()=>{
    if(!expanded)return;
    const position=()=>{
      const box=anchor.current?.getBoundingClientRect();
      if(!box)return;
      const viewportWidth=Math.max(320,window.innerWidth-16);
      const width=Math.min(Math.max(box.width,520),viewportWidth);
      const below=window.innerHeight-box.bottom-8;
      const above=box.top-8;
      const down=below>=Math.min(220,above);
      const maxHeight=Math.max(100,Math.min(320,down?below:above));
      const height=Math.min(popup.current?.scrollHeight??260,maxHeight);
      setPlacement({
        left:Math.max(8,Math.min(box.right-width,window.innerWidth-width-8)),
        top:down?box.bottom:Math.max(8,box.top-height),
        width,maxHeight,
      });
    };
    position();
    window.addEventListener("resize",position);
    window.addEventListener("scroll",position,true);
    return ()=>{
      window.removeEventListener("resize",position);
      window.removeEventListener("scroll",position,true);
    };
  },[expanded,search,page]);
  const data=useQuery({
    queryKey:["medicine-market",user?.id,"lookup",kind,search,page],
    queryFn:({signal})=>api<Page<MarketCard>>(
      `${ROOT}/cards?${new URLSearchParams({
        kind,q:search,page:String(page),pageSize:"20",
      })}`,{signal},
    ),
    enabled:expanded&&current&&search.length>=3,
    staleTime:30000,
  });
  const matches=current&&data.isSuccess?(data.data?.items??[]):[];
  const choose=(card:MarketCard)=>{
    onChange(card.id);setQuery("");setSearch("");setOpen(false);
    setPage(1);setActive(0);
  };
  return <div className="medicine-market-lookup" ref={anchor}>
    <div className="field">
      <label htmlFor={inputId}>بحث {label}</label>
      <input id={inputId} type="search" autoComplete="off"
        role="combobox" aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded?inputId+"-results":undefined}
        aria-activedescendant={expanded&&matches[active]?inputId+"-"+matches[active].id:undefined}
        placeholder={"اكتب ثلاثة أحرف أو أكثر للبحث عن "+label}
        value={query} disabled={disabled}
        onFocus={()=>setOpen(true)}
        onChange={event=>{
          setQuery(event.target.value);setOpen(true);setActive(0);
        }}
        onKeyDown={event=>{
          if(event.key==="Escape"){setOpen(false);return;}
          if(event.key==="ArrowDown"&&expanded){
            event.preventDefault();event.stopPropagation();
            setActive(i=>Math.min(matches.length-1,Math.max(i+1,0)));return;
          }
          if(event.key==="ArrowUp"&&expanded){
            event.preventDefault();event.stopPropagation();
            setActive(i=>Math.max(0,i-1));return;
          }
          if(event.key==="Enter"){
            event.preventDefault();event.stopPropagation();
            if(expanded&&current&&!data.isFetching&&matches[active])choose(matches[active]);
          }
        }}
      />
    </div>
    {expanded&&createPortal(
      <div className="medicine-market-lookup-results medicine-market-lookup-floating"
        ref={popup} style={{left:placement.left,top:placement.top,
          width:placement.width,maxHeight:placement.maxHeight}}
        role="region" aria-label={"نتائج بحث "+label}>
        <div id={inputId+"-results"} role="listbox">
          {matches.map((card,index)=><button type="button" key={card.id}
            id={inputId+"-"+card.id}
            className={index===active?"medicine-market-lookup-result is-active":"medicine-market-lookup-result"}
            role="option" aria-selected={index===active}
            disabled={disabled||!current}
            onMouseDown={event=>event.preventDefault()}
            onClick={()=>choose(card)}>
            <span className="medicine-market-lookup-result-names">
              <strong>{card.name}</strong>
              {typeof card.data.englishName==="string" &&
                card.data.englishName.trim()!==card.name.trim() &&
                <small dir="ltr">{card.data.englishName}</small>}
            </span>
            <small>#{card.id}</small>
          </button>)}
          {(!current||data.isFetching||data.isPending)&&
            <span className="medicine-market-lookup-status">جارٍ البحث…</span>}
          {current&&!data.isFetching&&!data.isError&&matches.length===0 &&
            <span className="medicine-market-lookup-status">لا توجد أصناف مطابقة</span>}
          {current&&data.error&&
            <span className="medicine-market-lookup-status text-error">{errorMessage(data.error)}</span>}
        </div>
        {current&&data.data&&<div className="medicine-market-lookup-pages">
          <button type="button" disabled={page<=1||data.isFetching}
            onMouseDown={event=>event.preventDefault()}
            onClick={()=>{setPage(p=>p-1);setActive(0);}}>السابق</button>
          <span>صفحة {page} من {Math.max(1,Math.ceil(data.data.total/20))}</span>
          <button type="button" disabled={page*20>=data.data.total||data.isFetching}
            onMouseDown={event=>event.preventDefault()}
            onClick={()=>{setPage(p=>p+1);setActive(0);}}>التالي</button>
        </div>}
      </div>,document.body)}
    {value!==null&&<div className="medicine-market-lookup-chosen">
      <span>المحدد: <RelationName id={value}/></span>
      <button type="button" disabled={disabled}
        onClick={()=>{onChange(null);setQuery("");setSearch("");setOpen(false);}}>إلغاء الاختيار</button>
    </div>}
  </div>;
}
function PrescriptionLinesEditor({
  value,onChange,disabled,
}:{
  value:unknown;
  onChange:(value:Array<number|null>)=>void;
  disabled:boolean;
}){
  const rows:Array<number|null>=Array.isArray(value)
    ?value.map(v=>typeof v==="number"&&Number.isInteger(v)&&v>0?v:null)
    :Array(4).fill(null);
  const resize=(next:number)=>{
    const count=Math.max(1,Math.min(20,next));
    onChange([...rows.slice(0,count),...Array(Math.max(0,count-rows.length)).fill(null)]);
  };
  return <div className="medicine-market-prescription-editor">
    <div className="medicine-market-prescription-count">
      <strong>عدد أسطر الأدوية: {rows.length}</strong>
      <div>
        <Button type="button" variant="secondary" size="compact"
          disabled={disabled||rows.length<=1} onClick={()=>resize(rows.length-1)}>− حذف سطر</Button>
        <Button type="button" variant="secondary" size="compact"
          disabled={disabled||rows.length>=20} onClick={()=>resize(rows.length+1)}>+ إضافة سطر</Button>
      </div>
    </div>
    <p className="medicine-market-muted">اختيار الأصناف اختياري. الأسطر غير المعروفة تبقى ظاهرة للجمهور لإكمالها أو تصحيحها لاحقًا.</p>
    {rows.map((id,index)=><div key={index} className="medicine-market-prescription-row">
      <strong>الدواء {index+1}</strong>
      <RelationPicker kind="medicine" label={"صنف السطر "+(index+1)}
        value={id} disabled={disabled}
        onChange={selected=>onChange(rows.map((v,i)=>i===index?selected:v))}/>
    </div>)}
  </div>;
}

function ReferencePicker({
  field, value, references, cardData, onChange, disabled,
}: {
  field: FieldDefinition;
  value: unknown;
  references: MarketReferenceEntry[];
  cardData: Record<string,unknown>;
  onChange: (v: unknown) => void;
  disabled: boolean;
}) {
  const referenceKind =
    field.key === "countryCode" ? "country" :
    field.key === "governorateCode" ? "governorate" : "city";
  const parentCode = referenceKind === "governorate"
    ? cardData.countryCode : referenceKind === "city"
      ? cardData.governorateCode : null;
  const options = references.filter(entry =>
    entry.kind === referenceKind &&
    (typeof parentCode !== "string" || entry.parentCode === parentCode));
  return <Select label={field.label} value={typeof value === "string" ? value : ""}
    disabled={disabled} onChange={event=>onChange(event.target.value || null)}>
    <option value="">اختر من القائمة الإدارية</option>
    {options.map(entry=> <option key={entry.code} value={entry.code}>{entry.name}</option>)}
    {typeof value === "string" && !options.some(entry=>entry.code===value) && (
      <option value={value}>{references.find(entry=>entry.code===value)?.name ?? value}</option>
    )}
  </Select>;
}
function FieldEditor({
  field,
  value,
  onChange,
  disabled,
  references = [],
  cardData = {},
  cardId,
  onImageBusyChange,
  cardKind,
}: {
  field: FieldDefinition;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled: boolean;
  references?: MarketReferenceEntry[];
  cardData?: Record<string,unknown>;
  cardId?:number;
  onImageBusyChange?:(busy:boolean)=>void;
  cardKind?:Kind;
}) {
  if(field.key==="image" && cardId)
    return <MarketImageUpload cardId={cardId} value={value} disabled={disabled}
      onChange={onChange} onBusyChange={onImageBusyChange}
      prescription={cardKind==="prescription"}/>;
  if(field.type==="prescription-lines")
    return <PrescriptionLinesEditor value={value} onChange={onChange} disabled={disabled}/>;
  if (field.type === "reference")
    return <ReferencePicker field={field} value={value} references={references}
      cardData={cardData} onChange={onChange} disabled={disabled}/>;
  if (field.type === "relation")
    return (
      <RelationPicker
        kind={field.relationKind ?? "agent"}
        value={typeof value === "number" ? value : null}
        onChange={onChange}
        label={field.label}
        disabled={disabled}
      />
    );
  if (field.type === "boolean")
    return (
      <label className="medicine-market-check">
        <input
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        {field.label}
      </label>
    );
  if (field.type === "contacts") {
    const rows = (Array.isArray(value) ? value : []) as Contact[];
    const update = (i: number, p: Partial<Contact>) =>
      onChange(rows.map((row, j) => (i === j ? { ...row, ...p } : row)));
    return (
      <div className="stack">
        <p className="medicine-market-muted">
          أضف اسم المسؤول ورقمه. بيانات الاتصال المعتمدة ستظهر في الكرت العام.
        </p>
        {rows.map((row, i) => (
          <fieldset key={i} className="medicine-market-repeating">
            <legend>جهة اتصال {i + 1}</legend>
            <Field
              label="اسم المسؤول"
              value={row.name}
              disabled={disabled}
              maxLength={160}
              onChange={(e) => update(i, { name: e.target.value })}
            />
            <Field
              label="الصفة"
              value={row.role ?? ""}
              disabled={disabled}
              maxLength={120}
              onChange={(e) => update(i, { role: e.target.value })}
            />
            <Field
              label="رقم الهاتف"
              type="tel"
              dir="ltr"
              value={row.phone}
              disabled={disabled}
              maxLength={40}
              onChange={(e) => update(i, { phone: e.target.value })}
            />
            <Button
              variant="ghost"
              size="compact"
              disabled={disabled}
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            >
              حذف الرقم
            </Button>
          </fieldset>
        ))}
        <Button
          variant="secondary"
          disabled={disabled || rows.length >= 20}
          onClick={() => onChange([...rows, { name: "", phone: "", role: "" }])}
        >
          <Plus size={15} /> إضافة مسؤول ورقم
        </Button>
      </div>
    );
  }
  if (field.type === "ingredients") {
    const rows = (Array.isArray(value) ? value : []) as Ingredient[];
    const update = (i: number, p: Partial<Ingredient>) =>
      onChange(rows.map((row, j) => (i === j ? { ...row, ...p } : row)));
    return (
      <div className="stack">
        <p className="medicine-market-muted">
          اختر كل اسم علمي وحدد قوته ووحدته. للسوائل يمكن إضافة المقام، مثل 250
          mg / 5 ml.
        </p>
        {rows.map((row, i) => (
          <fieldset key={i} className="medicine-market-repeating">
            <legend>المكوّن {i + 1}</legend>
            <RelationPicker
              kind="scientific-name"
              value={row.scientificId || null}
              label="الاسم العلمي"
              disabled={disabled}
              onChange={(v) => update(i, { scientificId: v ?? 0 })}
            />
            <div className="form-grid">
              <Field
                label="القوة"
                inputMode="decimal"
                dir="ltr"
                value={row.strength}
                disabled={disabled}
                maxLength={30}
                onChange={(e) => update(i, { strength: e.target.value })}
              />
              <Field
                label="الوحدة"
                dir="ltr"
                placeholder="mg"
                value={row.unit}
                disabled={disabled}
                maxLength={30}
                onChange={(e) => update(i, { unit: e.target.value })}
              />
              <Field
                label="المقام — اختياري"
                dir="ltr"
                inputMode="decimal"
                value={row.denominator ?? ""}
                disabled={disabled}
                maxLength={30}
                onChange={(e) => update(i, { denominator: e.target.value })}
              />
              <Field
                label="وحدة المقام"
                dir="ltr"
                placeholder="ml"
                value={row.denominatorUnit ?? ""}
                disabled={disabled}
                maxLength={30}
                onChange={(e) => update(i, { denominatorUnit: e.target.value })}
              />
            </div>
            <Button
              variant="ghost"
              disabled={disabled}
              size="compact"
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            >
              حذف المكوّن
            </Button>
          </fieldset>
        ))}
        <Button
          variant="secondary"
          disabled={disabled || rows.length >= 20}
          onClick={() =>
            onChange([...rows, { scientificId: 0, strength: "", unit: "mg" }])
          }
        >
          <Plus size={15} /> إضافة اسم علمي
        </Button>
      </div>
    );
  }
  if (field.type === "accounting") {
    const rows = (Array.isArray(value) ? value : []) as Mapping[];
    return (
      <div className="stack">
        <p className="medicine-market-muted">
          حتى ثمانية أنظمة. هذه معرفات إدارية محفوظة للربط المستقبلي.
        </p>
        {rows.map((row, i) => (
          <div key={i} className="medicine-market-map-row">
            <Field
              label={`النظام ${i + 1}`}
              value={row.system}
              disabled={disabled}
              maxLength={100}
              onChange={(e) =>
                onChange(
                  rows.map((v, j) =>
                    j === i ? { ...v, system: e.target.value } : v,
                  ),
                )
              }
            />
            <Field
              label="معرف الصنف في النظام"
              value={row.identifier}
              disabled={disabled}
              maxLength={100}
              onChange={(e) =>
                onChange(
                  rows.map((v, j) =>
                    j === i ? { ...v, identifier: e.target.value } : v,
                  ),
                )
              }
            />
            <Button
              variant="ghost"
              disabled={disabled}
              aria-label={`حذف النظام ${i + 1}`}
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            >
              <X size={16} />
            </Button>
          </div>
        ))}
        <Button
          variant="secondary"
          disabled={disabled || rows.length >= 8}
          onClick={() => onChange([...rows, { system: "", identifier: "" }])}
        >
          إضافة نظام
        </Button>
      </div>
    );
  }
  if (field.options?.length)
    return (
      <Select
        label={field.label}
        value={String(value ?? "")}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">غير محدد</option>
        {field.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </Select>
    );
  if (field.type === "textarea")
    return (
      <div className="field">
        <label htmlFor={`market-field-${field.key}`}>{field.label}</label>
        <textarea
          id={`market-field-${field.key}`}
          rows={5}
          value={String(value ?? "")}
          disabled={disabled}
          maxLength={10000}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  return (
    <Field
      label={field.label}
      value={String(value ?? "")}
      disabled={disabled}
      type={
        field.type === "date" ? "date" :
        field.type === "url" ? "url" :
        field.type === "mobile-phone" || field.type === "landline-phone" ? "tel" : "text"
      }
      inputMode={
        field.type === "mobile-phone" || field.type === "landline-phone" ? "numeric" :
        field.type === "decimal" || field.type === "percent" ? "decimal" : undefined
      }
      dir={
        field.type === "url" ||
        field.type === "mobile-phone" ||
        field.type === "landline-phone" ||
        field.type === "decimal" ||
        field.type === "percent"
          ? "ltr"
          : undefined
      }
      maxLength={field.type === "url" ? 2000 : field.type === "mobile-phone" ? 9 : field.type === "landline-phone" ? 8 : 1000}
      hint={
        field.type === "mobile-phone" ? "رقم موبايل واحد: يبدأ بـ7 ويتكون من 9 أرقام، دون مفتاح دولي" :
        field.type === "landline-phone" ? "رقم ثابت واحد: يبدأ بـ0 ويتكون من 8 أرقام، مثل 01371007" :
        field.type === "url"
          ? "رابط HTTPS للصورة أو الصفحة حسب اسم الحقل"
          : field.type === "percent"
            ? "نسبة من 0 إلى 100"
            : field.type === "decimal"
              ? "أدخل الرقم دون فواصل آلاف"
              : undefined
      }
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
function FieldValue({
  field,
  value,
  onOpen,
  references = [],
  cardKind,
}: {
  field: FieldDefinition;
  value: unknown;
  onOpen: (id: number) => void;
  references?: MarketReferenceEntry[];
  cardKind?:Kind;
}) {
  if (!present(value))
    return <span className="medicine-market-unset">أكمل هذه المعلومة</span>;
  if(field.type==="prescription-lines" && Array.isArray(value))
    return <ol className="medicine-market-prescription-list">
      {(value as Array<number|null>).map((v,i)=>
        <li key={i}><strong>السطر {i+1}</strong> {" "}
        {typeof v==="number"
          ?<RelationName id={v} onOpen={onOpen}/>
          :<span className="medicine-market-unset">صنف غير معروف — متاح لإكماله من الجمهور</span>}
        </li>)}
    </ol>;
  if (field.type === "reference" && typeof value === "string") {
    const reference = references.find(entry=>entry.code===value);
    return <span className="medicine-market-value-text">{reference?.name ?? value}</span>;
  }
  if (field.type === "relation" && typeof value === "number")
    return <RelationName id={value} onOpen={onOpen} />;
  if (field.type === "contacts" && Array.isArray(value))
    return (
      <div className="stack">
        {(value as Contact[]).map((v, i) => (
          <div key={i}>
            <strong>{v.name}</strong>
            {v.role && <span> · {v.role}</span>}
            <br />
            <a dir="ltr" href={`tel:${v.phone.replace(/[^+\d]/g, "")}`}>
              {v.phone}
            </a>
          </div>
        ))}
      </div>
    );
  if (field.type === "ingredients" && Array.isArray(value))
    return (
      <div className="stack">
        {(value as Ingredient[]).map((v, i) => (
          <div key={i}>
            <RelationName id={v.scientificId} onOpen={onOpen} />
            <span dir="ltr">
              {" "}
              {v.strength} {v.unit}
              {v.denominator
                ? ` / ${v.denominator} ${v.denominatorUnit ?? ""}`
                : ""}
            </span>
          </div>
        ))}
      </div>
    );
  if (field.key === "image" && typeof value === "string" &&
      (/^https:\/\//i.test(value) || /^\/api\/medicine-market\/images\/[a-f0-9-]{36}$/.test(value)))
    return <div className="medicine-market-prescription-image">
      <MarketProductImage src={value} trimLegacyPadding={cardKind!=="prescription"}
        alt={cardKind==="prescription"?"صورة الوصفة الطبية":"صورة الصنف"}
        style={{maxWidth:cardKind==="prescription"?"100%":260,maxHeight:cardKind==="prescription"?950:340,
          width:"auto",height:"auto",objectFit:"contain",borderRadius:8}}/>
      {cardKind==="prescription"&&<a href={value} target="_blank" rel="noopener noreferrer">
        فتح صورة الوصفة بالحجم الكامل
      </a>}
    </div>;
  if (
    field.type === "url" &&
    typeof value === "string" &&
    /^https:\/\//i.test(value)
  )
    return (
      <a href={value} target="_blank" rel="noopener noreferrer">
        فتح الرابط <ArrowLeft size={13} />
      </a>
    );
  return (
    <span className="medicine-market-value-text">
      {readable(value)}
      {field.type === "percent" ? " %" : ""}
    </span>
  );
}

export function MedicineMarketPage({
  tab = "catalog",
}: {
  tab?: "catalog" | "review" | "contributions" | "points";
}) {
  const { user } = useSession(),
    client = useQueryClient(),
    guard = useScopeGuard(`public:medicine-market:${tab}`);
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "",
    kind = params.get("kind") ?? "",
    page = Math.max(1, Number(params.get("page")) || 1),
    selected = Number(params.get("card")) || null;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const status =
      params.get("status") ?? (tab === "contributions" ? "" : "pending"),
    archived = params.get("archived") === "true";
  const [createOpen, setCreateOpen] = useState(false),
    [newKind, setNewKind] = useState<Kind>("medicine"),
    [newName, setNewName] = useState("");
  const [prescriptionFile,setPrescriptionFile]=useState<File|null>(null);
  const [prescriptionPhotoUrl,setPrescriptionPhotoUrl]=useState<string|null>(null);
  const [prescriptionLines,setPrescriptionLines]=useState<Array<number|null>>([null,null,null,null]);
  useEffect(()=>{
    if(!prescriptionFile){setPrescriptionPhotoUrl(null);return;}
    const preview=URL.createObjectURL(prescriptionFile);
    setPrescriptionPhotoUrl(preview);
    return ()=>URL.revokeObjectURL(preview);
  },[prescriptionFile]);
  const [edit, setEdit] = useState<{
    card: MarketCard;
    field: FieldDefinition;
    value: unknown;
    source: string;
  } | null>(null);
  const [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [imageUploading, setImageUploading] = useState(false);
  const [comment, setComment] = useState(""),
    [reviewReason, setReviewReason] = useState("");
  const [policy, setPolicy] = useState<{
    kind: Kind;
    field: FieldDefinition;
    add: string;
    edit: string;
  } | null>(null);
  const keys = useRef(new Map<string, { json: string; key: string }>());
  const meta = useQuery({
    queryKey: ["medicine-market", user?.id, "meta"],
    queryFn: ({ signal }) => api<Meta>(`${ROOT}/meta`, { signal }),
  });
  const permissions = meta.data?.permissions;
  const types = meta.data?.types ?? [];
  // Only public contribution cards are in the browse/create menus.
  const visibleTypes = types.filter(type=>!isMarketAdministrativeKind(type.key));
  const references = meta.data?.references ?? [];
  const currentType = types.find((t) => t.key === kind);
  const dosageList = useQuery({
    queryKey: ["medicine-market", user?.id, "fixed-dosage-forms"],
    queryFn: ({signal}) => api<Page<MarketCard>>(
      `${ROOT}/cards?kind=dosage-form&pageSize=100`, {signal}),
    enabled: tab === "catalog" && !!permissions?.canConfigure,
    staleTime: 60_000,
  });
  const write = (values: Record<string, string | null>) =>
    setParams((old) => {
      const p = new URLSearchParams(old);
      for (const [k, v] of Object.entries(values))
        if (v === null || v === "") p.delete(k);
        else p.set(k, v);
      return p;
    });
  const list = useQuery({
    queryKey: ["medicine-market", user?.id, "cards", kind, q, page, archived],
    queryFn: ({ signal }) =>
      api<Page<MarketCard>>(
        `${ROOT}/cards?${new URLSearchParams({ kind, q, page: String(page), pageSize: "18", archived: String(archived) })}`,
        { signal },
      ),
    enabled: tab === "catalog",
  });
  const detail = useQuery({
    queryKey: ["medicine-market", user?.id, "card", selected],
    queryFn: ({ signal }) =>
      api<Detail>(`${ROOT}/cards/${selected}`, { signal }),
    enabled: tab === "catalog" && selected !== null,
  });
  const contributions = useQuery({
    queryKey: ["medicine-market", user?.id, "contributions", tab, status, page],
    queryFn: ({ signal }) =>
      api<Page<Contribution>>(
        `${ROOT}/contributions?${new URLSearchParams({ status, mine: String(tab === "contributions"), page: String(page), pageSize: "20" })}`,
        { signal },
      ),
    enabled:
      !!user &&
      (tab === "contributions" ||
        (tab === "review" && !!permissions?.canModerate)),
  });
  const commentsQueue = useQuery({
    queryKey: ["medicine-market", user?.id, "comment-review", status, page],
    queryFn: ({ signal }) =>
      api<Page<Comment>>(
        `${ROOT}/comments?${new URLSearchParams({ status: status || "pending", page: String(page), pageSize: "20" })}`,
        { signal },
      ),
    enabled:
      tab === "review" && !!permissions?.canModerate && status !== "conflict",
  });
  const duplicate = useQuery({
    queryKey: ["medicine-market", user?.id, "duplicate", newKind, newName],
    queryFn: ({ signal }) =>
      api<Page<MarketCard>>(
        `${ROOT}/cards?kind=${newKind}&q=${encodeURIComponent(newName.trim())}&pageSize=5`,
        { signal },
      ),
    enabled: createOpen && newKind!=="prescription" && newName.trim().length >= 2,
  });
  const card = detail.data?.card;
  const fields = types.find((t) => t.key === card?.kind)?.fields ?? [];
  useEffect(() => {
    setCreateOpen(false);
    setEdit(null);
    setPolicy(null);
    setComment("");
    setMessage("");
    setError("");
    setBusy(false);
    keys.current.clear();
  }, [user?.id, tab]);
  function stableKey(action: string, payload: unknown) {
    const json = JSON.stringify(payload),
      old = keys.current.get(action);
    if (old?.json === json) return old.key;
    const key = crypto.randomUUID();
    keys.current.set(action, { json, key });
    return key;
  }
  async function mutate(
    action: () => Promise<unknown>,
    success: string,
    after?: () => void,
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    const requestGuard = guard;
    try {
      await action();
      if (!requestGuard.isCurrent()) return;
      after?.();
      setMessage(success);
      await client.invalidateQueries({
        queryKey: ["medicine-market", user?.id],
      });
    } catch (cause) {
      if (requestGuard.isCurrent()) setError(errorMessage(cause));
    } finally {
      if (requestGuard.isCurrent()) setBusy(false);
    }
  }
  const openCard = (id: number) => {
    write({ card: String(id) });
    setError("");
    setMessage("");
    setComment("");
  };
  async function create(event: FormEvent) {
    event.preventDefault();
    if (isMarketAdministrativeKind(newKind)) { setError("الكروت المرجعية ثابتة، ولا تُضاف من واجهة السوق"); return; }
    if(newKind==="prescription"){
      if(!prescriptionFile){setError("اختر صورة الوصفة أولًا");return;}
      const file=prescriptionFile;
      const lines=[...prescriptionLines];
      const signature={kind:newKind,fileName:file.name,fileSize:file.size,lastModified:file.lastModified,lines};
      await mutate(async()=>{
        const prepared=await prepareMarketImage(file,"prescription");
        const created=await api<{card:MarketCard}>(`${ROOT}/prescriptions`,{
          method:"POST",
          body:{idempotencyKey:stableKey("create-prescription",signature),
            imageDataUrl:prepared.dataUrl,prescriptionLines:lines},
        });
        if(guard.isCurrent())write({card:String(created.card.id),kind:"prescription",page:null});
      },"تم حفظ الوصفة للمراجعة الإدارية، ولا تظهر للجمهور حتى تُراجع الصورة وتعتمدها الإدارة.",()=>{
        setCreateOpen(false);setPrescriptionFile(null);
        setPrescriptionLines([null,null,null,null]);keys.current.delete("create-prescription");
      });
      return;
    }
    const payload = { kind: newKind, name: newName.trim() };
    await mutate(
      async () => {
        const result = await api<{
          card?: MarketCard;
          id?: number;
          status?: string;
        }>(`${ROOT}/cards`, {
          method: "POST",
          body: { ...payload, idempotencyKey: stableKey("create", payload) },
        });
        if (guard.isCurrent()) {
          const id = result.card?.id ?? result.id;
          if (id) write({ card: String(id), kind: newKind, page: null });
        }
      },
      "تم تسجيل الكرت. يمكنك متابعة إضافة الحقول المتوفرة.",
      () => {
        setCreateOpen(false);
        setNewName("");
        keys.current.delete("create");
      },
    );
  }
  async function saveField(event: FormEvent) {
    event.preventDefault();
    if (!edit || imageUploading) return;
    const payload = {
      fieldKey: edit.field.key,
      value: edit.value,
      expectedValue:
        edit.field.key === "name"
          ? edit.card.name
          : (edit.card.data[edit.field.key] ?? null),
      source: edit.source.trim() || undefined,
    };
    await mutate(
      () =>
        api(`${ROOT}/cards/${edit.card.id}/contributions`, {
          method: "POST",
          body: {
            ...payload,
            idempotencyKey: stableKey(
              `field:${edit.card.id}:${edit.field.key}`,
              payload,
            ),
          },
        }),
      "تم حفظ المساهمة. الأسعار والبونص والنقاط تنتظر المصادقة وفق صلاحياتك.",
      () => setEdit(null),
    );
  }
  function reviewContribution(
    row: Contribution,
    decision: "approve" | "reject",
  ) {
    void mutate(
      () =>
        api(`${ROOT}/contributions/${row.id}/review`, {
          method: "POST",
          body: { decision, reason: reviewReason.trim() || undefined },
        }),
      decision === "approve"
        ? "تم اعتماد المساهمة وفق سياسة النقاط."
        : "تم رفض المساهمة.",
    );
  }
  const fieldLabel = (k: Kind, key: string) =>
    types.find((t) => t.key === k)?.fields.find((f) => f.key === key)?.label ??
    (key === "name" ? "الاسم" : key);
  const pagination = (total: number, size: number) => (
    <div className="medicine-market-pagination">
      <span>
        {total} سجل · الصفحة {page}
      </span>
      <div>
        <Button
          variant="secondary"
          size="compact"
          disabled={page <= 1 || busy}
          onClick={() => write({ page: String(page - 1) })}
        >
          السابق
        </Button>
        <Button
          variant="secondary"
          size="compact"
          disabled={page * size >= total || busy}
          onClick={() => write({ page: String(page + 1) })}
        >
          التالي
        </Button>
      </div>
    </div>
  );
  const tabs: [string, string, boolean][] = [
    [ROOT, "الدليل", true],
    [`${ROOT}/contributions`, "مساهماتي", !!user],
    [`${ROOT}/review`, "المصادقة", !!permissions?.canModerate],
    [`${ROOT}/points`, "نقاط الحقول", true],
  ];
  const hasName = fields.some((f) => f.key === "name");
  return (
    <div className="medicine-market" dir="rtl">
      <header className="medicine-market-heading">
        <div className="medicine-market-brand">
          <span className="medicine-market-brand-icon">
            <Pill size={28} />
          </span>
          <div>
            <p className="medicine-market-eyebrow">الرئيسي / الموقع العام</p>
            <h1>سوق الأدوية</h1>
            <p>دليل نبنيه معًا، معلومةً بعد معلومة.</p>
          </div>
        </div>
        <div className="medicine-market-heading-actions">
          {user && (
            <span className="medicine-market-points">
              <Star size={16} /> {meta.data?.userPoints ?? "0"} نقطة معتمدة
            </span>
          )}
          {permissions?.canContribute ? (
            <Button
              onClick={() => {
                setNewKind(isMarketAdministrativeKind(kind as Kind) ? "medicine" : ((kind as Kind) || "medicine"));
                setNewName("");
                setCreateOpen(true);
                setError("");
              }}
            >
              <Plus size={17} /> إضافة كرت
            </Button>
          ) : !user ? (
            <Link className="button button-primary" to="/login">
              الدخول للمساهمة
            </Link>
          ) : (
            <span className="medicine-market-muted">
              المساهمة غير متاحة لحسابك
            </span>
          )}
        </div>
      </header>
      <nav className="medicine-market-tabs" aria-label="أقسام سوق الأدوية">
        {tabs
          .filter(([, , show]) => show)
          .map(([path, label]) => (
            <Link
              key={path}
              to={path}
              aria-current={
                (tab === "catalog" && path === ROOT) ||
                (tab !== "catalog" && path.endsWith(`/${tab}`))
                  ? "page"
                  : undefined
              }
            >
              {label}
            </Link>
          ))}
      </nav>
      {message && <Notice tone="success">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {meta.error && <Notice tone="error">{errorMessage(meta.error)}</Notice>}
      {tab === "catalog" && permissions?.canConfigure && (
        <section className="medicine-market-admin-references" aria-label="البيانات المرجعية الثابتة">
          <h2>البيانات المرجعية للإدارة</h2>
          <p className="medicine-market-muted">للاطلاع والاختيار فقط. إضافة وتصحيح القوائم تتم إداريًا، وليس من أزرار كروت المستخدمين.</p>
          <div className="medicine-market-reference-cards">
            <details>
              <summary>الدول ({references.filter(entry=>entry.kind==="country").length})</summary>
              <ul>{references.filter(entry=>entry.kind==="country").map(entry=>
                <li key={entry.code}>{entry.name}</li>)}</ul>
            </details>
            <details>
              <summary>المحافظات والمدن ({references.filter(entry=>entry.kind==="governorate").length} محافظة)</summary>
              <ul>{references.filter(entry=>entry.kind==="governorate").map(governorate=>
                <li key={governorate.code}>
                  <strong>{governorate.name}</strong>
                  {references.filter(city=>city.kind==="city" && city.parentCode===governorate.code)
                    .map(city=><span key={city.code}> — {city.name}</span>)}
                </li>)}</ul>
            </details>
            <details>
              <summary>الأشكال الصيدلانية ({dosageList.data?.total ?? 0})</summary>
              <ul>{dosageList.data?.items.map(card=><li key={card.id}>{card.name}</li>)}</ul>
            </details>
          </div>
        </section>
      )}
      {tab === "catalog" && (
        <>
          <div className="medicine-market-toolbar">
            <div className="medicine-market-search">
              <Search size={18} />
              <Field
                label="البحث في الدليل"
                type="search"
                value={q}
                placeholder="اسم الصنف، التركيب، الوكيل أو كلمة بحث…"
                onChange={(e) =>
                  write({ q: e.target.value, page: null, card: null })
                }
              />
            </div>
            <Select
              label="نوع الكرت"
              value={kind}
              onChange={(e) =>
                write({ kind: e.target.value, page: null, card: null })
              }
            >
              <option value="">جميع الكروت</option>
              {visibleTypes.map((t) => (
                <option value={t.key} key={t.key}>
                  {t.label}
                </option>
              ))}
            </Select>
            {permissions?.canModerate && (
              <label className="medicine-market-check">
                <input
                  type="checkbox"
                  checked={archived}
                  onChange={(e) =>
                    write({
                      archived: e.target.checked ? "true" : null,
                      page: null,
                    })
                  }
                />{" "}
                المؤرشف فقط
              </label>
            )}
          </div>
          <div
            className="medicine-market-category-bar"
            aria-label="تصفية الكروت"
          >
            {[{ key: "", label: "الكل" }, ...visibleTypes].map((t) => (
              <button
                key={t.key}
                type="button"
                className={kind === t.key ? "is-active" : ""}
                onClick={() => write({ kind: t.key, page: null, card: null })}
              >
                {t.key && <KindIcon kind={t.key} size={15} />} {t.label}
              </button>
            ))}
          </div>
          {selected ? (
            <Card className="medicine-market-detail">
              <div className="medicine-market-detail-top">
                <Button variant="ghost" onClick={() => write({ card: null })}>
                  <ArrowLeft size={16} /> العودة إلى القائمة
                </Button>
                {card && (
                  <span className="medicine-market-badge">كرت #{card.id}</span>
                )}
              </div>
              {detail.isLoading && <Notice>جارٍ تحميل الكرت…</Notice>}
              {detail.error && (
                <Notice tone="error">{errorMessage(detail.error)}</Notice>
              )}
              {card && (
                <>
                  <div className="medicine-market-detail-heading">
                    <span className="medicine-market-card-icon">
                      <KindIcon kind={card.kind} size={30} />
                    </span>
                    <div>
                      <span className="medicine-market-eyebrow">
                        {types.find((t) => t.key === card.kind)?.label}
                      </span>
                      <h2>{card.name}</h2>
                      <p>
                        {statusLabels[card.status] ?? card.status}
                        {card.archived ? " · مؤرشف" : ""} · آخر تحديث{" "}
                        {date(card.updatedAt)}
                      </p>
                    </div>
                  </div>
                  {card.status === "pending" && (
                    <Notice>
                      {card.kind==="prescription"
                        ?"الوصفة خاصة حاليًا. يمكن رفع صورة بديلة بعد إخفاء بيانات المريض. لا تظهر للعامة حتى تُراجع الإدارة الصورة الحالية وتعتمد النشر."
                        :"الكرت قيد المراجعة. تستطيع إضافة الحقول، ويظهر للعامة بعد اعتماد الاسم."}
                    </Notice>
                  )}
                  <div className="medicine-market-fields">
                    {!hasName && (
                      <div className="medicine-market-field">
                        <div>
                          <span className="medicine-market-field-label">
                            الاسم
                          </span>
                          <strong>{card.name}</strong>
                        </div>
                        {permissions?.canContribute && !isMarketAdministrativeKind(card.kind) && !card.archived && (
                          <Button
                            variant="ghost"
                            size="compact"
                            aria-label="اقتراح تعديل الاسم"
                            onClick={() =>
                              setEdit({
                                card,
                                field: {
                                  key: "name",
                                  label: "الاسم",
                                  type: "text",
                                  visibility: "public",
                                  points: { add: 0, edit: 0 },
                                  policyRevision: 0,
                                },
                                value: card.name,
                                source: "",
                              })
                            }
                          >
                            <Pencil size={15} />
                          </Button>
                        )}
                      </div>
                    )}
                    {fields.map((field) => (
                      <div
                        key={field.key}
                        className={`medicine-market-field ${field.visibility !== "public" ? "medicine-market-protected" : ""}`}
                      >
                        <div>
                          <span className="medicine-market-field-label">
                            {field.label}
                            {field.visibility !== "public" && (
                              <ShieldCheck size={13} />
                            )}
                          </span>
                          <FieldValue
                            field={field}
                            value={
                              field.key === "name"
                                ? card.name
                                : card.data[field.key]
                            }
                            onOpen={openCard}
                            references={references}
                            cardKind={card.kind}
                          />
                        </div>
                        {permissions?.canContribute && !isMarketAdministrativeKind(card.kind) && !card.archived && (
                          <Button
                            variant="ghost"
                            size="compact"
                            aria-label={`${present(card.data[field.key]) ? "تعديل" : "إضافة"} ${field.label}`}
                            title={`${present(card.data[field.key]) ? "تعديل" : "إضافة"} ${field.label}`}
                            onClick={() =>
                              setEdit({
                                card,
                                field,
                                value:
                                  field.key === "name"
                                    ? card.name
                                    : structuredClone(
                                        card.data[field.key] ??
                                          (field.type === "boolean"
                                            ? false
                                            : [
                                                  "contacts",
                                                  "ingredients",
                                                  "accounting",
                                                  "prescription-lines",
                                                ].includes(field.type)
                                              ? []
                                              : ""),
                                      ),
                                source: "",
                              })
                            }
                          >
                            <Pencil size={15} />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="medicine-market-engagement">
                    <Button
                      variant="secondary"
                      size="compact"
                      disabled={!permissions?.canContribute || busy}
                      aria-pressed={card.myLiked}
                      onClick={() =>
                        void mutate(
                          () =>
                            api(`${ROOT}/cards/${card.id}/reaction`, {
                              method: "PUT",
                              body: { liked: !card.myLiked },
                            }),
                          card.myLiked ? "أُلغي الإعجاب." : "تم تسجيل الإعجاب.",
                        )
                      }
                    >
                      <Heart
                        size={16}
                        fill={card.myLiked ? "currentColor" : "none"}
                      />{" "}
                      {card.likes} إعجاب
                    </Button>
                    <span>
                      <Star size={15} />{" "}
                      {card.ratingCount
                        ? `${Number(card.ratingAverage ?? 0).toFixed(1)} / 5 · ${card.ratingCount} تقييم`
                        : "لم يُقيّم بعد"}
                    </span>
                    {permissions?.canContribute && (
                      <Select
                        label="تقييمك"
                        value={card.myRating ?? ""}
                        disabled={busy}
                        onChange={(e) =>
                          void mutate(
                            () =>
                              api(`${ROOT}/cards/${card.id}/reaction`, {
                                method: "PUT",
                                body: {
                                  rating: e.target.value
                                    ? Number(e.target.value)
                                    : null,
                                },
                              }),
                            "تم تحديث تقييمك.",
                          )
                        }
                      >
                        <option value="">بدون تقييم</option>
                        {[1, 2, 3, 4, 5].map((n) => (
                          <option key={n} value={n}>
                            {n} / 5
                          </option>
                        ))}
                      </Select>
                    )}
                  </div>
                  {permissions?.canArchive && (
                    <div className="medicine-market-admin-action">
                      <Button
                        variant="secondary"
                        size="compact"
                        disabled={busy}
                        onClick={() =>
                          void mutate(
                            () =>
                              api(`${ROOT}/cards/${card.id}/archive`, {
                                method: "PATCH",
                                body: {
                                  archived: !card.archived,
                                  revision: card.revision,
                                },
                              }),
                            card.archived
                              ? "تمت إعادة الكرت إلى الدليل."
                              : "تمت أرشفة الكرت.",
                          )
                        }
                      >
                        {card.archived ? "إلغاء الأرشفة" : "أرشفة الكرت"}
                      </Button>
                    </div>
                  )}
                  {!!detail.data?.contributions.length && (
                    <details className="medicine-market-history">
                      <summary>
                        المساهمات وسجل تحديث المعلومات (
                        {detail.data.contributions.length})
                      </summary>
                      {detail.data.contributions.map((c) => (
                        <article
                          key={c.id}
                          className="medicine-market-history-row"
                        >
                          <div>
                            <strong>{c.fieldLabel}</strong>
                            <span className="medicine-market-badge">
                              {statusLabels[c.status]}
                            </span>
                            {c.published && c.status === "pending" && (
                              <small>
                                المعلومة منشورة، والنقاط بانتظار الاعتماد
                              </small>
                            )}
                          </div>
                          <p>
                            {c.authorName} · {date(c.createdAt)}
                            {c.source ? ` · المصدر: ${c.source}` : ""}
                          </p>
                          {c.status === "pending" && (
                            <p>المقترح: {readable(c.value)}</p>
                          )}
                          {c.reason && <p>ملاحظة المراجعة: {c.reason}</p>}
                        </article>
                      ))}
                    </details>
                  )}
                  <div className="medicine-market-comments">
                    <h3>
                      <MessageCircle size={18} /> التعليقات
                    </h3>
                    {detail.data?.comments.length === 0 && (
                      <p className="medicine-market-muted">
                        لا توجد تعليقات منشورة بعد.
                      </p>
                    )}
                    {detail.data?.comments.map((c) => (
                      <article className="medicine-market-comment" key={c.id}>
                        <div>
                          <strong>{c.authorName}</strong>
                          <time>
                            {date(c.createdAt)}
                            {c.status !== "approved"
                              ? ` · ${statusLabels[c.status]}`
                              : ""}
                          </time>
                        </div>
                        <p>{c.text}</p>
                      </article>
                    ))}
                    {permissions?.canContribute && !isMarketAdministrativeKind(card.kind) && !card.archived ? (
                      <form
                        className="stack"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const payload = { text: comment.trim() };
                          void mutate(
                            () =>
                              api(`${ROOT}/cards/${card.id}/comments`, {
                                method: "POST",
                                body: {
                                  ...payload,
                                  idempotencyKey: stableKey(
                                    `comment:${card.id}`,
                                    payload,
                                  ),
                                },
                              }),
                            "تم تسجيل تعليقك وفق آلية المصادقة.",
                            () => {
                              if (selectedRef.current === card.id)
                                setComment("");
                            },
                          );
                        }}
                      >
                        <label className="field" htmlFor="market-comment">
                          أضف تعليقًا
                          <textarea
                            id="market-comment"
                            rows={3}
                            maxLength={2000}
                            required
                            value={comment}
                            onChange={(e) => setComment(e.target.value)}
                            placeholder="معلومة مفيدة أو تصحيح يتعلق بهذا الكرت"
                          />
                        </label>
                        <div>
                          <Button
                            type="submit"
                            disabled={busy || !comment.trim()}
                          >
                            إرسال التعليق
                          </Button>
                        </div>
                      </form>
                    ) : (
                      !user && (
                        <p>
                          <Link to="/login">سجّل الدخول</Link> للمشاركة
                          والتعليق.
                        </p>
                      )
                    )}
                  </div>
                </>
              )}
            </Card>
          ) : (
            <>
              <div className="medicine-market-list-heading">
                <h2>{currentType?.label ?? "كروت الدليل"}</h2>
                <span>{list.data?.total ?? "—"} كرت</span>
              </div>
              {list.isLoading && <Notice>جارٍ تحميل الدليل…</Notice>}
              {list.error && (
                <Notice tone="error">{errorMessage(list.error)}</Notice>
              )}
              {list.data?.items.length === 0 && (
                <div className="medicine-market-empty">
                  <span>
                    <Pill size={42} />
                  </span>
                  <h2>{q ? "لا توجد نتائج مطابقة" : "نبدأ الدليل معًا"}</h2>
                  <p>
                    {q
                      ? "جرّب الاسم بالإنجليزية أو جزءًا منه، أو اختر نوعًا آخر."
                      : "أضف اسم الكرت أولًا، ثم أكمل المعلومات المتوفرة. كل مساهمة معتمدة تجعل الدليل أكثر فائدة."}
                  </p>
                  {permissions?.canContribute && (
                    <Button
                      onClick={() => {
                        setNewKind(isMarketAdministrativeKind(kind as Kind) ? "medicine" : ((kind as Kind) || "medicine"));
                        setNewName(q);
                        setCreateOpen(true);
                      }}
                    >
                      <Plus size={17} /> إضافة كرت
                    </Button>
                  )}
                </div>
              )}
              <div className="medicine-market-grid">
                {list.data?.items.map((item) => {
                  const type = types.find((t) => t.key === item.kind);
                  const previewFields =
                    type?.fields
                      .filter(
                        (f) =>
                          f.visibility === "public" &&
                          f.key !== "name" &&
                          present(item.data[f.key]) &&
                          ["text", "decimal", "percent", "relation"].includes(
                            f.type,
                          ),
                      )
                      .slice(0, 3) ?? [];
                  const image = item.data.image ?? item.data.imageUrl;
                  return (
                    <article className="medicine-market-card" key={item.id}>
                      <div className="medicine-market-card-head">
                        <span className="medicine-market-card-icon">
                          <KindIcon kind={item.kind} />
                        </span>
                        <span>{type?.label}</span>
                        <small>#{item.id}</small>
                      </div>
                      <button
                        className="medicine-market-card-title"
                        type="button"
                        onClick={() => openCard(item.id)}
                      >
                        {item.name}
                        <ChevronLeft size={17} />
                      </button>
                      {typeof image === "string" &&
                        (/^https:\/\//i.test(image) || /^\/api\/medicine-market\/images\/[a-f0-9-]{36}$/.test(image)) && (
                          <MarketProductImage
                            className="medicine-market-card-image"
                            trimLegacyPadding={item.kind!=="prescription"}
                            style={{display:"block",maxWidth:"100%",maxHeight:230,width:"auto",height:"auto",aspectRatio:"auto",objectFit:"contain",background:"transparent",marginInline:"auto"}}
                            src={image}
                            alt={item.name}
                          />
                        )}
                      {item.kind==="prescription" && Array.isArray(item.data.prescriptionLines) &&
                        <p className="medicine-market-muted">
                          {item.data.prescriptionLines.length} أسطر ·
                          {" "}{item.data.prescriptionLines.filter(x=>typeof x==="number").length} أصناف محددة
                        </p>}
                      <dl>
                        {previewFields.map((f) => (
                          <div key={f.key}>
                            <dt>{f.label}</dt>
                            <dd>
                              {f.type === "relation" &&
                              typeof item.data[f.key] === "number" ? (
                                <RelationName id={item.data[f.key] as number} />
                              ) : f.type === "reference" &&
                                  typeof item.data[f.key] === "string" ? (
                                references.find(v=>v.code===item.data[f.key])?.name ??
                                readable(item.data[f.key])
                              ) : (
                                readable(item.data[f.key])
                              )}
                              {f.type === "percent" ? " %" : ""}
                            </dd>
                          </div>
                        ))}
                      </dl>
                      {previewFields.length === 0 && (
                        <p className="medicine-market-card-incomplete">
                          المعلومات قيد الإكمال. ساهم بإضافة حقل.
                        </p>
                      )}
                      <div className="medicine-market-card-bottom">
                        <span>
                          <Heart size={13} /> {item.likes}{" "}
                          <MessageCircle size={13} />{" "}
                          {statusLabels[item.status] ?? "منشور"}
                          {item.archived ? " · مؤرشف" : ""}
                        </span>
                        <Button
                          variant="ghost"
                          size="compact"
                          onClick={() => openCard(item.id)}
                        >
                          فتح الكرت
                        </Button>
                      </div>
                    </article>
                  );
                })}
              </div>
              {list.data && pagination(list.data.total, 18)}
            </>
          )}
        </>
      )}
      {(tab === "review" || tab === "contributions") && (
        <>
          <div className="medicine-market-section-heading">
            <div>
              <h2>
                {tab === "review" ? "المصادقة على المساهمات" : "مساهماتي"}
              </h2>
              <p>
                {tab === "review"
                  ? "راجع كل حقل بصورة مستقلة. لا تُحتسب النقاط إلا بعد الاعتماد."
                  : "تابع حالة إضافاتك وتعديلاتك ونقاطها المعتمدة."}
              </p>
            </div>
            <Select
              label="الحالة"
              value={status}
              onChange={(e) => write({ status: e.target.value, page: null })}
            >
              {tab === "contributions" && (
                <option value="">جميع الحالات</option>
              )}
              {["pending", "approved", "rejected", "conflict"].map((s) => (
                <option key={s} value={s}>
                  {statusLabels[s]}
                </option>
              ))}
            </Select>
          </div>
          {!user ? (
            <Notice>سجّل الدخول لعرض هذه الصفحة.</Notice>
          ) : tab === "review" && !permissions?.canModerate ? (
            <Notice tone="warning">المصادقة متاحة للإدارة المخوّلة فقط.</Notice>
          ) : (
            <>
              {contributions.isLoading && (
                <Notice>جارٍ تحميل المساهمات…</Notice>
              )}
              {contributions.error && (
                <Notice tone="error">
                  {errorMessage(contributions.error)}
                </Notice>
              )}
              {tab === "review" && (
                <Field
                  label="ملاحظة المراجعة — اختيارية"
                  value={reviewReason}
                  maxLength={1000}
                  onChange={(e) => setReviewReason(e.target.value)}
                />
              )}
              {contributions.data?.items.length === 0 && (
                <Card>
                  <p className="medicine-market-muted">
                    لا توجد مساهمات بهذه الحالة.
                  </p>
                </Card>
              )}
              <div className="medicine-market-review-list">
                {contributions.data?.items.map((row) => (
                  <Card key={row.id} className="medicine-market-review-card">
                    <div className="medicine-market-review-heading">
                      <div>
                        <Link to={`${ROOT}?card=${row.cardId}`}>
                          {row.cardName ?? `كرت #${row.cardId}`}
                        </Link>
                        <h3>{fieldLabel(row.kind, row.fieldKey)}</h3>
                      </div>
                      <span className="medicine-market-badge">
                        {statusLabels[row.status] ?? row.status}
                      </span>
                    </div>
                    <div className="medicine-market-diff">
                      <div>
                        <span>القيمة السابقة</span>
                        <p>{readable(row.previousValue)}</p>
                      </div>
                      <div>
                        <span>القيمة المقترحة</span>
                        <p>{readable(row.value)}</p>
                      </div>
                    </div>
                    <p className="medicine-market-muted">
                      {row.authorName ?? "مساهمة مستخدم"} ·{" "}
                      {date(row.createdAt)}
                      {row.source ? ` · المصدر: ${row.source}` : ""}
                    </p>
                    {row.reason && <p>ملاحظة المراجعة: {row.reason}</p>}
                    <div className="medicine-market-review-footer">
                      <span>
                        <Star size={14} /> النقاط المعتمدة: {row.awardedPoints}
                        {row.authorId === user?.id && tab === "review"
                          ? " · اعتماد مساهمتك لا يمنحك نقاطًا"
                          : ""}
                        {row.published && row.status === "pending"
                          ? " · منشور؛ النقاط بانتظار المصادقة"
                          : ""}
                      </span>
                      {tab === "review" && row.status === "pending" && (
                        <div>
                          <Button
                            size="compact"
                            disabled={busy}
                            onClick={() => reviewContribution(row, "approve")}
                          >
                            <Check size={14} /> اعتماد
                          </Button>
                          <Button
                            variant="danger"
                            size="compact"
                            disabled={busy}
                            onClick={() => reviewContribution(row, "reject")}
                          >
                            <X size={14} /> رفض
                          </Button>
                        </div>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
              {contributions.data && pagination(contributions.data.total, 20)}
              {tab === "review" && (
                <Card title="مراجعة التعليقات">
                  {commentsQueue.error && (
                    <Notice tone="error">
                      {errorMessage(commentsQueue.error)}
                    </Notice>
                  )}
                  {commentsQueue.data?.items.length === 0 && (
                    <p className="medicine-market-muted">
                      لا توجد تعليقات بهذه الحالة.
                    </p>
                  )}
                  {commentsQueue.data?.items.map((row) => (
                    <article className="medicine-market-comment" key={row.id}>
                      <div>
                        <Link to={`${ROOT}?card=${row.cardId}`}>
                          {row.cardName ?? `كرت #${row.cardId}`}
                        </Link>
                        <span>
                          {row.authorName} · {date(row.createdAt)}
                        </span>
                      </div>
                      <p>{row.text}</p>
                      {row.status === "pending" && (
                        <div className="page-actions">
                          <Button
                            size="compact"
                            disabled={busy}
                            onClick={() =>
                              void mutate(
                                () =>
                                  api(`${ROOT}/comments/${row.id}/review`, {
                                    method: "POST",
                                    body: { decision: "approve" },
                                  }),
                                "تم اعتماد التعليق.",
                              )
                            }
                          >
                            اعتماد
                          </Button>
                          <Button
                            size="compact"
                            variant="danger"
                            disabled={busy}
                            onClick={() =>
                              void mutate(
                                () =>
                                  api(`${ROOT}/comments/${row.id}/review`, {
                                    method: "POST",
                                    body: { decision: "reject" },
                                  }),
                                "تم رفض التعليق.",
                              )
                            }
                          >
                            رفض
                          </Button>
                        </div>
                      )}
                    </article>
                  ))}
                  {commentsQueue.data &&
                    pagination(commentsQueue.data.total, 20)}
                </Card>
              )}
            </>
          )}
        </>
      )}
      {tab === "points" && (
        <>
          <div className="medicine-market-section-heading">
            <div>
              <h2>نقاط الحقول</h2>
              <p>
                نقاط كل إضافة أو تعديل تُحتسب بعد المصادقة، حسب سياسة الإدارة.
              </p>
            </div>
            <Select
              label="نوع الكرت"
              value={kind}
              onChange={(e) => write({ kind: e.target.value, page: null })}
            >
              <option value="">جميع الأنواع</option>
              {visibleTypes.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </Select>
          </div>
          {types
            .filter((t) => !kind || t.key === kind)
            .map((t) => (
              <Card key={t.key} title={t.label}>
                <div className="medicine-market-policy-head">
                  <span>الحقل</span>
                  <span>إضافة</span>
                  <span>تعديل</span>
                  {permissions?.canConfigure && <span>الإدارة</span>}
                </div>
                {t.fields.map((f) => (
                  <div key={f.key} className="medicine-market-policy-row">
                    <span>
                      {f.label}
                      {f.price && <small> · يحتاج مصادقة</small>}
                    </span>
                    <strong>{f.points.add}</strong>
                    <strong>{f.points.edit}</strong>
                    {permissions?.canConfigure && (
                      <Button
                        size="compact"
                        variant="ghost"
                        onClick={() =>
                          setPolicy({
                            kind: t.key,
                            field: f,
                            add: String(f.points.add),
                            edit: String(f.points.edit),
                          })
                        }
                      >
                        <Pencil size={14} /> ضبط
                      </Button>
                    )}
                  </div>
                ))}
              </Card>
            ))}
        </>
      )}
      <Dialog
        open={createOpen}
        onClose={() => {
          if (!busy) setCreateOpen(false);
        }}
        title="إضافة كرت إلى الدليل"
        className="medicine-market-dialog"
      >
        <form className="stack" onSubmit={(e) => void create(e)}>
          <p className="medicine-market-muted">
            {newKind==="prescription"
              ?"ارفع صورة الوصفة وحدد عدد الأسطر. ستبقى الصورة خاصة بالإدارة ورافعها حتى تُعدّل وتُراجع وتعتمد للنشر."
              :"ابدأ بالاسم فقط، ثم أضف الحقول المتوفرة من داخل الكرت."}
          </p>
          <Select
            label="نوع الكرت"
            value={newKind}
            disabled={busy}
            onChange={(e) => setNewKind(e.target.value as Kind)}
          >
            {visibleTypes.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </Select>
          {newKind==="prescription"?
            <>
              <label className="field">
                <span>صورة الوصفة الطبية</span>
                <input type="file" accept="image/*" disabled={busy}
                  onChange={e=>setPrescriptionFile(e.target.files?.[0]??null)}/>
              </label>
              {prescriptionPhotoUrl&&<img src={prescriptionPhotoUrl} alt="معاينة الوصفة قبل رفعها"
                style={{maxWidth:"100%",maxHeight:350,objectFit:"contain"}}/>}
              <p className="medicine-market-muted">
                بعد حفظ الوصفة يمكنك تنزيل صورتها، وإخفاء البيانات الشخصية، ثم رفع النسخة المعدّلة.
                لن يراها الجمهور حتى تُراجعها الإدارة وتعتمدها.
              </p>
              <PrescriptionLinesEditor value={prescriptionLines}
                onChange={setPrescriptionLines} disabled={busy}/>
              <p className="medicine-market-muted">
                التعرف على الأدوية مشاركة مجتمعية وقد يحتاج إلى تدقيق صيدلاني؛ لا تعتمد على النتائج لصرف علاج.
              </p>
            </>
           :<Field
              label="اسم الكرت"
              value={newName}
              maxLength={250}
              required
              disabled={busy}
              autoFocus
              onChange={(e) => setNewName(e.target.value)}
            />}
          {duplicate.data && duplicate.data.items.length > 0 && (
            <div className="medicine-market-duplicate">
              <strong>كروت مشابهة — تأكد قبل الإضافة</strong>
              {duplicate.data.items.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => {
                    setCreateOpen(false);
                    openCard(item.id);
                  }}
                >
                  {item.name} · #{item.id}
                  <ChevronLeft size={14} />
                </button>
              ))}
            </div>
          )}
          {newKind!=="prescription"&&<p className="medicine-market-muted">
            اسم كل عبوة تجارية يميزها عن العبوات الأخرى. الأسعار والبونص تُضاف
            حقلاً حقلاً وتخضع للمصادقة.
          </p>}
          {error && <Notice tone="error">{error}</Notice>}
          <div className="page-actions">
            <Button type="submit" disabled={busy || (newKind==="prescription"
              ?!prescriptionFile:!newName.trim())}>
              {busy ? "جارٍ التسجيل…" : newKind==="prescription"?"حفظ الوصفة للمراجعة":"إنشاء الكرت"}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setCreateOpen(false)}
            >
              إلغاء
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={!!edit}
        onClose={() => {
          if (!busy && !imageUploading) setEdit(null);
        }}
        title={edit ? `${edit.field.label} — ${edit.card.name}` : "تعديل حقل"}
        className="medicine-market-dialog"
      >
        {edit && (
          <form className="stack" onSubmit={(e) => void saveField(e)}>
            <FieldEditor
              field={edit.field}
              value={edit.value}
              references={references}
              cardData={edit.card.data}
              cardId={edit.card.id}
              cardKind={edit.card.kind}
              onImageBusyChange={setImageUploading}
              disabled={busy || imageUploading}
              onChange={(value) => setEdit({ ...edit, value })}
            />
            <Field
              label="مصدر المعلومة أو ملاحظتك — اختياري"
              value={edit.source}
              maxLength={1000}
              disabled={busy}
              onChange={(e) => setEdit({ ...edit, source: e.target.value })}
            />
            <div className="medicine-market-contribution-note">
              <ShieldCheck size={17} />
              <span>
                {edit.field.price
                  ? "يظهر السعر أو البونص الجديد بعد المصادقة عليه."
                  : "تُنشر المساهمة حسب صلاحيات الحساب وبعد المراجعة عند الحاجة."}{" "}
                النقاط تُحتسب بعد الاعتماد.
              </span>
            </div>
            {error && <Notice tone="error">{error}</Notice>}
            <div className="page-actions">
              <Button type="submit" disabled={busy || imageUploading}>
                {busy ? "جارٍ الإرسال…" : imageUploading ? "جارٍ ضغط الصورة ورفعها…" : "حفظ المساهمة"}
              </Button>
              <Button
                variant="secondary"
                disabled={busy || imageUploading}
                onClick={() => setEdit(null)}
              >
                إلغاء
              </Button>
            </div>
          </form>
        )}
      </Dialog>
      <Dialog
        open={!!policy}
        onClose={() => {
          if (!busy) setPolicy(null);
        }}
        title={policy ? `نقاط ${policy.field.label}` : "سياسة النقاط"}
      >
        {policy && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              const p = policy;
              void mutate(
                () =>
                  api(`${ROOT}/policies`, {
                    method: "PUT",
                    body: {
                      kind: p.kind,
                      fieldKey: p.field.key,
                      addPoints: Number(p.add),
                      editPoints: Number(p.edit),
                      revision: p.field.policyRevision,
                    },
                  }),
                "تم حفظ سياسة نقاط الحقل.",
                () => setPolicy(null),
              );
            }}
          >
            <Field
              label="نقاط الإضافة"
              type="number"
              min={0}
              max={100000}
              step={1}
              required
              value={policy.add}
              disabled={busy}
              onChange={(e) => setPolicy({ ...policy, add: e.target.value })}
            />
            <Field
              label="نقاط التعديل"
              type="number"
              min={0}
              max={100000}
              step={1}
              required
              value={policy.edit}
              disabled={busy}
              onChange={(e) => setPolicy({ ...policy, edit: e.target.value })}
            />
            <p className="medicine-market-muted">
              يسري الضبط على الاعتمادات اللاحقة، وتبقى النقاط السابقة محفوظة.
            </p>
            {error && <Notice tone="error">{error}</Notice>}
            <Button type="submit" disabled={busy}>
              حفظ السياسة
            </Button>
          </form>
        )}
      </Dialog>
    </div>
  );
}
