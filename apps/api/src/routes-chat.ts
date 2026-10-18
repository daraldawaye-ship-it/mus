import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { chatReceiptSchema, chatSendSchema } from "../../../packages/contracts/src/index.ts";
import { transaction } from "./db.ts";
import { actor, handler, id, parse } from "./http.ts";
import {
  acknowledgeChatMessages, chatConversations, chatDirectory, chatMessages,
  sendChatMessage,
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

export function chatRoutes(pool: Pool): Router {
  const router = Router();
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
