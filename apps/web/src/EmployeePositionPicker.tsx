import { useState } from "react";
import {
  employeePositions,employeePositionLabels,type EmployeePosition,
} from "../../../packages/contracts/src/index.ts";
import { Field } from "./ui";

/** Adds positions by selection; never shows 22 independent yes/no toggles. */
export function EmployeePositionPicker({
 value,onChange,disabled=false,label="صفات الموظف",
}:{
 value:EmployeePosition[];
 onChange:(value:EmployeePosition[])=>void;
 disabled?:boolean;label?:string;
}) {
 const [query,setQuery]=useState("");
 const choices=employeePositions.filter(p=>
   !value.includes(p.key) && p.label.includes(query.trim()));
 return <div className="employee-position-picker">
   <strong>{label}</strong>
   <div className="employee-position-chips">
     {value.map(role=><button type="button" key={role} disabled={disabled}
       className="button button-secondary button-compact"
       title={`إزالة صفة ${employeePositionLabels[role]}`}
       onClick={()=>onChange(value.filter(x=>x!==role))}>
       {employeePositionLabels[role]} ×
     </button>)}
     {!value.length&&<span className="muted">اختر صفات الموظف من القائمة أدناه</span>}
   </div>
   <Field label="ابحث عن صفة لإضافتها" type="search" value={query}
     disabled={disabled} onChange={e=>setQuery(e.target.value)} />
   <div className="employee-position-choices">
     {choices.map(p=><button type="button" key={p.key}
       disabled={disabled} className="button button-ghost button-compact"
       onClick={()=>{onChange([...value,p.key]);setQuery("");}}>
       + {p.label}
     </button>)}
     {!choices.length&&<span className="muted">لا توجد صفات متبقية مطابقة</span>}
   </div>
 </div>;
}
