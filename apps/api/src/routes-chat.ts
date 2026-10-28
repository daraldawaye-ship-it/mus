import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { chatReceiptSchema, chatSendSchema } from "../../../packages/contracts/src/index.ts";
import { transaction } from "./db.ts";
import { actor, handler, id, parse } from "./http.ts";
import { currentActor, ownerOnly } from "./policies/access.ts";
import { audit } from "./services/audit.ts";
import { HttpError } from "./errors.ts";
import {
  acknowledgeChatMessages, chatConversations, chatDirectory, chatMessages,
  sendChatMessage, readChatAvatar,
} from "./services/chat.ts";

const numericQuery = z.string().regex(/^[1-9]\d*$/).transform(Number)
  .pipe(z.number().int().positive().max(2_147_483_647));
const listSchema = z.object({
  scope: z.enum(["global", "company"]),
  companyId: numericQuery.optional(),
  search: z.string().trim().max(100)
    .refine(value => !value.includes("\u0000"), "نص البحث غير صالح").default(""),
  cursor: z.string().min(1).max(1_024).optional(),
  limit: numericQuery.pipe(z.number().max(100)).default(30),
}).strict().refine(value => value.scope === "company"
  ? value.companyId !== undefined : value.companyId === undefined,
"حدد الشركة لدردشة الشركة فقط");
const avatarQuerySchema = z.object({
  scope: z.enum(["global", "company"]), companyId: numericQuery.optional(),
  v: z.uuid().transform(value => value.toLowerCase()),
}).strict().refine(value => value.scope === "company"
  ? value.companyId !== undefined : value.companyId === undefined,
"حدد الشركة لدردشة الشركة فقط");

export function chatRoutes(pool: Pool): Router {
  const router = Router();
  const settingsSchema=z.object({allowGroupImages:z.boolean(),allowDirectImages:z.boolean(),revision:z.number().int().positive()}).strict();
  router.get("/chat/image-settings",handler(async(req,res)=>{
    actor(req);
    const row=(await pool.query("SELECT * FROM chat_image_settings WHERE id=1")).rows[0];
    res.json({allowGroupImages:row.allow_group_images,allowDirectImages:row.allow_direct_images,revision:row.revision});
  }));
  router.put("/chat/image-settings",handler(async(req,res)=>{
    const input=parse(settingsSchema,req.body);
    const result=await transaction(pool,async client=>{
      const user=await currentActor(client,actor(req));ownerOnly(user);
      const old=(await client.query("SELECT * FROM chat_image_settings WHERE id=1 FOR UPDATE")).rows[0];
      if(old.revision!==input.revision)throw new HttpError(409,"conflict","تغيرت إعدادات الدردشة؛ حدث الصفحة أولًا.");
      const row=(await client.query("UPDATE chat_image_settings SET allow_group_images=$1,allow_direct_images=$2,revision=revision+1,updated_by=$3,updated_at=now() WHERE id=1 RETURNING *",
        [input.allowGroupImages,input.allowDirectImages,user.id])).rows[0];
      await audit(client,user,"chat.image.settings","chat_image_settings",1,
        {allowGroupImages:old.allow_group_images,allowDirectImages:old.allow_direct_images},
        {allowGroupImages:row.allow_group_images,allowDirectImages:row.allow_direct_images});
      return {allowGroupImages:row.allow_group_images,allowDirectImages:row.allow_direct_images,revision:row.revision};
    });res.json(result);
  }));
  router.get("/chat/avatars/:userId", handler(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const query = parse(avatarQuerySchema, req.query), userId = id(req.params.userId);
    const asset = await transaction(pool, async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      return readChatAvatar(client, actor(req), query, userId, query.v);
    });
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.type(asset.thumbnail_mime).send(asset.thumbnail_bytes);
  }));
  router.get("/chat/directory", handler(async (req, res) => {
    const query = parse(listSchema, req.query);
    const result = await transaction(pool, async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      return chatDirectory(client, actor(req), query);
    });
    res.json(result);
  }));
  router.get("/chat/conversations", handler(async (req, res) => {
    const query = parse(listSchema, req.query);
    const result = await transaction(pool, async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      return chatConversations(client, actor(req), query);
    });
    res.json(result);
  }));
  router.get("/chat/conversations/:peerId/messages", handler(async (req, res) => {
    const query = parse(listSchema, req.query), peerId = id(req.params.peerId);
    const result = await transaction(pool, async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      return chatMessages(client, actor(req), peerId, query);
    });
    res.json(result);
  }));
  router.post("/chat/conversations/:peerId/messages", handler(async (req, res) => {
    const input = parse(chatSendSchema, req.body), peerId = id(req.params.peerId);
    const message = await transaction(pool, client => sendChatMessage(client, actor(req), peerId, input));
    res.json({ message });
  }));
  router.post("/chat/conversations/:peerId/receipt", handler(async (req, res) => {
    const input = parse(chatReceiptSchema, req.body), peerId = id(req.params.peerId);
    const messages = await transaction(pool, client => acknowledgeChatMessages(client, actor(req), peerId, input));
    res.json({ messages });
  }));
  return router;
}
