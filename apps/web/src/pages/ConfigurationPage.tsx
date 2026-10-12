import { useMemo, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams, Link } from "react-router-dom";
import { pageDefinitions, pageActionLabels, type CompanyContext, type OptionDefinition } from "../../../../packages/contracts/src/index";
import { api, useSession, useScopeGuard } from "../api";
import { errorMessage } from "../phase2";
import { Button, Card, Dialog, Field, Notice, PageHeader, Select } from "../ui";

type Role = {id:number;key:string;name:string;description:string;system:boolean;active:boolean;revision:number};
type PermissionDefinition = {key:string;pageKey:string;action:string;name:string;requiredPermissions:string[];ruleRole:string;active:boolean};
type Employee = {id:number;userId:number;name:string;role:string;active:boolean;generalManager:boolean;permissions:string[]};
type Rule = {id:number;roleId?:number;employeeId?:number;permissionKey?:string;effect:"allow"|"deny";active:boolean;revision:number};
type Assignment={id:number;employeeId:number;roleId:number;active:boolean;revision:number};
export interface ConfigurationDirectory {
  options:OptionDefinition[];
  roles:Role[];
  definitions:PermissionDefinition[];
  employees:Employee[];
  roleRules:Rule[];
  assignments:Assignment[];
  employeeRules:Rule[];
}
type OptionDraft = {
  key:string;pageKey:string;recordKind:OptionDefinition["recordKind"];name:string;description:string;
  valueType:OptionDefinition["valueType"];defaultText:string;choicesText:string;required:boolean;
  searchable:boolean;showOnCard:boolean;showInList:boolean;sortOrder:number;active:boolean;
};
const defaultDraft=():OptionDraft=>({
  key:"",pageKey:"company.item-card",recordKind:"item",name:"",description:"",
  valueType:"text",defaultText:"",choicesText:"",required:false,
  searchable:false,showOnCard:true,showInList:false,sortOrder:100,active:true,
});
const editDraft=(row:OptionDefinition):OptionDraft=>({
  key:row.key,pageKey:row.pageKey,recordKind:row.recordKind,name:row.name,
  description:row.description,valueType:row.valueType,
  defaultText:row.defaultValue===null?"":String(row.defaultValue),
  choicesText:row.choices.map(x=>x.key+" : "+x.label).join("\n"),required:row.required,
  searchable:row.searchable,showOnCard:row.showOnCard,showInList:row.showInList,
  sortOrder:row.sortOrder,active:row.active,
});
const optionPages=[
  {key:"company.item-card",kind:"item"},
  {key:"company.items",kind:"item"},
  {key:"company.accounts",kind:"account"},
  {key:"company.employees",kind:"employee"},
  {key:"company.invoice",kind:"invoice"},
  {key:"company.financial-document",kind:"financial-document"},
] as const;
const pageName=(key:string)=>pageDefinitions.find(page=>page.key===key)?.name??key;
const typeNames:Record<string,string>={boolean:"نعم / لا",text:"نص",integer:"عدد صحيح",decimal:"عدد عشري",date:"تاريخ",list:"قائمة"};

export function ConfigurationPage({context}:{context:CompanyContext}) {
  const companyId=context.company.id;
  const {user}=useSession();
  const guard=useScopeGuard("company:"+companyId+":configuration");
  const queryClient=useQueryClient();
  const [params,setParams]=useSearchParams();
  const tab=params.get("tab")==="permissions"?"permissions":"options";
  const query=useQuery({
    queryKey:["configuration",user?.id,companyId],
    queryFn:({signal})=>api<ConfigurationDirectory>(`/companies/${companyId}/configuration/directory`,{signal}),
    enabled:!!user,
  });
  const [notice,setNotice]=useState("");
  const [error,setError]=useState("");
  const [pending,setPending]=useState(false);
  const [search,setSearch]=useState("");
  const [page,setPage]=useState("");
  const [kindFilter,setKindFilter]=useState("");
  const [status,setStatus]=useState("");
  const [editing,setEditing]=useState<OptionDefinition|"new"|null>(null);
  const [draft,setDraft]=useState<OptionDraft>(defaultDraft);
  const [roleDialog,setRoleDialog]=useState<Role|"new"|null>(null);
  const [roleKey,setRoleKey]=useState("");
  const [roleName,setRoleName]=useState("");
  const [roleDescription,setRoleDescription]=useState("");
  const [roleActive,setRoleActive]=useState(true);
  const [roleId,setRoleId]=useState(0);
  const [employeeId,setEmployeeId]=useState(0);
  const [action,setAction]=useState("");
  const [permissionPage,setPermissionPage]=useState("");
  const data=query.data;
  const filtered=useMemo(()=>((data?.options??[]).filter(o=>
    (!page||o.pageKey===page)&&(!kindFilter||o.valueType===kindFilter)&&
    (!status||(status==="active"?o.active:!o.active))&&
    (!search||[o.key,o.name,o.description,o.pageKey].join(" ").toLocaleLowerCase("ar").includes(search.toLocaleLowerCase("ar")))
  )),[data?.options,page,kindFilter,status,search]);
  const role=data?.roles.find(r=>r.id===roleId)??null;
  const employee=data?.employees.find(e=>e.id===employeeId)??null;
  const definitions=(data?.definitions??[]).filter(d=>
    (!permissionPage||d.pageKey===permissionPage)&&(!action||d.action===action)&&
    (!search||[d.name,d.key,d.pageKey].join(" ").toLocaleLowerCase("ar").includes(search.toLocaleLowerCase("ar"))));
  async function perform(task:()=>Promise<void>,message:string) {
    if(pending)return;
    setPending(true);setError("");setNotice("");
    try {
      await task();
      if(!guard.isCurrent())return;
      await queryClient.invalidateQueries({queryKey:["configuration",user?.id,companyId]});
      if(guard.isCurrent())setNotice(message);
    } catch(cause) {
      if(guard.isCurrent())setError(errorMessage(cause));
    } finally {
      if(guard.isCurrent())setPending(false);
    }
  }
  const base=`/companies/${companyId}/configuration`;
  function openOption(option:OptionDefinition|"new") {
    setEditing(option);
    setDraft(option==="new"?defaultDraft():editDraft(option));
    setError("");
  }
  function optionBody() {
    const choices=draft.choicesText.split("\n").filter(x=>x.trim()).map(line=>{
      const index=line.indexOf(":");
      return {key:index<0?"":line.slice(0,index).trim(),label:index<0?"":line.slice(index+1).trim()};
    });
    const defaultValue=draft.valueType==="boolean"
      ?draft.defaultText===""?null:draft.defaultText==="true"
      :draft.defaultText.trim()===""?null:draft.defaultText;
    return {key:draft.key,pageKey:draft.pageKey,recordKind:draft.recordKind,
      name:draft.name,description:draft.description,valueType:draft.valueType,
      defaultValue,choices:draft.valueType==="list"?choices:[],required:draft.required,
      searchable:draft.searchable,showOnCard:draft.showOnCard,showInList:draft.showInList,
      sortOrder:Number(draft.sortOrder),active:draft.active};
  }
  function saveOption(e:FormEvent) {
    e.preventDefault();
    const row=editing;
    if(!row)return;
    const body=optionBody();
    void perform(async()=>{
      await api(row==="new"?base+"/options":base+"/options/"+row.id,{
        method:row==="new"?"POST":"PATCH",
        body:row==="new"?body:{
          name:body.name,description:body.description,valueType:body.valueType,
          defaultValue:body.defaultValue,choices:body.choices,required:body.required,
          searchable:body.searchable,showOnCard:body.showOnCard,showInList:body.showInList,
          sortOrder:body.sortOrder,active:body.active,revision:row.revision,
        },signal:guard.signal,
      });
      if(guard.isCurrent())setEditing(null);
    },"تم حفظ تعريف الخيار.");
  }
  function openRole(row:Role|"new") {
    setRoleDialog(row);
    setRoleKey(row==="new"?"":row.key);setRoleName(row==="new"?"":row.name);
    setRoleDescription(row==="new"?"":row.description);setRoleActive(row==="new"?true:row.active);
    setError("");
  }
  function saveRole(event:FormEvent) {
    event.preventDefault();
    const row=roleDialog;
    if(!row)return;
    void perform(async()=>{
      await api(row==="new"?base+"/roles":base+"/roles/"+row.id,{
        method:row==="new"?"POST":"PATCH",
        body:row==="new"?{key:roleKey,name:roleName,description:roleDescription}
          :{revision:row.revision,name:roleName,description:roleDescription,active:roleActive},
        signal:guard.signal,
      });
      if(guard.isCurrent())setRoleDialog(null);
    },"تم حفظ الدور.");
  }
  const setRoleRule=(permissionKey:string,effect:"allow"|"deny"|null)=>{
    if(!role)return;
    const previous=data?.roleRules.find(r=>r.roleId===role.id&&r.permissionKey===permissionKey);
    void perform(async()=>{
      await api(base+"/roles/"+role.id+"/rules",{method:"PUT",signal:guard.signal,
        body:{permissionKey,effect,revision:previous?.revision??null}});
    },"تم حفظ قاعدة الدور.");
  };
  const setEmployeeRule=(permissionKey:string,effect:"allow"|"deny"|null)=>{
    if(!employee)return;
    const previous=data?.employeeRules.find(r=>r.employeeId===employee.id&&r.permissionKey===permissionKey);
    void perform(async()=>{
      await api(base+"/employee-rules",{method:"PUT",signal:guard.signal,
        body:{employeeId:employee.id,permissionKey,effect,revision:previous?.revision??null}});
    },"تم حفظ الاستثناء الفردي.");
  };
  const toggleAssignment=(roleToAssign:Role,enabled:boolean)=>{
    if(!employee)return;
    const before=data?.assignments.find(a=>a.employeeId===employee.id&&a.roleId===roleToAssign.id);
    void perform(async()=>{
      await api(base+"/assignments",{method:"PUT",signal:guard.signal,
        body:{employeeId:employee.id,roleId:roleToAssign.id,active:enabled,revision:before?.revision??null}});
    },"تم حفظ إسناد الدور.");
  };
  const effectiveExplanation=(definition:PermissionDefinition)=>{
    if(!employee)return "";
    if(employee.generalManager)return "مدير عام — صلاحية محمية";
    const direct=data?.employeeRules.find(r=>r.employeeId===employee.id&&r.permissionKey===definition.key&&r.active);
    const assigned=new Set((data?.assignments??[]).filter(a=>a.employeeId===employee.id&&a.active).map(a=>a.roleId));
    const matching=(data?.roleRules??[]).filter(r=>assigned.has(r.roleId!)&&r.permissionKey===definition.key&&r.active);
    if(direct?.effect==="deny")return "منع صريح للموظف";
    if(matching.some(r=>r.effect==="deny"))return "منع من دور مسند";
    if(direct?.effect==="allow")return "سماح فردي مسجل";
    if(matching.some(r=>r.effect==="allow"))return "سماح من دور مسند";
    return "لا توجد قاعدة جديدة — الصلاحيات الحالية محفوظة";
  };
  return <>
    <PageHeader title="إدارة الخيارات والصلاحيات" description="تعريف الخيارات والأدوار وربطها بمعرّفات دليل الصفحات." />
    <div className="form-actions">
      <Button variant={tab==="options"?"primary":"secondary"} onClick={()=>{setSearch("");setParams({tab:"options"});}}>دليل الخيارات</Button>
      <Button variant={tab==="permissions"?"primary":"secondary"} onClick={()=>{setSearch("");setParams({tab:"permissions"});}}>دليل الصلاحيات والأدوار</Button>
      <Link to={`/companies/${companyId}/pages`} className="button button-secondary">دليل الصفحات</Link>
    </div>
    {notice&&<Notice tone="success">{notice}</Notice>}
    {error&&<Notice tone="error">{error}</Notice>}
    {query.isPending&&<Notice>جارٍ تحميل إعدادات الشركة…</Notice>}
    {query.error&&<Notice tone="error">{errorMessage(query.error)} <Button onClick={()=>void query.refetch()}>إعادة المحاولة</Button></Notice>}
    {tab==="options"&&data&&<>
      <Card title="تعريفات الخيارات" description="الهوية ثابتة، والقيم الإضافية منفصلة لكل سجل داخل الشركة. الخيارات المرتبطة بحقول النظام محمية.">
        <div className="form-actions"><Button disabled={pending} onClick={()=>openOption("new")}>إضافة خيار</Button><span className="muted">{filtered.length} خيار</span></div>
        <div className="table-filters">
          <Field label="بحث في الخيارات" value={search} onChange={e=>setSearch(e.target.value)} placeholder="الاسم أو الرمز"/>
          <Select label="الصفحة" value={page} onChange={e=>setPage(e.target.value)}>
            <option value="">جميع الصفحات</option>
            {[...new Set(data.options.map(x=>x.pageKey))].map(key=><option key={key} value={key}>{pageName(key)}</option>)}
          </Select>
          <Select label="نوع القيمة" value={kindFilter} onChange={e=>setKindFilter(e.target.value)}>
            <option value="">كل الأنواع</option>{Object.entries(typeNames).map(([key,label])=><option key={key} value={key}>{label}</option>)}
          </Select>
          <Select label="الحالة" value={status} onChange={e=>setStatus(e.target.value)}>
            <option value="">الكل</option><option value="active">فعال</option><option value="inactive">مؤرشف</option>
          </Select>
        </div>
        <div className="table-scroll"><table aria-label="دليل الخيارات">
          <thead><tr><th>الخيار</th><th>الصفحة / الكرت</th><th>النوع</th><th>الحالة</th><th>الإجراء</th></tr></thead>
          <tbody>{filtered.map(row=><tr key={row.id}>
            <td title={row.description}><strong>{row.name}</strong><small className="muted"> ({row.key})</small></td>
            <td>{pageName(row.pageKey)}</td><td>{typeNames[row.valueType]}</td>
            <td>{row.active?"فعال":"مؤرشف"}{row.system?" — أساسي":""}</td>
            <td><Button size="compact" variant="secondary" onClick={()=>openOption(row)}>تعديل</Button></td>
          </tr>)}</tbody>
        </table></div>
      </Card>
    </>}
    {tab==="permissions"&&data&&<>
      <Notice>الدليل يسجّل أدوار الموظفين وقواعد السماح والمنع. صلاحيات التنفيذ الحالية لا تتغير حتى تفعيل الربط الأمني الكامل بالخادم؛ لذلك لا يُعتمد منح دور هنا وحده للوصول إلى العمليات.</Notice>
      <Card title="دليل الأدوار">
        <div className="form-actions"><Button disabled={!context.general||pending} onClick={()=>openRole("new")}>دور جديد</Button></div>
        <Select label="اختيار الدور" value={roleId} onChange={e=>setRoleId(Number(e.target.value))}>
          <option value={0}>اختر دورًا</option>{data.roles.map(r=><option key={r.id} value={r.id}>{r.name}{r.active?"":" (مؤرشف)"}</option>)}
        </Select>
        {role&&<div className="form-actions">
          <span>{role.key}</span>
          <Button variant="secondary" disabled={!context.general} onClick={()=>openRole(role)}>تعديل الدور</Button>
        </div>}
      </Card>
      <Card title="قواعد الدور والصلاحيات المرتبطة بالصفحات">
        <div className="table-filters">
          <Field label="بحث في الصلاحيات" value={search} onChange={e=>setSearch(e.target.value)}/>
          <Select label="الصفحة" value={permissionPage} onChange={e=>setPermissionPage(e.target.value)}>
            <option value="">جميع الصفحات</option>
            {[...new Set(data.definitions.map(d=>d.pageKey))].map(key=><option key={key} value={key}>{pageName(key)}</option>)}
          </Select>
          <Select label="الإجراء" value={action} onChange={e=>setAction(e.target.value)}>
            <option value="">كل الإجراءات</option>
            {Object.entries(pageActionLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}
          </Select>
        </div>
        <div className="table-scroll"><table aria-label="قواعد الأدوار">
          <thead><tr><th>الصفحة</th><th>الإجراء</th><th>الصلاحية</th><th>قرار الدور</th></tr></thead>
          <tbody>{definitions.map(d=>{
            const current=data.roleRules.find(r=>r.roleId===roleId&&r.permissionKey===d.key&&r.active);
            return <tr key={d.key}><td>{pageName(d.pageKey)}</td><td>{pageActionLabels[d.action as keyof typeof pageActionLabels]}</td>
              <td>{d.name}</td><td>
                <Select aria-label={`قرار الدور ${d.key}`} value={current?.effect??""}
                  disabled={!role||!role.active||!context.general||pending}
                  onChange={e=>setRoleRule(d.key,(e.target.value||null) as "allow"|"deny"|null)}>
                  <option value="">بلا قاعدة</option><option value="allow">سماح</option><option value="deny">منع</option>
                </Select>
              </td></tr>;
          })}</tbody></table></div>
      </Card>
      <Card title="أدوار الموظفين والاستثناءات">
        <Select label="الموظف" value={employeeId} onChange={e=>setEmployeeId(Number(e.target.value))}>
          <option value={0}>اختر موظفًا</option>{data.employees.filter(e=>e.active).map(e=><option key={e.id} value={e.id}>{e.name}{e.generalManager?" — مدير عام":""}</option>)}
        </Select>
        {employee&&<>
          <div className="form-actions">
            {data.roles.filter(r=>r.active).map(r=>{
              const assigned=data.assignments.find(a=>a.roleId===r.id&&a.employeeId===employee.id);
              return <label className="check-label" key={r.id}>
                <input type="checkbox" checked={!!assigned?.active} disabled={!context.general||employee.generalManager||pending}
                  onChange={e=>toggleAssignment(r,e.target.checked)} /> {r.name}
              </label>;
            })}
          </div>
          <div className="table-scroll"><table aria-label="استثناءات الموظف">
            <thead><tr><th>الصلاحية</th><th>القرار المباشر</th><th>سبب النتيجة</th></tr></thead>
            <tbody>{definitions.map(d=>{
              const existing=data.employeeRules.find(r=>r.employeeId===employee.id&&r.permissionKey===d.key&&r.active);
              return <tr key={d.key}><td>{d.name}</td><td>
                <Select aria-label={`استثناء الموظف ${d.key}`} value={existing?.effect??""}
                  disabled={!context.general||employee.generalManager||pending}
                  onChange={e=>setEmployeeRule(d.key,(e.target.value||null) as "allow"|"deny"|null)}>
                  <option value="">بلا استثناء</option><option value="allow">سماح</option><option value="deny">منع</option>
                </Select>
              </td><td>{effectiveExplanation(d)}</td></tr>;
            })}</tbody>
          </table></div>
        </>}
      </Card>
    </>}
    <Dialog open={editing!==null} title={editing==="new"?"تعريف خيار جديد":"تعديل تعريف الخيار"} onClose={()=>{if(!pending)setEditing(null);}}>
      <form className="form-stack" onSubmit={saveOption}>
        <div className="form-grid">
          <Field label="معرّف الخيار (ثابت)" required value={draft.key} disabled={pending||editing!=="new"}
            onChange={e=>setDraft({...draft,key:e.target.value})}/>
          <Select label="الصفحة/الكرت" disabled={pending||editing!=="new"} value={draft.pageKey}
            onChange={e=>{const target=optionPages.find(p=>p.key===e.target.value);if(target)setDraft({...draft,pageKey:target.key,recordKind:target.kind});}}>
            {optionPages.map(p=><option value={p.key} key={p.key}>{pageName(p.key)}</option>)}
          </Select>
          <Field label="اسم الخيار" required value={draft.name} maxLength={120} disabled={pending}
            onChange={e=>setDraft({...draft,name:e.target.value})}/>
          <Select label="نوع القيمة" disabled={pending||(editing!=="new"&&!!editing?.system)} value={draft.valueType}
            onChange={e=>setDraft({...draft,valueType:e.target.value as OptionDraft["valueType"],defaultText:"",choicesText:""})}>
            {Object.entries(typeNames).map(([key,label])=><option key={key} value={key}>{label}</option>)}
          </Select>
          <Field label="الوصف" value={draft.description} maxLength={1000} disabled={pending}
            onChange={e=>setDraft({...draft,description:e.target.value})}/>
          {draft.valueType==="boolean"?<Select label="الافتراضي" disabled={pending||(editing!=="new"&&!!editing?.system)}
            value={draft.defaultText} onChange={e=>setDraft({...draft,defaultText:e.target.value})}>
            <option value="">بلا قيمة</option><option value="true">نعم</option><option value="false">لا</option>
          </Select>:<Field label="الافتراضي" disabled={pending||(editing!=="new"&&!!editing?.system)}
            type={draft.valueType==="date"?"date":"text"} value={draft.defaultText}
            onChange={e=>setDraft({...draft,defaultText:e.target.value})}/>}
          {draft.valueType==="list"&&<div className="field">
            <label htmlFor="configuration-choice-rows">عناصر القائمة (مفتاح : اسم)، كل خيار بسطر</label>
            <textarea id="configuration-choice-rows" rows={5} value={draft.choicesText} disabled={pending}
              onChange={e=>setDraft({...draft,choicesText:e.target.value})}/>
          </div>}
          <Field label="الترتيب" type="number" min={0} value={draft.sortOrder} disabled={pending}
            onChange={e=>setDraft({...draft,sortOrder:Number(e.target.value)})}/>
        </div>
        <div className="form-actions">
          {([["required","إلزامي"],["searchable","في البحث"],["showOnCard","في الكرت"],["showInList","في القائمة"],["active","فعال"]] as const).map(([field,label])=>
            <label key={field} className="check-label"><input type="checkbox" checked={draft[field]}
              disabled={pending||(editing!=="new"&&!!editing?.system&&(field==="required"||field==="active"))}
              onChange={e=>setDraft({...draft,[field]:e.target.checked})}/> {label}</label>)}
        </div>
        <div className="form-actions">
          <Button type="submit" disabled={pending}>{pending?"جارٍ الحفظ…":"حفظ"}</Button>
          <Button variant="secondary" disabled={pending} onClick={()=>setEditing(null)}>إلغاء</Button>
        </div>
      </form>
    </Dialog>
    <Dialog open={roleDialog!==null} title={roleDialog==="new"?"إضافة دور":"تعديل دور"} onClose={()=>{if(!pending)setRoleDialog(null);}}>
      <form className="form-stack" onSubmit={saveRole}>
        <Field label="معرّف الدور" value={roleKey} required disabled={pending||roleDialog!=="new"}
          onChange={e=>setRoleKey(e.target.value)} />
        <Field label="اسم الدور" value={roleName} required disabled={pending} onChange={e=>setRoleName(e.target.value)} />
        <Field label="الوصف" value={roleDescription} disabled={pending} onChange={e=>setRoleDescription(e.target.value)} />
        {roleDialog!=="new"&&<label className="check-label"><input type="checkbox" checked={roleActive}
          disabled={pending} onChange={e=>setRoleActive(e.target.checked)}/> الدور فعال</label>}
        <div className="form-actions">
          <Button type="submit" disabled={pending}>{pending?"جارٍ الحفظ…":"حفظ الدور"}</Button>
          <Button variant="secondary" onClick={()=>setRoleDialog(null)} disabled={pending}>إلغاء</Button>
        </div>
      </form>
    </Dialog>
  </>;
}
