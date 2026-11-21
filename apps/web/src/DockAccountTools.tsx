import {lazy,Suspense,useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {accountCategoryLabels,accountKindLabels,type Account} from "../../../packages/contracts/src/index";
import {api} from "./api";
import {Button,Dialog,Notice} from "./ui";
import type {RecentEntity} from "./recent-entities";
import {dockAccountCardPath,dockVerifiedAccount} from "./dock-card-access";

const LedgerPreview=lazy(()=>import("./pages/AccountsPage").then(module=>({default:module.AccountLedgerPreview})));

function DockAccountCard({actorId,companyId,accountId}:{actorId:number;companyId:number;accountId:number}) {
  const path=dockAccountCardPath(companyId,accountId);
  const query=useQuery({
    queryKey:["dock-account-card",actorId,companyId,accountId],
    enabled:!!path, retry:false,
    queryFn:({signal})=>api<{account:Account}>(path!,{signal}),
  });
  const account=dockVerifiedAccount(query.data?.account,companyId,accountId);
  if(query.isPending && path)return <Notice>جارٍ تحميل الحساب…</Notice>;
  if(!account||query.isError)return <Notice tone="warning">تعذّر التحقق من الحساب المحدد.</Notice>;
  return <dl className="details-list">
    <dt>الحساب</dt><dd>{account.name}</dd>
    <dt>رمز الحساب</dt><dd><bdi>{account.code}</bdi></dd>
    <dt>الفئة</dt><dd>{accountCategoryLabels[account.category]}</dd>
    <dt>النوع</dt><dd>{accountKindLabels[account.kind]}</dd>
    <dt>الحالة</dt><dd>{account.active?"فعال":"غير فعال"}</dd>
  </dl>;
}
export function DockAccountTools({actorId,companyId,selected,canCard,canLedger}:{
  actorId:number;companyId:number;selected:RecentEntity|null;canCard:boolean;canLedger:boolean;
}){
  const [card,setCard]=useState(false);
  const [ledger,setLedger]=useState(false);
  const valid=!!selected&&!!dockAccountCardPath(companyId,selected.id);
  const ledgerOpen=valid&&canLedger&&ledger;
  return <>
    <div className="work-panel-entity-actions">
      <Button size="compact" variant="secondary" disabled={!valid||!canCard} onClick={()=>setCard(true)}>كرت الحساب</Button>
      <Button size="compact" variant={ledgerOpen?"primary":"secondary"} disabled={!valid||!canLedger}
        aria-expanded={ledgerOpen} onClick={()=>setLedger(before=>!before)}>كشف الحساب</Button>
    </div>
    {ledgerOpen&&selected&&<div className="work-panel-account-ledger">
      <Suspense fallback={<Notice>جارٍ فتح كشف الحساب…</Notice>}>
        <LedgerPreview companyId={companyId} account={selected} hideFullLink />
      </Suspense>
    </div>}
    <Dialog open={valid&&canCard&&card} title="كرت الحساب" className="invoice-item-sheet" onClose={()=>setCard(false)}>
      {valid&&canCard&&card&&selected&&<DockAccountCard actorId={actorId} companyId={companyId} accountId={selected.id} />}
    </Dialog>
  </>;
}
