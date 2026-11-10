import {useEffect,useState} from "react";
import type {ItemComposition} from "../../../packages/contracts/src/index";
import {ServerLookup} from "./phase2";

interface CompositionAlternativeItem {
  id:number;code:string;name:string;englishName:string;
  composition:ItemComposition;
}
/** Selecting an alternative supplies its composition; typing never clears the current link. */
export function CompositionAlternativeLookup({companyId,compositionId,disabled=false,onSelect}:{
  companyId:number;compositionId:number|null;disabled?:boolean;
  onSelect:(composition:ItemComposition)=>void;
}){
  const [alternative,setAlternative]=useState<CompositionAlternativeItem|null>(null);
  useEffect(()=>{
    setAlternative(previous=>previous?.composition.id===compositionId?previous:null);
  },[compositionId]);
  return <ServerLookup<CompositionAlternativeItem>
    companyId={companyId}
    resource={`/companies/${companyId}/item-options?type=composition-items`}
    label="البحث بصنف بديل"
    value={alternative}
    disabled={disabled}
    singleInput
    sort="name:asc"
    searchPlaceholder="اكتب اسم صنف مرتبط بتركيب"
    noResultsLabel="لا توجد أصناف مرتبطة بتركيب تطابق البحث."
    onChange={option=>{
      setAlternative(option);
      if(option)onSelect(option.composition);
    }}
    display={option=>`${option.name} — ${option.composition.arabicName}`}/>;
}
