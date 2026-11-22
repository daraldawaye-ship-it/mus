import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  tableColumnDefaultIds, tableColumnDefaultsCatalog, tableColumnDefaultsInputSchema,
  tableColumnDefaultsResponseSchema, type TableColumnDefault, type TableColumnDefaultId, type TableColumnDefaults,
} from "../../../../packages/contracts/src/table-column-defaults";
import type { CompanyContext } from "../../../../packages/contracts/src/index";
import { api, useScopeGuard, useSession } from "../api";
import { errorMessage } from "../phase2";
import { tableDefaultsPath, useTableColumnDefaults } from "../table-column-defaults";
import { Button, Card, Notice, PageHeader, Select } from "../ui";

const emptyColor = "#5276bb";
const tableRows = (id: TableColumnDefaultId, saved: TableColumnDefaults): TableColumnDefault[] => {
  const known = tableColumnDefaultsCatalog[id].columns;
  const current = saved.columns.filter(row => known.some(c => c.id === row.id));
  return [...current, ...known.filter(c => !current.some(row => row.id === c.id))
    .map(c => ({id:c.id, width:c.width, visible:c.visible, color:null}))];
};

export default function TableColumnDefaultsPage({context}: {context: CompanyContext}) {
  const {user,employeePreview,visitorOnly} = useSession();
  const [tableId,setTable] = useState<TableColumnDefaultId>("item-options-list");
  const companyId = context.company.id;
  const canManage = !!user?.owner && !employeePreview && !visitorOnly;
  const defaults = useTableColumnDefaults(companyId,tableId,canManage);
  if (!canManage || !user) return <Notice tone="warning">هذه الصفحة لمالك المنصة فقط.</Notice>;
  return <>
    <PageHeader title="إعدادات أعمدة الصفحات" description="إعدادات الشركة الافتراضية. لا تستبدل تفضيلات الأعمدة التي حفظها المستخدم على جهازه." />
    <Card>
      <div className="table-filters">
        <Select label="الصفحة" value={tableId} onChange={e=>setTable(e.target.value as TableColumnDefaultId)}>
          {tableColumnDefaultIds.map(id=><option key={id} value={id}>{tableColumnDefaultsCatalog[id].label}</option>)}
        </Select>
      </div>
      {defaults.isError && <Notice tone="error">{errorMessage(defaults.error)} <Button type="button" onClick={()=>void defaults.refetch()}>إعادة المحاولة</Button></Notice>}
      {defaults.isPending && <Notice>جارٍ تحميل إعدادات الأعمدة…</Notice>}
      {!defaults.isError && defaults.data && <Editor key={`${companyId}:${user.id}:${tableId}`}
        companyId={companyId} userId={user.id} tableId={tableId} initial={defaults.data}/>}
    </Card>
  </>;
}

function Editor({companyId,userId,tableId,initial}: {companyId:number;userId:number;tableId:TableColumnDefaultId;initial:TableColumnDefaults}) {
  const queryClient=useQueryClient();
  const guard=useScopeGuard(`company:${companyId}:table-column-defaults:${tableId}`);
  const [revision,setRevision]=useState(initial.revision);
  const [rows,setRows]=useState(()=>tableRows(tableId,initial));
  const [dirty,setDirty]=useState(false);
  const [saving,setSaving]=useState(false);
  const [message,setMessage]=useState<{ok:boolean;text:string}>();
  const definitions=tableColumnDefaultsCatalog[tableId].columns;
  async function save() {
    if(saving||!dirty||!guard.isCurrent())return;
    setSaving(true);
    setMessage(undefined);
    try {
      const body=tableColumnDefaultsInputSchema.parse({columns:rows,expectedRevision:revision});
      const result=tableColumnDefaultsResponseSchema.parse(await api(tableDefaultsPath(companyId,tableId),{
        method:"PUT",body,signal:guard.signal,
      }));
      if(!guard.isCurrent())return;
      setRevision(result.revision);
      setRows(tableRows(tableId,result));
      setDirty(false);
      queryClient.setQueryData(["table-column-defaults",userId,companyId,tableId],result);
      setMessage({ok:true,text:"حُفظت الإعدادات الافتراضية للشركة."});
    } catch(error) {
      if(guard.isCurrent())setMessage({ok:false,text:errorMessage(error)});
    } finally {
      if(guard.isCurrent())setSaving(false);
    }
  }
  async function reload() {
    if(saving||!guard.isCurrent())return;
    setSaving(true);
    try {
      const result=tableColumnDefaultsResponseSchema.parse(await api(tableDefaultsPath(companyId,tableId),{signal:guard.signal}));
      if(!guard.isCurrent())return;
      setRevision(result.revision);
      setRows(tableRows(tableId,result));
      queryClient.setQueryData(["table-column-defaults",userId,companyId,tableId],result);
      setDirty(false);
      setMessage(undefined);
    } catch(error) {
      if(guard.isCurrent())setMessage({ok:false,text:errorMessage(error)});
    } finally {
      if(guard.isCurrent())setSaving(false);
    }
  }
  function update(id:string, change:Partial<Omit<TableColumnDefault,"id">>) {
    setRows(previous=>previous.map(row=>row.id===id?{...row,...change}:row));
    setDirty(true);
  }
  function move(index:number,direction:number) {
    const target=index+direction;
    if(target<0||target>=rows.length)return;
    setRows(previous=>{const next=[...previous];[next[index],next[target]]=[next[target],next[index]];return next;});
    setDirty(true);
  }
  return <>
    {message&&<Notice tone={message.ok?"success":"error"}>{message.text}</Notice>}
    <div className="table-scroll" tabIndex={0} role="region" aria-label="إعدادات الأعمدة">
      <table aria-label="إعدادات الأعمدة">
        <thead><tr><th>العمود</th><th>الترتيب</th><th>العرض (بكسل)</th><th>اللون</th><th>ظاهر افتراضيًا</th></tr></thead>
        <tbody>{rows.map((row,i)=>{
          const label=definitions.find(c=>c.id===row.id)?.label ?? row.id;
          return <tr key={row.id}>
            <th scope="row">{label}</th>
            <td><div className="actions">
              <Button type="button" size="compact" variant="secondary" aria-label={`تقديم عمود ${label}`} disabled={saving||i===0} onClick={()=>move(i,-1)}>↑</Button>
              <Button type="button" size="compact" variant="secondary" aria-label={`تأخير عمود ${label}`} disabled={saving||i===rows.length-1} onClick={()=>move(i,1)}>↓</Button>
            </div></td>
            <td><input style={{width:"6em"}} type="number" min={48} max={640} step={1} aria-label={`عرض عمود ${label}`}
              value={Number.isNaN(row.width)?"":row.width} disabled={saving} onChange={e=>update(row.id,{width:e.currentTarget.valueAsNumber})}/></td>
            <td><div className="actions">
              <input type="color" title={row.color??"اللون الافتراضي"} aria-label={`لون عمود ${label}`}
                value={row.color??emptyColor} disabled={saving} onChange={e=>update(row.id,{color:e.currentTarget.value})}/>
              <Button type="button" size="compact" variant="secondary" disabled={saving||!row.color} onClick={()=>update(row.id,{color:null})}>افتراضي</Button>
            </div></td>
            <td><input type="checkbox" aria-label={`إظهار عمود ${label} افتراضيًا`} checked={row.visible}
              disabled={saving||(row.visible&&rows.filter(c=>c.visible).length===1)} onChange={e=>update(row.id,{visible:e.currentTarget.checked})}/></td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <div className="form-actions">
      <Button type="button" disabled={saving||!dirty||!tableColumnDefaultsInputSchema.safeParse({columns:rows,expectedRevision:revision}).success} onClick={()=>void save()}>{saving?"جارٍ الحفظ…":"حفظ الإعدادات"}</Button>
      {(dirty||message?.ok===false)&&<Button type="button" variant="secondary" disabled={saving} onClick={()=>void reload()}>إعادة قراءة المحفوظ</Button>}
    </div>
  </>;
}
