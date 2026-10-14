import { optionValueError,
  type OptionDefinition, type OptionScalar, type MemoOptionValueInput,
} from "../../../packages/contracts/src/index";
import { Field, Select, Notice } from "./ui";

export function MemoOptionFields({
  definitions, values, onChange, disabled=false, defaults=false,
}:{
  definitions:OptionDefinition[];
  values:MemoOptionValueInput[];
  onChange:(values:MemoOptionValueInput[])=>void;
  disabled?:boolean;defaults?:boolean;
}) {
  const active=definitions.filter(d=>d.active && d.nativeBinding===null);
  function valueOf(definition:OptionDefinition):OptionScalar {
    const row=values.find(value=>value.definitionId===definition.id);
    return row?row.value:(defaults?definition.defaultValue:null);
  }
  function change(definitionId:number,value:OptionScalar) {
    onChange([...values.filter(x=>x.definitionId!==definitionId),
      {definitionId,value}]);
  }
  return <div className="form-stack">
    {!active.length && <p className="muted">لا توجد خصائص إضافية معرفة للمذكرات.</p>}
    {active.map(definition=>{
      const value=valueOf(definition);
      const error=optionValueError(definition,value);
      return <div className="form-stack" key={definition.id}>
        {definition.valueType==="boolean" ? (
          <Select label={definition.name} value={value===null?"":String(value)}
            disabled={disabled} required={definition.required}
            onChange={e=>change(definition.id,
              e.target.value===""?null:e.target.value==="true")}>
            <option value="">غير محدد</option>
            <option value="true">نعم</option>
            <option value="false">لا</option>
          </Select>
        ) : definition.valueType==="list" ? (
          <Select label={definition.name} disabled={disabled}
            required={definition.required} value={value===null?"":String(value)}
            onChange={e=>change(definition.id,e.target.value||null)}>
            <option value="">غير محدد</option>
            {definition.choices.map(c=><option key={c.key} value={c.key}>{c.label}</option>)}
          </Select>
        ) : (
          <Field label={definition.name} disabled={disabled}
            type={definition.valueType==="date"?"date":"text"}
            required={definition.required} maxLength={2000}
            value={value===null?"":String(value)}
            onChange={e=>change(definition.id,e.target.value===""?null:e.target.value)}/>
        )}
        {definition.description && <p className="muted">{definition.description}</p>}
        {error && <Notice tone="warning">{error}</Notice>}
      </div>;
    })}
  </div>;
}
export function memoOptionLabel(definition:OptionDefinition,value:OptionScalar):string {
  if(value===null)return "غير محدد";
  if(typeof value==="boolean")return value?"نعم":"لا";
  if(definition.valueType==="list")
    return definition.choices.find(c=>c.key===value)?.label??value;
  return value;
}
