import {lazy,Suspense,useState,type ReactNode} from "react";
import {useQuery,useQueryClient} from "@tanstack/react-query";
import {accountCategoryLabels,accountKindLabels,type Account} from "../../../packages/contracts/src/index";
import {api} from "./api";
import {Button,Dialog,Notice} from "./ui";
import {rememberRecentEntity,type RecentEntity} from "./recent-entities";
import {useMasterChanges} from "./phase2";
import {dockAccountCardPath,dockVerifiedAccount} from "./dock-card-access";

const LedgerPreview=lazy(()=>import("./pages/AccountsPage").then(module=>({default:module.AccountLedgerPreview})));

const FullAccountEditor=lazy(()=>import("./pages/AccountsPage").then(module=>({default:module.AccountEditor})));

function DockAccountCard({actorId,companyId,accountId,canEdit,onClose}:{
  actorId:number;companyId:number;accountId:number;canEdit:boolean;onClose:()=>void;
}) {
  const client=useQueryClient();
  const changed=useMasterChanges(companyId);
  const cardKey=["dock-account-card",actorId,companyId,accountId] as const;
  const path=dockAccountCardPath(companyId,accountId);
  const query=useQuery({
    queryKey:cardKey, staleTime:0, refetchOnMount:"always",
    enabled:!!path, retry:false,
    queryFn:({signal})=>api<{account:Account}>(path!,{signal}),
  });
  const account=dockVerifiedAccount(query.data?.account,companyId,accountId);
  const summary=(content:ReactNode)=>
    <Dialog open title="كرت الحساب" className="invoice-item-sheet" onClose={onClose}>{content}</Dialog>;
  if(query.isError||!path)return summary(<Notice tone="warning">تعذّر التحقق من الحساب المحدد.</Notice>);
  if(query.isPending||!query.isFetchedAfterMount)return summary(<Notice>جارٍ تحميل الحساب…</Notice>);
  if(!account)return summary(<Notice tone="warning">تعذّر التحقق من الحساب المحدد.</Notice>);
  if(canEdit)return <Suspense fallback={summary(<Notice>جارٍ فتح تعديل الحساب…</Notice>)}>
    <FullAccountEditor companyId={companyId} account={account} onClose={onClose}
      onSaved={saved=>{
        const exact=dockVerifiedAccount(saved,companyId,accountId);
        if(exact){
          client.setQueryData(cardKey,{account:exact});
          rememberRecentEntity(actorId,companyId,"account",{id:exact.id,name:exact.name});
        }
        onClose();
        void changed();
      }} />
  </Suspense>;
  return summary(<dl className="details-list">
    <dt>الحساب</dt><dd>{account.name}</dd>
    <dt>رمز الحساب</dt><dd><bdi>{account.code}</bdi></dd>
    <dt>الفئة</dt><dd>{accountCategoryLabels[account.category]}</dd>
    <dt>النوع</dt><dd>{accountKindLabels[account.kind]}</dd>
    <dt>الحالة</dt><dd>{account.active?"فعال":"غير فعال"}</dd>
  </dl>);
}
export function DockAccountTools({actorId,companyId,selected,canCard,canLedger,canEdit}: {
  actorId:number;companyId:number;selected:RecentEntity|null;canCard:boolean;canLedger:boolean;canEdit:boolean;
}){
  const [card,setCard]=useState(false);
  const [ledger,setLedger]=useState(false);
  const valid=!!selected&&!!dockAccountCardPath(companyId,selected.id);
  const ledgerOpen=valid&&canLedger&&ledger;
  return <>
    <div className="work-panel-entity-actions">
      <Button size="compact" variant="secondary" disabled={!valid||!canCard} title={!canCard?"لا يتوفر إذن عرض كرت الحساب":!valid?"اختر حسابًا أولًا":undefined}
        onClick={()=>setCard(true)}>كرت الحساب</Button>
      <Button size="compact" variant={ledgerOpen?"primary":"secondary"} disabled={!valid||!canLedger}
        title={!canLedger?"لا يتوفر إذن عرض كشف الحساب":!valid?"اختر حسابًا أولًا":undefined}
        aria-expanded={ledgerOpen} onClick={()=>setLedger(before=>!before)}>كشف الحساب</Button>
    </div>
    {valid&&(!canCard||!canLedger)&&<small className="muted">
      لا يتوفر إذن عرض {!canCard&&!canLedger?"كرت الحساب أو كشف الحساب":!canCard?"كرت الحساب":"كشف الحساب"}.
    </small>}
    {ledgerOpen&&selected&&<div className="work-panel-account-ledger">
      <Suspense fallback={<Notice>جارٍ فتح كشف الحساب…</Notice>}>
        <LedgerPreview companyId={companyId} account={selected} hideFullLink />
      </Suspense>
    </div>}
    {valid&&canCard&&card&&selected&&<DockAccountCard actorId={actorId} companyId={companyId}
      accountId={selected.id} canEdit={canEdit} onClose={()=>setCard(false)} />}
  </>;
}
