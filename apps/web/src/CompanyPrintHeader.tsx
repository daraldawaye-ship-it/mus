import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { CompanyContext } from "../../../packages/contracts/src/index.ts";
import { api, useSession } from "./api";
import { isOfflineNow } from "./connection-mode";
import { readOfflineLetterheadImage, saveOfflineLetterheadImage } from "./offline-storage";

export interface CompanyLetterhead {
  mediaId: string | null;
  imageUrl: string | null;
  updatedAt: string | null;
}

/** Shared and company-scoped; metadata is cached for offline invoices. */
export function useCompanyLetterhead(companyId: number) {
  const { user } = useSession();
  return useQuery({
    queryKey: ["company-letterhead", user?.id, companyId],
    queryFn: ({ signal }) =>
      api<CompanyLetterhead>(`/companies/${companyId}/letterhead`, { signal }),
    enabled: !!user,
    networkMode: "always",
    staleTime: 60_000,
  });
}

/** Prefetch the company image while online, so the authenticated employee can
 * print the same letterhead from a saved receipt after connectivity is lost.
 * The device cache is keyed by user, company and exact media URL.
 */
export function usePreparedCompanyLetterhead(companyId:number, imageUrl:string|null|undefined) {
  const { user } = useSession();
  return useQuery({
    queryKey:["company-letterhead-image",user?.id,companyId,imageUrl??null],
    enabled:!!user && !!imageUrl,
    networkMode:"always",
    staleTime:60_000,
    queryFn:async ({signal}):Promise<Blob|null>=>{
      if (!user || !imageUrl || !/^\/api\/media\/[0-9a-f-]{36}\/full$/i.test(imageUrl))
        return null;
      if (!isOfflineNow()) {
        try {
          const response=await fetch(imageUrl,{
            credentials:"same-origin",signal,cache:"default",
          });
          if(response.ok) {
            const blob=await response.blob();
            if(blob.type.startsWith("image/") && blob.size<=5_000_000) {
              await saveOfflineLetterheadImage(user.id,companyId,imageUrl,blob).catch(()=>{});
              return blob;
            }
          }
        } catch {
          // A transport failure must not discard a previously saved header.
        }
      }
      return readOfflineLetterheadImage(user.id,companyId,imageUrl).catch(()=>null);
    },
  });
}

export function CompanyPrintHeader({
  context, onReady,
}: {
  context: CompanyContext;
  onReady?: () => void;
}) {
  const letterhead = useCompanyLetterhead(context.company.id);
  const imageUrl = letterhead.data?.imageUrl;
  const media = usePreparedCompanyLetterhead(context.company.id,imageUrl);
  const [blobUrl,setBlobUrl] = useState<string|null>(null);
  const [failedUrl,setFailedUrl] = useState<string|null>(null);
  useEffect(()=>{
    if(!media.data) {setBlobUrl(null);return;}
    const url=URL.createObjectURL(media.data);
    setBlobUrl(url);
    return ()=>URL.revokeObjectURL(url);
  },[media.data]);
  const showImage = !!imageUrl && !!blobUrl && failedUrl!==imageUrl;
  // The print button is enabled only after the actual header loaded, or after
  // the fallback text is known to be the only available header.
  useEffect(()=>{
    if(letterhead.isPending) return;
    if(!imageUrl || (!media.isPending && !media.data) || failedUrl===imageUrl)
      onReady?.();
  },[letterhead.isPending,imageUrl,media.isPending,media.data,failedUrl,onReady]);
  return (
    <div className="company-print-letterhead">
      {showImage ? (
        <img
          src={blobUrl!}
          alt={`ترويسة ${context.company.name}`}
          className="company-print-letterhead-image"
          loading="eager"
          decoding="sync"
          onLoad={()=>onReady?.()}
          onError={()=>{setFailedUrl(imageUrl!);onReady?.();}}
        />
      ) : (
        <div className="company-print-letterhead-fallback">
          <strong>{context.company.name}</strong>
          {context.company.phone && <span dir="ltr">{context.company.phone}</span>}
          {context.company.address && <span>{context.company.address}</span>}
        </div>
      )}
    </div>
  );
}
