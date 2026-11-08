import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { api, useSession } from "./api";

export interface CompanyLogo {
  mediaId: string | null;
  imageUrl: string | null;
  iconUrl: string | null;
  updatedAt: string | null;
}

/** Logo metadata is scoped to the signed-in user and the active company. */
export function useCompanyLogo(companyId:number|null) {
  const {user}=useSession();
  return useQuery({
    queryKey:["company-logo",user?.id,companyId],
    queryFn:({signal})=>api<CompanyLogo>(`/companies/${companyId}/logo`,{signal}),
    enabled:!!user && companyId!==null,
    staleTime:60_000,
    networkMode:"always",
  });
}

/** Only replace the favicon while the visitor is inside a company. */
export function useCompanyLogoFavicon(iconUrl:string|null|undefined) {
  useEffect(()=>{
    const elements=[
      ...document.querySelectorAll<HTMLLinkElement>('link[rel="icon"],link[rel="apple-touch-icon"]'),
    ];
    for(const element of elements){
      element.href=iconUrl||"/site-icon.png";
      // A favicon can also be a generated WEBP; the browser sniffs the type.
      if(element.rel==="icon")element.removeAttribute("type");
    }
    return ()=>{
      for(const element of elements)element.href="/site-icon.png";
    };
  },[iconUrl]);
}
