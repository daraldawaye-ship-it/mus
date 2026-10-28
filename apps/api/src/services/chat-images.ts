import type { PoolClient } from "pg";
import { HttpError, missing } from "../errors.ts";

/** The locked switch is checked inside the same transaction as the send. */
export async function checkChatImageAllowed(client: PoolClient, kind: "direct" | "group", participantIds: number[]) {
  const row = (await client.query("SELECT * FROM chat_image_settings WHERE id=1 FOR SHARE")).rows[0];
  if (kind === "direct" ? row?.allow_direct_images : row?.allow_group_images) return;
  // Platform site owner only (users.owner), never a company owner or general manager.
  const siteOwner = (await client.query(
    "SELECT 1 FROM users WHERE id=ANY($1::integer[]) AND owner=true AND NOT archived AND NOT suspended LIMIT 1",
    [participantIds],
  )).rowCount;
  if (!siteOwner)
    throw new HttpError(403,"chat_images_disabled",kind==="group"
      ?"إرفاق الصور في المجموعات معطّل من الكنترول."
      :"إرفاق الصور بين المستخدمين معطّل من الكنترول.");
}

/** Prevent an uploaded image being attached to somebody else's message or reused. */
export async function checkChatImage(client: PoolClient, imageId: string, senderId: number, companyId: number | null) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",["chat-image:"+imageId]);
  const row = (await client.query(
    "SELECT id FROM media_assets WHERE id=$1 AND purpose='chat' AND uploaded_by=$2 AND company_id IS NOT DISTINCT FROM $3::integer FOR SHARE",
    [imageId,senderId,companyId],
  )).rows[0];
  if (!row) missing("الصورة غير متاحة للإرسال ضمن هذه الدردشة");
  const used = (await client.query(
    "SELECT EXISTS(SELECT 1 FROM chat_messages WHERE image_id=$1) OR EXISTS(SELECT 1 FROM chat_group_messages WHERE image_id=$1) AS used",
    [imageId],
  )).rows[0].used;
  if (used) throw new HttpError(409,"chat_image_used","الصورة مرفقة برسالة أخرى؛ اخترها مجددًا.");
}
