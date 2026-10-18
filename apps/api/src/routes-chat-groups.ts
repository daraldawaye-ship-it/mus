import { Router } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  chatGroupCreateSchema, chatGroupLeaveSchema, chatGroupSendSchema, chatGroupUpdateSchema, chatReceiptSchema,
} from "../../../packages/contracts/src/index.ts";
import { transaction } from "./db.ts";
import { actor, handler, id, parse } from "./http.ts";
import {
  acknowledgeChatGroupMessages, createChatGroup, getChatGroup, leaveChatGroup,
  listChatGroupMessages, listChatGroups, sendChatGroupMessage, updateChatGroup,
} from "./services/chat-groups.ts";

const numeric = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().positive().max(2_147_483_647));
const querySchema = z.object({
  scope: z.enum(["global", "company"]), companyId: numeric.optional(),
  search: z.string().trim().max(100).refine(value => !value.includes("\u0000"), "نص البحث غير صالح").default(""),
  cursor: z.string().min(1).max(1_024).optional(), limit: numeric.pipe(z.number().max(100)).default(30),
}).strict().refine(value => value.scope === "company" ? value.companyId !== undefined : value.companyId === undefined,
  "حدد الشركة لدردشة الشركة فقط");
async function read<T>(pool: Pool, action: (client: PoolClient) => Promise<T>) {
  return transaction(pool, async client => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return action(client);
  });
}
export function chatGroupRoutes(pool: Pool): Router {
  const router = Router();
  router.get("/chat/groups", handler(async (req, res) => {
    const query = parse(querySchema, req.query);
    res.json(await read(pool, client => listChatGroups(client, actor(req), query)));
  }));
  router.post("/chat/groups", handler(async (req, res) => {
    const input = parse(chatGroupCreateSchema, req.body);
    res.json(await transaction(pool, client => createChatGroup(client, actor(req), input)));
  }));
  router.get("/chat/groups/:groupId", handler(async (req, res) => {
    const query = parse(querySchema, req.query), groupId = id(req.params.groupId);
    res.json(await read(pool, client => getChatGroup(client, actor(req), groupId, query)));
  }));
  router.patch("/chat/groups/:groupId", handler(async (req, res) => {
    const input = parse(chatGroupUpdateSchema, req.body), groupId = id(req.params.groupId);
    res.json(await transaction(pool, client => updateChatGroup(client, actor(req), groupId, input)));
  }));
  router.post("/chat/groups/:groupId/leave", handler(async (req, res) => {
    const input = parse(chatGroupLeaveSchema, req.body), groupId = id(req.params.groupId);
    res.json(await transaction(pool, client => leaveChatGroup(client, actor(req), groupId, input)));
  }));
  router.get("/chat/groups/:groupId/messages", handler(async (req, res) => {
    const query = parse(querySchema, req.query), groupId = id(req.params.groupId);
    res.json(await read(pool, client => listChatGroupMessages(client, actor(req), groupId, query)));
  }));
  router.post("/chat/groups/:groupId/messages", handler(async (req, res) => {
    const input = parse(chatGroupSendSchema, req.body), groupId = id(req.params.groupId);
    res.json({ message: await transaction(pool, client => sendChatGroupMessage(client, actor(req), groupId, input)) });
  }));
  router.post("/chat/groups/:groupId/receipt", handler(async (req, res) => {
    const input = parse(chatReceiptSchema, req.body), groupId = id(req.params.groupId);
    res.json({ messages: await transaction(pool, client => acknowledgeChatGroupMessages(client, actor(req), groupId, input)) });
  }));
  return router;
}
