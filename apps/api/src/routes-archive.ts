import { Router } from "express";
import { compressArchiveGif } from "./archive-gif.ts";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "./db.ts";
import { actor, handler, id, parse } from "./http.ts";
import { HttpError, missing } from "./errors.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import { directoryEntries, assertDirectoryAccess } from "./services/pages.ts";
import { audit } from "./services/audit.ts";
import type { User } from "../../../packages/contracts/src/index.ts";

const positive=z.number().int().positive().max(2147483647);
const scope=z.object({companyId:positive.nullable()}).strict();
const upload=scope.extend({
  category:z.string().trim().min(1).max(200),
  title:z.string().trim().min(1).max(300),
  filename:z.string().trim().max(255),
  dataUrl:z.string().min(30).max(36_000_000),
}).strict();
const edit=z.object({
  contentText:z.string().max(500_000),
  evidenceText:z.string().max(500_000),
  revision:positive,
}).strict();
const categoryEdit=z.object({showInLegal:z.boolean()}).strict();

function optionalScope(value:unknown):number|null {
  return value===undefined||value===null||value===""?null:id(String(value));
}

async function ensureAccess(db:Pool|PoolClient,user:User,companyId:number|null,action:"view"|"create"|"edit"){
  if(companyId!==null)await companyAccess(db,user,companyId);
  const key=companyId===null?"public.archive":"company.archive";
  const page=(await directoryEntries(db,user,companyId)).find(p=>p.key===key);
  if(!page)missing();
  assertDirectoryAccess(page,action);
}
/** Include the shared public archive in company listings only for viewers
 * who can already open those same public records directly. */
async function canViewPublicArchive(db:Pool|PoolClient,user:User):Promise<boolean>{
  const page=(await directoryEntries(db,user,null)).find(p=>p.key==="public.archive");
  return !!page?.enabled && !!page.actionAccess.view;
}

const supportedExtensions:Record<string,string[]> = {
  pdf:["application/pdf"],
  jpg:["image/jpeg"],jpeg:["image/jpeg"],png:["image/png"],webp:["image/webp"],gif:["image/gif"],
  zip:["application/zip","application/x-zip-compressed","application/octet-stream"],
  rar:["application/vnd.rar","application/x-rar-compressed","application/octet-stream"],
  "7z":["application/x-7z-compressed","application/octet-stream"],
  doc:["application/msword","application/octet-stream"],
  docx:["application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/zip","application/octet-stream"],
  xls:["application/vnd.ms-excel","application/octet-stream"],
  xlsx:["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","application/zip","application/octet-stream"],
  ppt:["application/vnd.ms-powerpoint","application/octet-stream"],
  pptx:["application/vnd.openxmlformats-officedocument.presentationml.presentation","application/zip","application/octet-stream"],
  txt:["text/plain","application/octet-stream"],
  csv:["text/csv","text/plain","application/vnd.ms-excel","application/octet-stream"],
  rtf:["application/rtf","text/rtf","application/octet-stream"],
  mp3:["audio/mpeg","audio/mp3","application/octet-stream"],
  wav:["audio/wav","audio/x-wav","audio/wave","application/octet-stream"],
  ogg:["audio/ogg","video/ogg","application/ogg","application/octet-stream"],
  m4a:["audio/mp4","audio/x-m4a","application/octet-stream"],
  aac:["audio/aac","application/octet-stream"],
  flac:["audio/flac","audio/x-flac","application/octet-stream"],
  mp4:["video/mp4","application/octet-stream"],
  webm:["video/webm","audio/webm","application/octet-stream"],
  mov:["video/quicktime","application/octet-stream"],
};
function decodeFile(dataUrl:string,filename:string){
  const extension=filename.split(".").pop()?.toLowerCase()??"";
  const mimeMatch=/^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(dataUrl);
  if(!mimeMatch||!supportedExtensions[extension]?.includes(mimeMatch[1].toLowerCase()))
    throw new HttpError(400,"unsupported_file","امتداد الملف أو نوعه غير مدعوم");
  const bytes=Buffer.from(mimeMatch[2],"base64"),mime=mimeMatch[1].toLowerCase();
  if(!bytes.length||bytes.length>25*1024*1024||bytes.toString("base64")!==mimeMatch[2])
    throw new HttpError(400,"invalid_file","الملف غير صالح أو أكبر من 25 ميجابايت");
  const head=bytes.subarray(0,16);
  const starts=(signature:number[])=>signature.every((byte,index)=>head[index]===byte);
  const zip=starts([0x50,0x4b,0x03,0x04])||starts([0x50,0x4b,0x05,0x06])||starts([0x50,0x4b,0x07,0x08]);
  const ole=starts([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]);
  const signatures:Record<string,boolean>={
    jpg:starts([255,216,255]),jpeg:starts([255,216,255]),
    png:starts([137,80,78,71,13,10,26,10]),
    webp:head.subarray(0,4).toString()==="RIFF"&&head.subarray(8,12).toString()==="WEBP",
    gif:["GIF87a","GIF89a"].includes(head.subarray(0,6).toString()),
    pdf:head.subarray(0,5).toString()==="%PDF-",
    zip,docx:zip,xlsx:zip,pptx:zip,
    rar:starts([0x52,0x61,0x72,0x21,0x1a,0x07]),
    "7z":starts([0x37,0x7a,0xbc,0xaf,0x27,0x1c]),
    doc:ole,xls:ole,ppt:ole,
    wav:head.subarray(0,4).toString()==="RIFF"&&head.subarray(8,12).toString()==="WAVE",
    ogg:head.subarray(0,4).toString()==="OggS",
    flac:head.subarray(0,4).toString()==="fLaC",
    mp3:head.subarray(0,3).toString()==="ID3"||(bytes[0]===255&&(bytes[1]&0xe0)===0xe0),
    mp4:head.subarray(4,8).toString()==="ftyp",
    m4a:head.subarray(4,8).toString()==="ftyp",
    mov:head.subarray(4,8).toString()==="ftyp",
    webm:starts([0x1a,0x45,0xdf,0xa3]),
    aac:bytes[0]===255&&(bytes[1]&0xf0)===0xf0,
  };
  if(extension in signatures&&!signatures[extension])
    throw new HttpError(400,"invalid_file","امتداد الملف لا يطابق محتواه");
  return {bytes,mime};
}

async function findFile(db:Pool|PoolClient,fileId:number,withBytes=false) {
  const result=await db.query(
    `SELECT f.id,f.company_id,f.category_id,f.title,f.original_filename,f.mime_type,
       f.content_text,f.evidence_text,f.created_by,f.revision,f.created_at,f.updated_at,
       ${withBytes?"f.file_bytes":"NULL::bytea AS file_bytes"},
       c.name AS category_name,u.display_name AS creator_name
       FROM archive_files f JOIN archive_categories c ON c.id=f.category_id
         JOIN users u ON u.id=f.created_by WHERE f.id=$1`,[fileId]);
  if(!result.rows[0])missing();
  return result.rows[0];
}
function serialFile(row:Record<string,unknown>,full=false) {
  return {
    id:row.id,companyId:row.company_id,categoryId:row.category_id,
    categoryName:row.category_name,title:row.title,filename:row.original_filename,
    mimeType:row.mime_type,createdBy:row.created_by,creatorName:row.creator_name,
    createdAt:row.created_at,updatedAt:row.updated_at,revision:row.revision,
    fileUrl:`/api/archive/files/${row.id}/content`,
    contentText:full?row.content_text:undefined,
    evidenceText:full?row.evidence_text:undefined,
    contentPreview:full?undefined:row.content_preview,
    evidencePreview:full?undefined:row.evidence_preview,
  };
}

export function archiveRoutes(pool:Pool):Router {
  const router=Router();
  router.get("/archive/categories",handler(async(req,res)=>{
    const companyId=optionalScope(req.query.companyId);
    const user=actor(req);
    await ensureAccess(pool,user,companyId,"view");
    const includePublic=companyId!==null&&await canViewPublicArchive(pool,user);
    const legalOnly=companyId===null&&req.query.legalOnly==="true";
    const result=await pool.query(
      `SELECT id,name,show_in_legal AS "showInLegal" FROM archive_categories
         WHERE (company_id IS NOT DISTINCT FROM $1 OR ($3::boolean AND company_id IS NULL))
           AND ($2::boolean=false OR show_in_legal=true)
         ORDER BY name,id`,[companyId,legalOnly,includePublic]);
    res.json({items:result.rows});
  }));
  router.patch("/archive/categories/:id",handler(async(req,res)=>{
    const categoryId=id(req.params.id),input=parse(categoryEdit,req.body);
    const result=await transaction(pool,async(db)=>{
      const user=await currentActor(db,actor(req));
      const prior=(await db.query("SELECT * FROM archive_categories WHERE id=$1 FOR UPDATE",[categoryId])).rows[0];
      if(!prior)missing();
      await ensureAccess(db,user,prior.company_id,"edit");
      if(prior.company_id!==null&&input.showInLegal)
        throw new HttpError(400,"invalid_scope","فئات القضايا تخص الأرشيف العام فقط");
      await db.query("UPDATE archive_categories SET show_in_legal=$1,updated_at=now() WHERE id=$2",
        [input.showInLegal,categoryId]);
      await audit(db,user,"archive.category","archiveCategory",categoryId,
        {showInLegal:prior.show_in_legal},{showInLegal:input.showInLegal},prior.company_id);
      return {id:categoryId,showInLegal:input.showInLegal};
    });
    res.json(result);
  }));
  router.get("/archive/files",handler(async(req,res)=>{
    const companyId=optionalScope(req.query.companyId),user=actor(req);
    await ensureAccess(pool,user,companyId,"view");
    const includePublic=companyId!==null&&await canViewPublicArchive(pool,user);
    const page=Math.max(1,Math.min(1_000_000,Number(req.query.page)||1));
    const pageSize=Math.max(1,Math.min(50,Number(req.query.pageSize)||20));
    const q=String(req.query.q??"").trim().slice(0,200);
    const categoryId=req.query.categoryId? id(String(req.query.categoryId)):null;
    const legalOnly=companyId===null&&req.query.legalOnly==="true";
    const params=[companyId,`%${q}%`,categoryId,legalOnly,pageSize,(page-1)*pageSize,includePublic];
    const where=`(f.company_id IS NOT DISTINCT FROM $1 OR ($7::boolean AND f.company_id IS NULL))
      AND ($3::integer IS NULL OR f.category_id=$3)
      AND ($4::boolean=false OR c.show_in_legal=true)
      AND (f.title ILIKE $2 OR c.name ILIKE $2 OR f.original_filename ILIKE $2
        OR f.content_text ILIKE $2 OR f.evidence_text ILIKE $2)`;
    const [records,count]=await Promise.all([
      pool.query(`SELECT f.id,f.company_id,f.category_id,c.name AS category_name,
        f.title,f.original_filename,f.mime_type,f.created_by,u.display_name AS creator_name,
        f.created_at,f.updated_at,f.revision,
        left(f.content_text,220) AS content_preview,left(f.evidence_text,220) AS evidence_preview
        FROM archive_files f JOIN archive_categories c ON c.id=f.category_id
        JOIN users u ON u.id=f.created_by WHERE ${where}
        ORDER BY f.id DESC LIMIT $5 OFFSET $6`,params),
      pool.query(`SELECT count(*)::integer AS total FROM archive_files f
        JOIN archive_categories c ON c.id=f.category_id WHERE ${where.replace("$7::boolean","$5::boolean")}`,[companyId,`%${q}%`,categoryId,legalOnly,includePublic]),
    ]);
    res.json({items:records.rows.map(r=>serialFile(r)),total:count.rows[0].total,page,pageSize});
  }));
  router.get("/archive/files/:id",handler(async(req,res)=>{
    const record=await findFile(pool,id(req.params.id));
    await ensureAccess(pool,actor(req),record.company_id,"view");
    res.json({record:serialFile(record,true)});
  }));
  router.get("/archive/files/:id/content",handler(async(req,res)=>{
    const record=await findFile(pool,id(req.params.id),true);
    await ensureAccess(pool,actor(req),record.company_id,"view");
    res.setHeader("Cache-Control","private, no-store");
    res.setHeader("Content-Security-Policy","sandbox; default-src 'none'");
    res.setHeader("Content-Disposition",["application/pdf","image/jpeg","image/png","image/webp","image/gif"].includes(record.mime_type)?"inline":"attachment");
    res.type(record.mime_type);
    res.send(record.file_bytes);
  }));
  router.post("/archive/files",handler(async(req,res)=>{
    const input=parse(upload,req.body),file=decodeFile(input.dataUrl,input.filename);
    const storedBytes=file.mime==="image/gif"?await compressArchiveGif(file.bytes):file.bytes;
    const result=await transaction(pool,async(db)=>{
      const user=await currentActor(db,actor(req));
      await ensureAccess(db,user,input.companyId,"create");
      let categoryId:number;
      if(input.companyId===null){
        const category=await db.query(
          `INSERT INTO archive_categories(company_id,name,created_by)
            VALUES (NULL,$1,$2)
            ON CONFLICT(name) WHERE company_id IS NULL
            DO UPDATE SET name=EXCLUDED.name RETURNING id`,
          [input.category,user.id]);
        categoryId=category.rows[0].id;
      }else{
        const category=await db.query(
          `INSERT INTO archive_categories(company_id,name,created_by)
            VALUES ($1,$2,$3)
            ON CONFLICT(company_id,name) WHERE company_id IS NOT NULL
            DO UPDATE SET name=EXCLUDED.name RETURNING id`,
          [input.companyId,input.category,user.id]);
        categoryId=category.rows[0].id;
      }
      const added=await db.query(
        `INSERT INTO archive_files(company_id,category_id,title,original_filename,mime_type,file_bytes,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [input.companyId,categoryId,input.title,input.filename,file.mime,storedBytes,user.id]);
      const fileId=added.rows[0].id;
      await audit(db,user,"archive.create","archiveFile",fileId,null,
        {id:fileId,categoryId,title:input.title,filename:input.filename,mime:file.mime,size:storedBytes.length},input.companyId);
      return {id:fileId,fileUrl:`/api/archive/files/${fileId}/content`};
    });
    res.status(201).json(result);
  }));
  router.patch("/archive/files/:id",handler(async(req,res)=>{
    const fileId=id(req.params.id),input=parse(edit,req.body);
    const result=await transaction(pool,async(db)=>{
      const user=await currentActor(db,actor(req));
      const old=(await db.query("SELECT * FROM archive_files WHERE id=$1 FOR UPDATE",[fileId])).rows[0];
      if(!old)missing();
      await ensureAccess(db,user,old.company_id,"edit");
      if(old.revision!==input.revision)
        throw new HttpError(409,"stale_revision","تم تعديل المرفق؛ حدّث الكرت قبل حفظ تعديلك");
      const saved=await db.query(
        `UPDATE archive_files SET content_text=$1,evidence_text=$2,
          revision=revision+1,updated_at=now() WHERE id=$3 RETURNING revision`,
        [input.contentText,input.evidenceText,fileId]);
      await audit(db,user,"archive.update","archiveFile",fileId,
        {contentLength:old.content_text.length,evidenceLength:old.evidence_text.length,revision:old.revision},
        {contentLength:input.contentText.length,evidenceLength:input.evidenceText.length,revision:saved.rows[0].revision},old.company_id);
      return {id:fileId,revision:saved.rows[0].revision};
    });
    res.json(result);
  }));
  return router;
}
