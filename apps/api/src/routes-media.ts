import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { transaction } from "./db.ts";
import { actor, handler, id, parse } from "./http.ts";
import { HttpError, missing } from "./errors.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import { audit } from "./services/audit.ts";

// JSON image uploads intentionally contain small browser-resized raster files.
// Keeping originals and thumbnails in PostgreSQL makes them survive Railway redeploys.
const uploadSchema = z.object({
  purpose: z.enum(["avatar", "item", "letterhead"]),
  companyId: z.number().int().positive().nullable(),
  original: z.string().max(3_100_000),
  thumbnail: z.string().max(300_000),
}).strict();
const uuid = z.uuid();

function readRaster(source: string, maxBytes: number) {
  const match = /^data:image\/(webp|jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(source);
  if (!match) throw new HttpError(400,"invalid_image","يجب رفع صورة WebP أو JPEG أو PNG");
  const bytes = Buffer.from(match[2], "base64");
  const mime = "image/" + match[1];
  const valid =
    (mime === "image/webp" && bytes.subarray(0,4).toString() === "RIFF" &&
      bytes.subarray(8,12).toString() === "WEBP") ||
    (mime === "image/png" && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) ||
    (mime === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255);
  if (!valid || bytes.length === 0 || bytes.length > maxBytes)
    throw new HttpError(400,"invalid_image","حجم الصورة أو تنسيقها غير صالح");
  return { bytes, mime };
}

export function mediaRoutes(pool: Pool): Router {
  const router = Router();
  router.post("/media",handler(async(req,res) => {
    const input = parse(uploadSchema,req.body);
    if ((input.purpose!=="avatar") !== (input.companyId !== null))
      throw new HttpError(400,"invalid_scope","تحديد نطاق الصورة غير صالح");
    const original = readRaster(input.original,2_000_000);
    const thumbnail = readRaster(input.thumbnail,150_000);
    const mediaId=randomUUID();
    await transaction(pool,async(client)=>{
      const user=await currentActor(client,actor(req));
      if(input.purpose==="item") await companyAccess(client,user,input.companyId!,"items.manage");
      if(input.purpose==="letterhead") {
        const access=await companyAccess(client,user,input.companyId!,undefined,true);
        if(!user.owner && access.company.createdBy!==user.id)
          throw new HttpError(403,"forbidden","تغيير ترويسة الشركة متاح للمالك فقط");
      }
      await client.query(
        `INSERT INTO media_assets(id,purpose,company_id,uploaded_by,original_mime,thumbnail_mime,original_bytes,thumbnail_bytes)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [mediaId,input.purpose,input.companyId,user.id,original.mime,thumbnail.mime,original.bytes,thumbnail.bytes],
      );
      await audit(client,user,"media.upload","media",null,
        null,{id:mediaId,purpose:input.purpose,bytes:original.bytes.length,thumbnailBytes:thumbnail.bytes.length},input.companyId);
    });
    res.status(201).json({
      id:mediaId,
      fullUrl:`/api/media/${mediaId}/full`,
      thumbnailUrl:`/api/media/${mediaId}/thumbnail`,
    });
  }));
  router.get("/media/:mediaId/:size",handler(async(req,res)=>{
    const imageId=parse(uuid,req.params.mediaId);
    const size=req.params.size;
    if(size!=="full" && size!=="thumbnail") missing();
    const image=await transaction(pool,async(client)=>{
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const user=await currentActor(client,actor(req),false);
      const result=await client.query(
        `SELECT purpose,company_id,uploaded_by,original_mime,thumbnail_mime,original_bytes,thumbnail_bytes
         FROM media_assets WHERE id=$1`,[imageId]);
      const record=result.rows[0];
      if(!record)missing();
      if(record.purpose==="avatar"){
        if(record.uploaded_by!==user.id)missing();
      }else{
        await companyAccess(
          client,user,record.company_id,
          record.purpose==="item"?"items.view":undefined,
        );
      }
      return record;
    });
    res.setHeader("Cache-Control","private, max-age=86400");
    res.setHeader("Content-Security-Policy","default-src 'none'; sandbox");
    res.type(size==="full"?image.original_mime:image.thumbnail_mime);
    res.send(size==="full"?image.original_bytes:image.thumbnail_bytes);
  }));
  return router;
}
