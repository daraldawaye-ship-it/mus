import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { CompanyContext } from "../../../packages/contracts/src/index.ts";
import { api, useScopeGuard, useSession } from "./api";
import { useCompanyLogo } from "./CompanyLogo";
import { ImageUpload } from "./ImageUpload";
import { errorMessage } from "./phase2";
import { Button, Card, Notice } from "./ui";

/** Separate from the full-width print letterhead, so editing the logo never removes it. */
export function CompanyLogoSettings({context}:{context:CompanyContext}) {
  const {user}=useSession();
  const company=context.company;
  const queryClient=useQueryClient();
  const guard=useScopeGuard(`company:${company.id}:logo`);
  const logo=useCompanyLogo(company.id);
  const isOwner=!!user && (user.owner || company.createdBy===user.id);
  const [pendingMediaId,setPendingMediaId]=useState<string|null|undefined>();
  const [preview,setPreview]=useState<string|null>(null);
  const [iconPreview,setIconPreview]=useState<string|null>(null);
  const [saving,setSaving]=useState(false);
  const [success,setSuccess]=useState("");
  const [error,setError]=useState("");
  const currentPreview=pendingMediaId===undefined?logo.data?.imageUrl:pendingMediaId===null?null:preview;
  const currentIcon=pendingMediaId===undefined?logo.data?.iconUrl:pendingMediaId===null?null:iconPreview;

  async function save(){
    if(!isOwner||saving||pendingMediaId===undefined)return;
    setSaving(true);setError("");setSuccess("");
    try {
      await api(`/companies/${company.id}/logo`,{
        method:"PUT",body:{mediaId:pendingMediaId},signal:guard.signal,
      });
      if(!guard.isCurrent())return;
      await queryClient.invalidateQueries({queryKey:["company-logo",user?.id,company.id]});
      if(!guard.isCurrent())return;
      setPendingMediaId(undefined);setPreview(null);setIconPreview(null);
      setSuccess("حُفظ شعار الشركة وأيقونتها؛ يظهر الشعار بجانب اسم الشركة في الموقع.");
    }catch(e){if(guard.isCurrent())setError(errorMessage(e));}
    finally{if(guard.isCurrent())setSaving(false);}
  }

  return <section id="company-logo-settings">
    <Card title="شعار الشركة وأيقونتها">
      <p className="muted">الشعار مستقل عن صورة الترويسة العريضة، وتُستخدم أيقونته المربعة في عنوان الشركة وأيقونة المتصفح عند الدخول إليها.</p>
      {logo.isLoading&&<Notice>جارٍ تحميل شعار الشركة…</Notice>}
      {logo.error&&<Notice tone="error">{errorMessage(logo.error)}</Notice>}
      {error&&<Notice tone="error">{error}</Notice>}
      {success&&<Notice tone="success">{success}</Notice>}
      {!isOwner&&<Notice>يمكنك مشاهدة الشعار؛ تغييره متاح لمالك الشركة فقط.</Notice>}
      {isOwner?
        <>
          <ImageUpload purpose="logo" companyId={company.id}
            preview={currentPreview} disabled={saving} label="شعار الشركة"
            buttonLabel={currentPreview?"تغيير شعار الشركة":"إضافة شعار الشركة"}
            onUploaded={asset=>{setPendingMediaId(asset.id);setPreview(asset.fullUrl);
              setIconPreview(asset.thumbnailUrl);setSuccess("");setError("");}}
            onClear={()=>{setPendingMediaId(null);setPreview(null);
              setIconPreview(null);setSuccess("");}}
          />
          {currentIcon&&<div className="company-logo-icon-preview">
            <span>الأيقونة المصغّرة:</span>
            <img src={currentIcon} alt={`أيقونة ${company.name}`}
              style={{width:64,height:64,objectFit:"contain",background:"transparent"}} />
          </div>}
          <div className="form-actions">
            <Button type="button" disabled={saving||logo.isLoading||pendingMediaId===undefined}
              onClick={()=>void save()}>{saving?"جارٍ حفظ الشعار…":"حفظ شعار الشركة"}</Button>
          </div>
        </>:
        currentPreview?<img src={currentPreview} alt={`شعار ${company.name}`}
          style={{maxWidth:260,maxHeight:260,objectFit:"contain"}}/>:
          !logo.isLoading&&!logo.error?<Notice>لم يُحدد شعار لهذه الشركة بعد.</Notice>:null
      }
    </Card>
  </section>;
}
