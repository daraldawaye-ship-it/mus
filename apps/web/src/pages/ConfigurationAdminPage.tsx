import { useMemo, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanyContext, OptionDefinition, OptionValueType } from "../../../../packages/contracts/src/index";
import { optionValueTypes } from "../../../../packages/contracts/src/index";
import { api, useSession } from "../api";
import { Button, Card, Dialog, Field, Notice, PageHeader, Select } from "../ui";
import { errorMessage } from "../phase2";

type CompanyRole = { id:number; key:string; name:string; description:string; active:boolean; system:boolean; revision:number };
type PermissionDefinition = { key:string; pageKey:string; action:string; name:string; ruleRole:string; requiredPermissions:string[]; active:boolean };
type RoleRule = { id:number; roleId:number; permissionKey:string; permissionName:string; pageKey:string; action:string; effect:"allow"|"deny"; active:boolean; revision:number };
type ConfigurationDirectory = {
  options:OptionDefinition[]; roles:CompanyRole[]; permissions:PermissionDefinition[]; rules:RoleRule[];
  targets:{pageKey:string;recordKind:string}[];
  assignments:{id:number;employeeId:number;employeeName:string;roleId:number;active:boolean}[];
  exceptions:{id:number;employeeId:number;permissionKey:string;effect:string;active:boolean}[];
};
const valueLabels:Record<OptionValueType,string> = {
  boolean:"نعم / لا",text:"نص",integer:"عدد صحيح",decimal:"عدد عشري",date:"تاريخ",list:"قائمة"
};
const emptyOption = {
  key:"",pageKey:"company.items",recordKind:"item",name:"",description:"",
  valueType:"text" as OptionValueType,defaultValue:null as string|boolean|null,choices:[] as {key:string;label:string}[],
  required:false,searchable:false,showOnCard:true,showInList:false,sortOrder:0,active:true,
};
function OptionEditor({companyId,existing,targets,onClose,onSaved}:{
  companyId:number;existing:OptionDefinition|null;targets:ConfigurationDirectory["targets"];
  onClose:()=>void;onSaved:()=>void;
}) {
  const [fields,setFields] = useState(()=>existing?{
    key:existing.key,pageKey:existing.pageKey,recordKind:existing.recordKind,
    name:existing.name,description:existing.description,valueType:existing.valueType,
    defaultValue:existing.defaultValue,choices:existing.choices,required:existing.required,
    searchable:existing.searchable,showOnCard:existing.showOnCard,
    showInList:existing.showInList,sortOrder:existing.sortOrder,active:existing.active,
  }:{...emptyOption});
  const [choicesText,setChoicesText]=useState(()=>fields.choices.map(c=>`${c.key}|${c.label}`).join("\n"));
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  const set=<K extends keyof typeof fields>(key:K,value:(typeof fields)[K])=>setFields(old=>({...old,[key]:value}));
  function changeType(value:OptionValueType){
    setFields(old=>({...old,valueType:value,defaultValue:null,choices:value==="list"?old.choices:[]}));
  }
  async function save(event:FormEvent){
    event.preventDefault();
    if(saving)return;
    setError("");
    const choices=fields.valueType==="list"?choicesText.split("\n").map(row=>row.trim()).filter(Boolean).map(row=>{
      const separator=row.indexOf("|");
      return {key:row.slice(0,separator).trim(),label:row.slice(separator+1).trim()};
    }):[];
    if(fields.valueType==="list" && choices.some(c=>!c.key||!c.label)){
      setError("اكتب عناصر القائمة بصيغة الرمز|الاسم، سطر لكل عنصر.");return;
    }
    const body={...fields,choices,...(existing?{revision:existing.revision}:{})};
    setSaving(true);
    try {
      await api(`/companies/${companyId}/configuration-options${existing?'/'+existing.id:''}`,{
        method:existing?"PATCH":"POST",body,
      });
      onSaved();
    }catch(e){setError(errorMessage(e))}finally{setSaving(false)}
  }
  return <Dialog open title={existing?"تعديل تعريف الخيار":"تعريف خيار إضافي"} onClose={()=>{if(!saving)onClose()}}>
    <form className="form-stack" onSubmit={e=>void save(e)}>
      {error&&<Notice tone="error">{error}</Notice>}
      {existing?.system&&<Notice>هذا خيار أصلي مرتبط ببيانات النظام. لا يمكن تغيير نوعه أو إعادة توجيهه إلى حقل آخر.</Notice>}
      <div className="form-grid">
        <Field label="معرف الخيار الثابت" required disabled={saving||!!existing} value={fields.key} onChange={e=>set("key",e.target.value)} placeholder="items.warranty-months"/>
        <Select label="الصفحة / الكرت" disabled={saving||!!existing} value={fields.pageKey+"|"+fields.recordKind} onChange={e=>{
          const match=targets.find(x=>x.pageKey+"|"+x.recordKind===e.target.value);
          if(match)setFields(old=>({...old,pageKey:match.pageKey,recordKind:match.recordKind}));
        }}>
          {targets.map(t=><option key={t.pageKey+"|"+t.recordKind} value={t.pageKey+"|"+t.recordKind}>{t.pageKey} ({t.recordKind})</option>)}
        </Select>
        <Field label="الاسم" required disabled={saving} value={fields.name} onChange={e=>set("name",e.target.value)}/>
        <Select label="نوع القيمة" disabled={saving||!!existing?.system} value={fields.valueType} onChange={e=>changeType(e.target.value as OptionValueType)}>
          {optionValueTypes.map(t=><option key={t} value={t}>{valueLabels[t]}</option>)}
        </Select>
        <Field label="الوصف" disabled={saving} value={fields.description} onChange={e=>set("description",e.target.value)}/>
        <Field label="الترتيب" type="number" min="0" max="100000" disabled={saving}
          value={String(fields.sortOrder)} onChange={e=>set("sortOrder",Number(e.target.value))}/>
      </div>
      {fields.valueType==="boolean"?
        <Select label="القيمة الافتراضية" disabled={saving} value={fields.defaultValue===null?"null":String(fields.defaultValue)}
          onChange={e=>set("defaultValue",e.target.value==="null"?null:e.target.value==="true")}>
          <option value="null">بلا قيمة</option><option value="true">نعم</option><option value="false">لا</option>
        </Select>:
        <Field label="القيمة الافتراضية (اختياري)" disabled={saving}
          value={fields.defaultValue===null?"":String(fields.defaultValue)}
          onChange={e=>set("defaultValue",e.target.value||null)}
          placeholder={fields.valueType==="date"?"YYYY-MM-DD":""}/>
      }
      {fields.valueType==="list"&&
        <div className="field"><label htmlFor="option-choices">عناصر القائمة — رمز|اسم في كل سطر</label>
          <textarea id="option-choices" rows={4} disabled={saving||!!existing?.system} value={choicesText}
            onChange={e=>setChoicesText(e.target.value)}/></div>}
      <div className="form-grid">
        {([
          ["required","إلزامي"],["searchable","يظهر في البحث"],["showOnCard","يظهر في الكرت"],
          ["showInList","يظهر في القائمة"],["active","مفعّل"],
        ] as const).map(([key,label])=><label key={key} className="checkbox-field">
          <input type="checkbox" checked={fields[key]} disabled={saving}
            onChange={e=>set(key,e.target.checked)}/>{label}
        </label>)}
      </div>
      <Notice>التعريفات الإضافية لا تُغيّر قواعد المخزون أو المحاسبة. القيم السابقة تظل محفوظة عند أرشفة الخيار.</Notice>
      <div className="form-actions">
        <Button type="submit" disabled={saving}>{saving?"جارٍ الحفظ…":"حفظ الخيار"}</Button>
        <Button variant="secondary" disabled={saving} onClick={onClose}>إلغاء</Button>
      </div>
    </form>
  </Dialog>;
}
function RoleEditor({companyId,existing,onClose,onSaved}:{
  companyId:number;existing:CompanyRole|null;onClose:()=>void;onSaved:()=>void;
}){
  const [key,setKey]=useState(existing?.key??"");
  const [name,setName]=useState(existing?.name??"");
  const [description,setDescription]=useState(existing?.description??"");
  const [active,setActive]=useState(existing?.active??true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  async function save(event:FormEvent){
    event.preventDefault();setBusy(true);setError("");
    try{
      await api(`/companies/${companyId}/configuration-roles${existing?"/"+existing.id:""}`,{
        method:existing?"PATCH":"POST",
        body:existing?{name,description,active,revision:existing.revision}:{key,name,description},
      });onSaved();
    }catch(e){setError(errorMessage(e))}finally{setBusy(false)}
  }
  return <Dialog open title={existing?"تعديل الدور":"إضافة دور"} onClose={()=>{if(!busy)onClose()}}>
    <form className="form-stack" onSubmit={e=>void save(e)}>
      {error&&<Notice tone="error">{error}</Notice>}
      <Field label="معرف الدور" required disabled={busy||!!existing} value={key} onChange={e=>setKey(e.target.value)} placeholder="warehouse-manager"/>
      <Field label="اسم الدور" required disabled={busy} value={name} onChange={e=>setName(e.target.value)}/>
      <Field label="الوصف" disabled={busy} value={description} onChange={e=>setDescription(e.target.value)}/>
      {existing&&<label className="checkbox-field"><input type="checkbox" checked={active} disabled={busy} onChange={e=>setActive(e.target.checked)}/>الدور فعال</label>}
      <div className="form-actions"><Button type="submit" disabled={busy}>حفظ</Button><Button variant="secondary" onClick={onClose} disabled={busy}>إلغاء</Button></div>
    </form>
  </Dialog>;
}
export function ConfigurationAdminPage({context,tab}:{context:CompanyContext;tab:"options"|"permissions"}){
  const companyId=context.company.id;
  const {user}=useSession();
  const client=useQueryClient();
  const key=["configuration-admin",user?.id,companyId];
  const query=useQuery({
    queryKey:key,queryFn:({signal})=>api<ConfigurationDirectory>(`/companies/${companyId}/configuration-directory`,{signal}),
  });
  const [search,setSearch]=useState("");
  const [pageFilter,setPageFilter]=useState("");
  const [stateFilter,setStateFilter]=useState("");
  const [optionEditor,setOptionEditor]=useState<OptionDefinition|null|"new">(null);
  const [roleEditor,setRoleEditor]=useState<CompanyRole|null|"new">(null);
  const [selectedRole,setSelectedRole]=useState("");
  const [chosenPermission,setChosenPermission]=useState("");
  const [chosenEffect,setChosenEffect]=useState<"allow"|"deny">("allow");
  const [notice,setNotice]=useState("");
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const data=query.data;
  const manager=context.general;
  const options=useMemo(()=> (data?.options??[]).filter(o=>
    (!pageFilter||o.pageKey===pageFilter)&&
    (!stateFilter||(stateFilter==="active"?o.active:!o.active))&&
    (!search||[o.key,o.name,o.description].some(value=>value.toLowerCase().includes(search.toLowerCase())))
  ),[data,search,pageFilter,stateFilter]);
  const permissions=useMemo(()=>(data?.permissions??[]).filter(p=>
    (!pageFilter||p.pageKey===pageFilter)&&
    (!search||[p.name,p.key,p.action].some(value=>value.toLowerCase().includes(search.toLowerCase())))
  ),[data,pageFilter,search]);
  const roles=data?.roles??[];
  function saved(message:string){setOptionEditor(null);setRoleEditor(null);setError("");setNotice(message);void client.invalidateQueries({queryKey:key})}
  async function saveRule(existing?:RoleRule){
    if(busy)return;
    setBusy(true);setError("");
    try{
      await api(`/companies/${companyId}/configuration-role-rules${existing?"/"+existing.id:""}`,{
        method:existing?"PATCH":"POST",
        body:existing?{effect:existing.effect==="allow"?"deny":"allow",active:existing.active,revision:existing.revision}
          :{roleId:Number(selectedRole),permissionKey:chosenPermission,effect:chosenEffect},
      });
      setNotice(existing?"تم تبديل قاعدة السماح والمنع.":"تمت إضافة قاعدة الدور.");void client.invalidateQueries({queryKey:key});
    }catch(e){setError(errorMessage(e))}finally{setBusy(false)}
  }
  return <>
    <PageHeader title="إدارة الخيارات والصلاحيات" description="تعريفات الخيارات والأدوار مرتبطة بمعرفات دليل الصفحات، ومفصولة بين الشركات."
      actions={tab==="options"?<Button onClick={()=>setOptionEditor("new")}>إضافة خيار</Button>
        :manager?<Button onClick={()=>setRoleEditor("new")}>إضافة دور</Button>:undefined}/>
    <Notice>قواعد الأدوار الجديدة محفوظة للتجهيز فقط. يستمر النظام حاليًا في تطبيق صلاحيات الموظفين التشغيلية السابقة لحين ربطها بالخادم واختبارها. لا تمنح هذه الشاشة صلاحيات فعلية بعد.</Notice>
    {notice&&<Notice tone="success">{notice}</Notice>}
    {error&&<Notice tone="error">{error}</Notice>}
    {query.error&&<Notice tone="error">{errorMessage(query.error)} <Button onClick={()=>void query.refetch()}>إعادة المحاولة</Button></Notice>}
    {query.isPending&&<Notice>جارٍ تحميل التعريفات…</Notice>}
    <Card title={tab==="options"?"دليل الخيارات":"دليل الصلاحيات والأدوار"}>
      <div className="table-filters">
        <Field label="بحث" value={search} onChange={e=>setSearch(e.target.value)} placeholder="الاسم أو المعرف"/>
        <Select label="الصفحة" value={pageFilter} onChange={e=>setPageFilter(e.target.value)}>
          <option value="">جميع الصفحات</option>
          {[...new Set((tab==="options"?(data?.targets??[]).map(t=>t.pageKey):(data?.permissions??[]).map(p=>p.pageKey)))].map(p=>
            <option key={p} value={p}>{p}</option>)}
        </Select>
        {tab==="options"&&<Select label="الحالة" value={stateFilter} onChange={e=>setStateFilter(e.target.value)}>
          <option value="">جميع الحالات</option><option value="active">مفعّل</option><option value="inactive">مؤرشف</option>
        </Select>}
      </div>
      {tab==="options"?
        <div className="table-scroll"><table aria-label="تعريفات الخيارات">
          <thead><tr><th>الاسم / المعرف</th><th>الصفحة</th><th>النوع</th><th>الظهور</th><th>الحالة</th><th>الإجراء</th></tr></thead>
          <tbody>{options.map(o=><tr key={o.id}>
            <td><strong>{o.name}</strong><small className="muted">{o.key}</small></td>
            <td>{o.pageKey}</td><td>{valueLabels[o.valueType]}</td>
            <td>{[o.showOnCard?"الكرت":"",o.searchable?"البحث":"",o.showInList?"القائمة":""].filter(Boolean).join(" / ")||"—"}</td>
            <td>{o.active?"فعال":"مؤرشف"}{o.system?" — نظامي":""}</td>
            <td><Button size="compact" variant="secondary" onClick={()=>setOptionEditor(o)}>تعديل</Button></td>
          </tr>)}</tbody>
        </table></div>
        :<>
          <strong>الأدوار</strong>
          <div className="table-scroll"><table aria-label="الأدوار">
            <thead><tr><th>الدور</th><th>الحالة</th><th>عدد القواعد</th><th>الإجراء</th></tr></thead>
            <tbody>{roles.map(role=><tr key={role.id}>
              <td>{role.name} <small className="muted">({role.key})</small></td>
              <td>{role.active?"فعال":"موقوف"}</td>
              <td>{data?.rules.filter(rule=>rule.roleId===role.id).length??0}</td>
              <td>{manager?<Button size="compact" variant="secondary" onClick={()=>setRoleEditor(role)}>تعديل</Button>:"—"}</td>
            </tr>)}</tbody>
          </table></div>
          <strong>تعريفات الصلاحيات الحالية</strong>
          <div className="table-scroll"><table aria-label="تعريفات الصلاحيات">
            <thead><tr><th>الصفحة</th><th>الإجراء</th><th>الصلاحية</th><th>التطبيق الحالي</th></tr></thead>
            <tbody>{permissions.map(p=><tr key={p.key}><td>{p.pageKey}</td><td>{p.action}</td>
              <td>{p.name}</td><td>{p.requiredPermissions.join(" + ")||p.ruleRole}</td></tr>)}</tbody>
          </table></div>
          {manager&&<form className="form-stack" onSubmit={e=>{e.preventDefault();void saveRule()}}>
            <strong>إضافة قاعدة سماح أو منع لدور</strong>
            <div className="form-grid">
              <Select label="الدور" required value={selectedRole} onChange={e=>setSelectedRole(e.target.value)}><option value="">اختر الدور</option>
                {roles.filter(r=>r.active).map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</Select>
              <Select label="تعريف الصلاحية" required value={chosenPermission} onChange={e=>setChosenPermission(e.target.value)}>
                <option value="">اختر الصلاحية</option>
                {permissions.filter(p=>p.active).map(p=><option key={p.key} value={p.key}>{p.name}</option>)}</Select>
              <Select label="القرار" value={chosenEffect} onChange={e=>setChosenEffect(e.target.value as "allow"|"deny")}>
                <option value="allow">سماح</option><option value="deny">منع صريح</option></Select>
            </div>
            <Button type="submit" disabled={busy||!selectedRole||!chosenPermission}>إضافة القاعدة</Button>
          </form>}
          <div className="table-scroll"><table aria-label="قواعد صلاحيات الأدوار">
            <thead><tr><th>الدور</th><th>الصلاحية</th><th>القرار</th><th>الحالة</th><th>الإجراء</th></tr></thead>
            <tbody>{(data?.rules??[]).filter(r=>(!pageFilter||r.pageKey===pageFilter)&&
              (!search||r.permissionName.includes(search)||r.permissionKey.includes(search))).map(rule=><tr key={rule.id}>
              <td>{roles.find(r=>r.id===rule.roleId)?.name}</td><td>{rule.permissionName}</td>
              <td>{rule.effect==="allow"?"سماح":"منع"}</td><td>{rule.active?"فعال":"موقوف"}</td>
              <td>{manager?<Button size="compact" variant="secondary" disabled={busy}
                onClick={()=>void saveRule(rule)}>عكس القرار</Button>:"—"}</td>
            </tr>)}</tbody>
          </table></div>
        </>}
    </Card>
    {optionEditor&&<OptionEditor key={optionEditor==="new"?"new":optionEditor.id}
      companyId={companyId} existing={optionEditor==="new"?null:optionEditor} targets={data?.targets??[]}
      onClose={()=>setOptionEditor(null)} onSaved={()=>saved("تم حفظ تعريف الخيار.")}/>}
    {roleEditor&&<RoleEditor key={roleEditor==="new"?"new":roleEditor.id}
      companyId={companyId} existing={roleEditor==="new"?null:roleEditor}
      onClose={()=>setRoleEditor(null)} onSaved={()=>saved("تم حفظ الدور.")}/>}
  </>;
}
