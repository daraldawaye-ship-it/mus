import { Router } from "express";
import { z } from "zod";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { User } from "../../../packages/contracts/src/index.ts";
import { actor, handler, id, parse } from "./http.ts";
import { transaction } from "./db.ts";
import { currentActor, ownerOnly } from "./policies/access.ts";
import { HttpError, missing } from "./errors.ts";

const integer = z.number().int().positive().max(2147483647);
const acl = z.object({
  users: z.array(integer).max(300).default([]),
  kinds: z.array(z.enum(["admin", "supervisor", "member"])).max(3).default([]),
}).strict().nullable();
const nodeFields = z.object({
  title: z.string().max(500).default(""),
  body: z.string().max(250000).default(""),
  evidence: z.string().max(100000).default(""),
  kind: z.enum(["heading","paragraph"]).default("paragraph"),
  color: z.union([z.literal(""),z.string().regex(/^#[0-9a-fA-F]{6}$/)]).nullable().default(null),
  fontSize: z.number().int().min(10).max(36).nullable().default(null),
  readAcl: acl.default(null),
  editAcl: acl.default(null),
}).strict();
const groupFields = z.object({
  title: z.string().trim().min(1).max(250),
  slug: z.string().regex(/^[a-z][a-z0-9-]{2,119}$/),
  defaultRead: acl.default(null),
  defaultEdit: acl.default(null),
}).strict();
const createNode = nodeFields.extend({
  groupId: integer, parentId: integer.nullable().default(null),
  afterId: integer.nullable().default(null),
});
const imageTypes = new Set(["image/png","image/jpeg","image/webp","application/pdf"]);
type Rule = { users?:number[]; kinds?:string[] } | null;
type NodeRow = QueryResultRow & {id:number;group_id:number;parent_id:number|null;position:number;read_acl:Rule;edit_acl:Rule};
function match(user:User, rule:Rule, fallback:boolean):boolean {
  if(user.owner) return true;
  if(user.suspended) return false;
  return rule===null ? fallback : !!(rule.users?.includes(user.id) || rule.kinds?.includes(user.kind));
}
function grants(user:User, read:Rule, edit:Rule, parent:{read:boolean;edit:boolean}) {
  const editAllowed=parent.read && match(user,edit,parent.edit);
  const readAllowed=parent.read && (match(user,read,parent.read) || editAllowed);
  return {read:readAllowed,edit:editAllowed};
}
async function groupById(db:Pool|PoolClient,groupId:number) {
  const group=(await db.query("SELECT * FROM explanation_groups WHERE id=$1",[groupId])).rows[0];
  if(!group)missing();
  return group;
}
function groupGrant(user:User,group:QueryResultRow) {
  const edit=user.owner || match(user,group.default_edit as Rule,false);
  const read=user.owner || edit || match(user,group.default_read as Rule,false);
  return {read,edit};
}
async function nodeAccess(db:Pool|PoolClient,user:User,nodeId:number) {
  const target=(await db.query("SELECT * FROM explanation_nodes WHERE id=$1",[nodeId])).rows[0] as NodeRow|undefined;
  if(!target)missing();
  const group=await groupById(db,target.group_id);
  const permissions=groupGrant(user,group);
  const ancestors:NodeRow[]=[];
  let current:NodeRow|undefined=target;
  const seen=new Set<number>();
  while(current){
    if(seen.has(current.id))throw new HttpError(409,"cycle","علاقة العناوين دائرية");
    seen.add(current.id);ancestors.unshift(current);
    current=current.parent_id===null?undefined:(await db.query("SELECT * FROM explanation_nodes WHERE id=$1 AND group_id=$2",[current.parent_id,target.group_id])).rows[0] as NodeRow|undefined;
    if(ancestors.length>30)throw new HttpError(409,"depth","عدد مستويات الشرح كبير جدًا");
  }
  let granted=permissions;
  for(const node of ancestors)granted=grants(user,node.read_acl,node.edit_acl,granted);
  return {node:target,group,permissions:granted};
}
function requireRead(allowed:boolean) {if(!allowed)missing();}
function requireEdit(allowed:boolean) {if(!allowed)throw new HttpError(403,"explanation_forbidden","لا تملك صلاحية تعديل هذا السجل");}
const nodeOutput=(r:QueryResultRow,permissions:{read:boolean;edit:boolean})=>({
  id:r.id,groupId:r.group_id,parentId:r.parent_id,position:r.position,kind:r.kind,
  title:r.title,preview:r.preview??"",color:r.color,fontSize:r.font_size,
  readAcl:permissions.edit?r.read_acl:null,editAcl:permissions.edit?r.edit_acl:null,canEdit:permissions.edit,
  updatedAt:r.updated_at,
});
export function explanationRoutes(pool:Pool):Router {
  const router=Router();
  router.get("/explanations/users",handler(async(req,res)=>{
    ownerOnly(actor(req));
    const records=await pool.query("SELECT id,display_name AS name,kind FROM users WHERE NOT archived ORDER BY display_name LIMIT 500");
    res.json({items:records.rows});
  }));
  router.get("/explanations/groups",handler(async(req,res)=>{
    const user=actor(req);
    const rows=await pool.query("SELECT * FROM explanation_groups ORDER BY id");
    res.json({items:rows.rows.filter(g=>groupGrant(user,g).read).map(g=>({
      id:g.id,slug:g.slug,title:g.title,canEdit:groupGrant(user,g).edit,
      defaultRead:user.owner?g.default_read:null,defaultEdit:user.owner?g.default_edit:null,
    }))});
  }));
  router.post("/explanations/groups",handler(async(req,res)=>{
    const user=actor(req);ownerOnly(user);
    const input=parse(groupFields,req.body);
    const result=await pool.query(
      "INSERT INTO explanation_groups(slug,title,default_read,default_edit,created_by) VALUES($1,$2,$3::jsonb,$4::jsonb,$5) RETURNING id",
      [input.slug,input.title,JSON.stringify(input.defaultRead),JSON.stringify(input.defaultEdit),user.id]);
    res.status(201).json({id:result.rows[0].id});
  }));
  router.patch("/explanations/groups/:groupId",handler(async(req,res)=>{
    const user=actor(req);ownerOnly(user);
    const data=parse(groupFields.omit({slug:true}),req.body);
    const updated=await pool.query("UPDATE explanation_groups SET title=$1,default_read=$2::jsonb,default_edit=$3::jsonb,updated_at=now() WHERE id=$4 RETURNING id",
      [data.title,JSON.stringify(data.defaultRead),JSON.stringify(data.defaultEdit),id(req.params.groupId)]);
    if(!updated.rowCount)missing();
    res.json({ok:true});
  }));
  router.get("/explanations/groups/:groupId/tree",handler(async(req,res)=>{
    const user=actor(req),groupId=id(req.params.groupId);
    const group=await groupById(pool,groupId);
    const base=groupGrant(user,group);requireRead(base.read);
    const rows=(await pool.query("SELECT id,group_id,parent_id,position,kind,title,LEFT(body,180) AS preview,color,font_size,read_acl,edit_acl,updated_at FROM explanation_nodes WHERE group_id=$1 ORDER BY position,id",[groupId])).rows as NodeRow[];
    const byParent=new Map<number|null,NodeRow[]>();
    for(const n of rows) {const siblings=byParent.get(n.parent_id)??[];siblings.push(n);byParent.set(n.parent_id,siblings);}
    const output:ReturnType<typeof nodeOutput>[]=[];
    function visit(parent:number|null,permissions:{read:boolean;edit:boolean},depth:number) {
      if(depth>30)return;
      for(const n of byParent.get(parent)??[]){
        const granted=grants(user,n.read_acl,n.edit_acl,permissions);
        if(!granted.read)continue;
        output.push(nodeOutput(n,granted));
        visit(n.id,granted,depth+1);
      }
    }
    visit(null,base,0);
    res.json({group:{id:group.id,slug:group.slug,title:group.title,canEdit:base.edit,
      defaultRead:user.owner?group.default_read:null,defaultEdit:user.owner?group.default_edit:null},
      items:output});
  }));

  // Independent reader endpoint: one main subject at a time, no asset bytes.
  // Visibility is checked throughout the tree to avoid leaking hidden paragraphs.
  router.get("/explanations/topics/:topicId",handler(async(req,res)=>{
    const user=actor(req),topicId=id(req.params.topicId);
    const access=await nodeAccess(pool,user,topicId);
    requireRead(access.permissions.read);
    if(access.node.parent_id!==null)missing();
    const tree=(await pool.query(
      `WITH RECURSIVE descendants AS (
        SELECT * FROM explanation_nodes WHERE id=$1
        UNION ALL
        SELECT n.* FROM explanation_nodes n JOIN descendants d ON n.parent_id=d.id
      ) SELECT * FROM descendants`,[topicId])).rows as NodeRow[];
    const children=new Map<number,NodeRow[]>();
    for(const n of tree) {
      if(n.id===topicId || n.parent_id===null)continue;
      const siblings=children.get(n.parent_id)??[];
      siblings.push(n);children.set(n.parent_id,siblings);
    }
    for(const siblings of children.values())siblings.sort((a,b)=>a.position-b.position||a.id-b.id);
    const visible:NodeRow[]=[access.node];
    function visit(parent:NodeRow,permissions:{read:boolean;edit:boolean},depth:number) {
      if(depth>30)return;
      for(const node of children.get(parent.id)??[]){
        const rights=grants(user,node.read_acl,node.edit_acl,permissions);
        if(!rights.read)continue;
        visible.push(node);
        visit(node,rights,depth+1);
      }
    }
    visit(access.node,access.permissions,0);
    const ids=visible.map(n=>n.id);
    const files=await pool.query(
      'SELECT id,node_id,filename,display_name AS "displayName",mime_type AS "mimeType" FROM explanation_assets WHERE node_id=ANY($1::integer[]) ORDER BY created_at,id',
      [ids]);
    const byNode=new Map<number,QueryResultRow[]>();
    for(const file of files.rows) {
      const list=byNode.get(file.node_id)??[];list.push(file);byNode.set(file.node_id,list);
    }
    const topics=(await pool.query(
      'SELECT id,title,position,read_acl,edit_acl FROM explanation_nodes WHERE group_id=$1 AND parent_id IS NULL ORDER BY position,id',[access.node.group_id])).rows;
    const base=groupGrant(user,access.group);
    res.json({
      group:{id:access.group.id,title:access.group.title,slug:access.group.slug},
      topicId,
      topics:topics.filter(t=>grants(user,t.read_acl,t.edit_acl,base).read)
        .map(t=>({id:t.id,title:t.title,position:t.position})),
      nodes:visible.map(n=>({
        id:n.id,parentId:n.parent_id,position:n.position,kind:n.kind,title:n.title,
        body:n.body,evidence:n.evidence,color:n.color,fontSize:n.font_size,
        canEdit:grants(user,n.read_acl,n.edit_acl,n.id===topicId?base:access.permissions).edit,
        assets:byNode.get(n.id)??[],
      })),
    });
  }));

  router.get("/explanations/nodes/:nodeId",handler(async(req,res)=>{
    const user=actor(req);
    const {node,permissions}=await nodeAccess(pool,user,id(req.params.nodeId));
    requireRead(permissions.read);
    const assets=await pool.query("SELECT id,filename,display_name AS \"displayName\",mime_type AS \"mimeType\" FROM explanation_assets WHERE node_id=$1 ORDER BY id",[node.id]);
    res.json({record:{...nodeOutput(node,permissions),body:node.body,evidence:node.evidence,
      readAcl:permissions.edit?node.read_acl:null,editAcl:permissions.edit?node.edit_acl:null},assets:assets.rows});
  }));
  router.post("/explanations/nodes",handler(async(req,res)=>{
    const input=parse(createNode,req.body),user=actor(req);
    const result=await transaction(pool,async(client)=>{
      await client.query("SELECT id FROM explanation_groups WHERE id=$1 FOR UPDATE",[input.groupId]);
      const group=await groupById(client,input.groupId);
      const base=groupGrant(user,group);
      const parent=input.parentId===null?null:await nodeAccess(client,user,input.parentId);
      if(parent&&parent.node.group_id!==input.groupId)throw new HttpError(400,"parent","العنوان الأب من مجموعة أخرى");
      requireEdit(parent?parent.permissions.edit:base.edit);
      let order:number;
      if(input.afterId!==null){
        const after=await nodeAccess(client,user,input.afterId);
        if(after.node.group_id!==input.groupId||after.node.parent_id!==input.parentId)
          throw new HttpError(400,"after","السجل المحدد ليس على المستوى نفسه");
        requireEdit(after.permissions.edit);
        order=after.node.position+1;
      } else {
        const max=await client.query("SELECT coalesce(max(position),0)::int AS n FROM explanation_nodes WHERE group_id=$1 AND parent_id IS NOT DISTINCT FROM $2",[input.groupId,input.parentId]);
        order=max.rows[0].n+1;
      }
      await client.query("UPDATE explanation_nodes SET position=position+1 WHERE group_id=$1 AND parent_id IS NOT DISTINCT FROM $2 AND position >= $3",[input.groupId,input.parentId,order]);
      const inserted=await client.query(
        "INSERT INTO explanation_nodes(group_id,parent_id,position,kind,title,body,evidence,color,font_size,read_acl,edit_acl,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$12) RETURNING id",
        [input.groupId,input.parentId,order,input.kind,input.title,input.body,input.evidence,input.color||null,input.fontSize,
        JSON.stringify(input.readAcl),JSON.stringify(input.editAcl),user.id]);
      return inserted.rows[0].id as number;
    });
    res.status(201).json({id:result});
  }));
  router.patch("/explanations/nodes/:nodeId",handler(async(req,res)=>{
    const input=parse(nodeFields,req.body),user=actor(req),nodeId=id(req.params.nodeId);
    await transaction(pool,async(client)=>{
      const {permissions}=await nodeAccess(client,user,nodeId);requireEdit(permissions.edit);
      await client.query("UPDATE explanation_nodes SET kind=$2,title=$3,body=$4,evidence=$5,color=$6,font_size=$7,read_acl=$8::jsonb,edit_acl=$9::jsonb,updated_by=$10,updated_at=now() WHERE id=$1",
        [nodeId,input.kind,input.title,input.body,input.evidence,input.color||null,input.fontSize,JSON.stringify(input.readAcl),JSON.stringify(input.editAcl),user.id]);
    });
    res.json({ok:true});
  }));
  router.delete("/explanations/nodes/:nodeId",handler(async(req,res)=>{
    const user=actor(req),nodeId=id(req.params.nodeId);
    await transaction(pool,async(client)=>{
      const {node,permissions}=await nodeAccess(client,user,nodeId);requireEdit(permissions.edit);
      await client.query("SELECT id FROM explanation_groups WHERE id=$1 FOR UPDATE",[node.group_id]);
      const child=await client.query("SELECT 1 FROM explanation_nodes WHERE parent_id=$1 LIMIT 1",[nodeId]);
      if(child.rowCount)throw new HttpError(409,"has_children","احذف الفروع التابعة أولًا");
      await client.query("DELETE FROM explanation_nodes WHERE id=$1",[nodeId]);
      await client.query("UPDATE explanation_nodes SET position=position-1 WHERE group_id=$1 AND parent_id IS NOT DISTINCT FROM $2 AND position>$3",[node.group_id,node.parent_id,node.position]);
    });
    res.json({ok:true});
  }));
  router.post("/explanations/nodes/:nodeId/assets",handler(async(req,res)=>{
    const input=parse(z.object({filename:z.string().trim().min(1).max(250),displayName:z.string().trim().min(1).max(250).optional(),dataUrl:z.string().max(14100000)}).strict(),req.body);
    const matchData=/^data:(image\/png|image\/jpeg|image\/webp|application\/pdf);base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.dataUrl);
    if(!matchData||!imageTypes.has(matchData[1]))throw new HttpError(400,"file_type","يسمح بالصور وPDF فقط");
    const binary=Buffer.from(matchData[2],"base64");
    const mime=matchData[1],header=binary.subarray(0,12);
    const valid=mime==="application/pdf"?header.subarray(0,5).toString()==="%PDF-":
      mime==="image/png"?header.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
      mime==="image/jpeg"?header[0]===255&&header[1]===216&&header[2]===255:
      header.subarray(0,4).toString()==="RIFF"&&header.subarray(8,12).toString()==="WEBP";
    if(!valid||binary.length<10||binary.length>10485760)throw new HttpError(400,"invalid_asset","ملف غير صالح أو يتجاوز 10MB");
    const user=actor(req),nodeId=id(req.params.nodeId);
    const result=await transaction(pool,async(client)=>{
      const {permissions}=await nodeAccess(client,user,nodeId);requireEdit(permissions.edit);
      return client.query("INSERT INTO explanation_assets(node_id,filename,display_name,mime_type,content,uploaded_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[nodeId,input.filename,input.displayName||input.filename,mime,binary,user.id]);
    });
    res.status(201).json({id:result.rows[0].id});
  }));

  router.patch("/explanations/assets/:assetId",handler(async(req,res)=>{
    const input=parse(z.object({displayName:z.string().trim().min(1).max(250)}).strict(),req.body);
    const assetId=id(req.params.assetId);
    const record=(await pool.query("SELECT node_id FROM explanation_assets WHERE id=$1",[assetId])).rows[0];
    if(!record)missing();
    const rights=await nodeAccess(pool,actor(req),record.node_id);requireEdit(rights.permissions.edit);
    await pool.query("UPDATE explanation_assets SET display_name=$1 WHERE id=$2",[input.displayName,assetId]);
    res.json({ok:true});
  }));
  router.delete("/explanations/assets/:assetId",handler(async(req,res)=>{
    const assetId=id(req.params.assetId);
    const record=(await pool.query("SELECT node_id FROM explanation_assets WHERE id=$1",[assetId])).rows[0];
    if(!record)missing();
    const rights=await nodeAccess(pool,actor(req),record.node_id);requireEdit(rights.permissions.edit);
    await pool.query("DELETE FROM explanation_assets WHERE id=$1",[assetId]);
    res.json({ok:true});
  }));

  router.get("/explanations/assets/:assetId",handler(async(req,res)=>{
    const asset=(await pool.query("SELECT * FROM explanation_assets WHERE id=$1",[id(req.params.assetId)])).rows[0];
    if(!asset)missing();
    const {permissions}=await nodeAccess(pool,actor(req),asset.node_id);
    requireRead(permissions.read);
    res.setHeader("Cache-Control","private, no-store");
    res.setHeader("Content-Security-Policy","default-src 'none'; sandbox");
    res.setHeader("Content-Disposition",`inline; filename="explanation-${asset.id}"`);
    res.type(asset.mime_type);res.send(asset.content);
  }));
  router.post("/explanations/nodes/:nodeId/links",handler(async(req,res)=>{
    const user=actor(req);ownerOnly(user);
    const data=parse(z.object({targetType:z.enum(["legal_case","legal_record","page"]),targetKey:z.string().trim().min(1).max(120)}).strict(),req.body);
    const {node}=await nodeAccess(pool,user,id(req.params.nodeId));
    await pool.query("INSERT INTO explanation_links(group_id,node_id,target_type,target_key) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",[node.group_id,node.id,data.targetType,data.targetKey]);
    res.json({ok:true});
  }));
  return router;
}
