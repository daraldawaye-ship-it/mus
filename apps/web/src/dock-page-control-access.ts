type ContextAccess={general:boolean;company:{id:number}};
type PageControlEntry={
  key:string;scope:"company"|"public";enabled:boolean;critical:boolean;canConfigure:boolean;
  actionAccess:{view:boolean;edit:boolean};
};
export function dockPageControls({
  entry,centralPage,context,owner,preview,
}:{
  entry:PageControlEntry;centralPage?:PageControlEntry;context?:ContextAccess;
  owner:boolean;preview:boolean;
}){
  const open=entry.enabled&&entry.actionAccess.view&&!preview;
  const companyId=entry.scope==="company"?context?.company.id:undefined;
  const allowedCentral=!!(open&&companyId&&context?.general&&
    centralPage?.key==="company.central-access"&&centralPage.scope==="company"&&centralPage.enabled);
  return {
    companyId,
    settings:open&&!entry.critical&&entry.canConfigure&&(entry.scope==="company"?!!companyId:owner),
    centralRead:allowedCentral&&centralPage?.actionAccess.view===true,
    centralEdit:allowedCentral&&centralPage?.actionAccess.view===true&&centralPage.actionAccess.edit,
  };
}
