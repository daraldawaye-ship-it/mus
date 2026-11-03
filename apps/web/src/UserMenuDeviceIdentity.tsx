import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { api } from "./api";
import { browserInstallationId } from "./company-device-discovery";
import { formatKnownDeviceCode } from "./device-display-code";

type OwnDevice = {ok:boolean;id:string;name:string};
/** Show the same registry device used by automatic discovery, including its assigned label.
 * If the device is unnamed, the server's globally unique registry ID is shareable
 * with management. The raw installation UUID never leaves the device in UI text. */
export function UserMenuDeviceIdentity({companyId,userId}:{
  companyId:number|null;userId:number;
}) {
  const [installationId] = useState(() => browserInstallationId());
  const [copied,setCopied] = useState(false);
  const [copyError,setCopyError] = useState(false);
  const ownDevice=useQuery({
    queryKey:["my-device-identity",userId,companyId,installationId],
    queryFn:()=>api<OwnDevice>("/companies/"+companyId+"/approved-devices/discover",{
      method:"POST",body:{deviceId:installationId},
    }),
    enabled:companyId!==null && !!installationId,
    refetchOnMount:"always",
    refetchOnWindowFocus:true,
    staleTime:0,
    retry:1,
  });
  const code=ownDevice.data?.id ? formatKnownDeviceCode(ownDevice.data.id) : "";
  const name=ownDevice.data?.name?.trim() ?? "";
  const copyCode=async()=>{
    if(!code) return;
    try {
      if(!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(code);
      setCopied(true);setCopyError(false);
    } catch {
      setCopyError(true);setCopied(false);
    }
  };
  return <div className="user-menu-device-identity" aria-label="هوية جهازك الحالي">
    {companyId===null ? (
      <small>افتح الشركة لعرض معرف الجهاز</small>
    ) : !installationId ? (
      <small>تعذر تحديد هذه النسخة من المتصفح</small>
    ) : ownDevice.data && code ? (
      <>
        <span className="user-menu-device-label" title={name || "جهاز لم تتم تسميته"}>
          <span className="user-menu-device-caption">{name ? "اسم الجهاز" : "معرف الجهاز غير المسمى"}</span>
          {name ? <strong dir="auto">{name}</strong> : <strong><bdi dir="ltr">{code}</bdi></strong>}
        </span>
        <button type="button" className="user-menu-device-copy"
          title={"نسخ رمز الجهاز "+code}
          aria-label={"نسخ معرف الجهاز "+code}
          onClick={()=>void copyCode()}><Copy size={14} aria-hidden="true" /></button>
        {copied && <span className="user-menu-device-feedback">تم النسخ</span>}
        {copyError && <span className="user-menu-device-feedback">انسخ الرمز من صفحة الأجهزة</span>}
      </>
    ) : ownDevice.isError ? (
      <button type="button" className="user-menu-device-retry"
        onClick={()=>void ownDevice.refetch()}>تعذر تحديد الجهاز — إعادة المحاولة</button>
    ) : <small>جارٍ التعرف على الجهاز…</small>}
  </div>;
}
