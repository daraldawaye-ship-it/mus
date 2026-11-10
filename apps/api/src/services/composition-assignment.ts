import type { Database } from "../db.ts";
import type { User } from "../../../../packages/contracts/src/index.ts";
import type { CompositionAssignmentInput, ProductForm } from "../../../../packages/contracts/src/items.ts";
import { HttpError } from "../errors.ts";
import { audit } from "./audit.ts";

const fail=(message:string):never=>{throw new HttpError(409,"conflict",message);};
export function assignmentItemForm(form:ProductForm):ProductForm {
  if(form==="اقراص/كبسول")return "اقراص";
  if(form==="مرهم/كريم/جل")return "مرهم";
  return form;
}
/** Called inside mutateMaster's company-authorized transaction. Never commit here. */
export async function assignComposition(
  db:Database,user:User,companyId:number,input:CompositionAssignmentInput,
){
  await db.query("SELECT pg_advisory_xact_lock(hashtext('item-composition-assignment'),$1::integer)",[companyId]);
  const receipt=await db.query(
    "SELECT *,payload=$3::jsonb AS same_payload FROM item_composition_assignments WHERE company_id=$1 AND idempotency_key=$2",
    [companyId,input.idempotencyKey,JSON.stringify(input)]);
  if(receipt.rows[0]){
    const saved=receipt.rows[0];
    if(!saved.same_payload)fail("مفتاح الحفظ مستخدم لطلب آخر؛ أعد إرسال الطلب الأصلي.");
    const target=await db.query("SELECT * FROM item_compositions WHERE company_id=$1 AND id=$2",
      [companyId,saved.composition_id]);
    return {composition:target.rows[0],itemIds:saved.item_ids as number[],
      updatedCount:saved.updated_count as number,created:saved.created_composition as boolean,replayed:true};
  }
  let target;
  if(input.targetCompositionId!==null){
    const chosen=await db.query("SELECT * FROM item_compositions WHERE company_id=$1 AND id=$2 FOR SHARE",
      [companyId,input.targetCompositionId]);
    target=chosen.rows[0];
    if(!target?.active)fail("التركيب المحدد غير فعال أو غير موجود في الشركة.");
    if(target.arabic_name.trim().toLowerCase()!==input.name.trim().toLowerCase())
      fail("تغير اسم التركيب المحدد؛ أعد اختياره من القائمة.");
  }else{
    const found=await db.query(
      "SELECT * FROM item_compositions WHERE company_id=$1 AND lower(btrim(arabic_name))=lower(btrim($2)) ORDER BY id FOR SHARE",
      [companyId,input.name]);
    if(found.rows.length>1)fail("يوجد أكثر من كرت بهذا الاسم؛ اختر الكرت المطلوب من النتائج.");
    target=found.rows[0];
    if(target&&!target.active)fail("يوجد تركيب مؤرشف بهذا الاسم؛ اختر تركيبًا فعالًا آخر.");
  }
  const ids=input.items.map(item=>item.id).sort((a,b)=>a-b);
  const selected=await db.query(
    "SELECT * FROM items WHERE company_id=$1 AND id=ANY($2::integer[]) ORDER BY id FOR UPDATE",
    [companyId,ids]);
  if(selected.rows.length!==ids.length)fail("بعض الأصناف المختارة غير موجودة في هذه الشركة؛ حدّث القائمة.");
  const expected=new Map(input.items.map(item=>[item.id,item]));
  for(const item of selected.rows){
    const old=expected.get(item.id)!;
    if(!item.active||item.composition_id!==old.expectedCompositionId||item.product_form!==old.expectedProductForm)
      fail("تغير تركيب أو شكل أحد الأصناف المختارة؛ ألغ الاختيار وحدّث القائمة ثم أعد المحاولة.");
  }
  const pinned=await db.query(
    "SELECT original_item_id FROM item_compositions WHERE company_id=$1 AND original_item_id=ANY($2::integer[]) AND ($3::integer IS NULL OR id<>$3)",
    [companyId,ids,target?.id??null]);
  if(pinned.rows.length)fail("أحد الأصناف محدد أورجنال في تركيبه السابق؛ ألغ تعيين الأورجنال قبل نقله.");
  const created=!target;
  if(!target){
    const payload={arabicName:input.name,englishName:input.name,productForm:input.productForm,
      description:"",saleNotes:"",active:true,identicalAlternative:false,
      nonInterchangeable:false,priceSplitThreshold:null,originalItemId:null,idempotencyKey:input.idempotencyKey};
    const added=await db.query(
      `INSERT INTO item_compositions(company_id,arabic_name,english_name,description,sale_notes,product_form,active,
       identical_alternative,non_interchangeable,created_by,idempotency_key,creation_payload)
       VALUES($1,$2,$2,'','',$3,true,false,false,$4,$5,$6) RETURNING *`,
      [companyId,input.name,input.productForm,user.id,input.idempotencyKey,JSON.stringify(payload)]);
    target=added.rows[0];
    await audit(db,user,"itemComposition.create","itemComposition",target.id,null,
      {arabicName:target.arabic_name,englishName:target.english_name,productForm:target.product_form},companyId);
  }
  const form=assignmentItemForm(target.product_form as ProductForm);
  const changed=selected.rows.filter(item=>item.composition_id!==target.id||item.product_form!==form);
  if(changed.length){
    await db.query(
      "UPDATE items SET composition_id=$1,product_form=$2,revision=revision+1,updated_at=GREATEST(updated_at,clock_timestamp()) WHERE company_id=$3 AND id=ANY($4::integer[])",
      [target.id,form,companyId,changed.map(item=>item.id)]);
    for(const item of changed){
      await audit(db,user,"item.update","item",item.id,
        {compositionId:item.composition_id,productForm:item.product_form},
        {compositionId:target.id,productForm:form},companyId);
      for(const [field,before,after] of [
        ["compositionId",item.composition_id,target.id],
        ["productForm",item.product_form,form],
      ] as const){
        if(before!==after)await audit(db,user,"item.field.update","item",item.id,
          {field,value:before},{field,value:after},companyId);
      }
    }
  }
  await db.query(
    `INSERT INTO item_composition_assignments(company_id,idempotency_key,payload,composition_id,
     item_ids,updated_count,created_composition,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [companyId,input.idempotencyKey,JSON.stringify(input),target.id,ids,changed.length,created,user.id]);
  return {composition:target,itemIds:ids,updatedCount:changed.length,created,replayed:false};
}
