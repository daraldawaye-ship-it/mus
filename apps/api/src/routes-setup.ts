import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Pool } from "pg";
import { HttpError } from "./errors.ts";
import { handler, loadSession, mutationSecurity } from "./http.ts";
import { authLimiter } from "./services/auth.ts";
import { transaction } from "./db.ts";
import { userDTO } from "./repositories/models.ts";
import { audit } from "./services/audit.ts";

// One-time capability; revoke OWNER_SETUP_TOKEN after the existing user becomes owner.
export function setupRoutes(pool: Pool, appOrigin: string): Router {
  const router = Router();
  const limit = authLimiter();
  const secret = process.env.OWNER_SETUP_TOKEN ?? "";
  const enabled = /^[A-Za-z0-9_-]{43,128}$/.test(secret);
  const hash = (value: string) => createHash("sha256").update(value).digest();
  const expected = enabled ? hash(secret) : randomBytes(32);
  const noOwner = async () =>
    !(await pool.query("SELECT 1 FROM users WHERE owner LIMIT 1")).rowCount;

  router.get("/setup-owner", handler(async (_req, res) => {
    if (!enabled || !(await noOwner())) { res.status(404).send("Not found"); return; }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.type("html").send(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>اعتماد حساب مالك تجارة</title><style>body{background:#f5f7f8;color:#172b2a;font:16px system-ui;margin:2rem auto;padding:1rem;max-width:470px}main{background:white;border:1px solid #ddd;border-radius:12px;padding:24px}label{display:block;margin:14px 0 5px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #aaa;border-radius:7px;font:inherit}button{margin-top:20px;padding:12px;width:100%;border:0;border-radius:8px;background:#176b61;color:white;font:inherit}p{line-height:1.7}#message{white-space:pre-wrap}</style></head><body><main><h2>اعتماد حسابك الحالي مالكًا</h2><p>سنبقي اسمك وبريدك وكلمة مرورك وسجلاتك كما هي. سجّل الدخول إلى حسابك الحالي أولًا، ثم ارجع إلى هذه الصفحة.</p><p id="account"></p><form id="owner-form" hidden><label for="token">رمز التهيئة من Railway</label><input id="token" type="password" autocomplete="off" required><button type="submit">اعتماد حسابي الحالي مالكًا للمنصة</button></form><p id="message" role="status"></p></main><script src="/setup-owner.js" defer></script></body></html>`);
  }));
  router.get("/setup-owner.js", handler(async (_req, res) => {
    if (!enabled || !(await noOwner())) { res.status(404).end(); return; }
    res.setHeader("Cache-Control", "no-store");
    res.type("js").send(`let csrf=null;const account=document.getElementById('account'),form=document.getElementById('owner-form'),msg=document.getElementById('message');fetch('/api/auth/session',{credentials:'same-origin'}).then(r=>r.json()).then(data=>{if(!data.user){account.textContent='لا توجد جلسة دخول. افتح الموقع الرئيسي وسجّل الدخول ثم عد إلى هنا.';return;}if(data.user.archived||data.user.suspended){account.textContent='هذا الحساب غير نشط.';return;}csrf=data.csrf;account.textContent='الحساب الحالي: '+data.user.name+' — '+data.user.email;form.hidden=false;}).catch(()=>{msg.textContent='تعذر التحقق من تسجيل الدخول';});form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;try{const response=await fetch('/api/setup-owner',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({token:document.getElementById('token').value})});const body=await response.json();if(!response.ok)throw Error(body.error?.message||'تعذر اعتماد الحساب');msg.textContent='تم اعتماد حسابك الحالي مالكًا للمنصة. أعد فتح الموقع.';form.remove();}catch(error){msg.textContent=error.message;button.disabled=false;}});`);
  }));
  router.use("/api/setup-owner", loadSession(pool), mutationSecurity(appOrigin));
  router.post("/api/setup-owner", handler(async (req, res) => {
    limit(`owner-promote:${req.ip}`, 5);
    if (!enabled || !(await noOwner()))
      throw new HttpError(404, "not_found", "المسار غير موجود");
    if (!req.auth || req.auth.user.archived || req.auth.user.suspended)
      throw new HttpError(401, "unauthenticated", "سجّل الدخول بالحساب الذي تريد اعتماده");
    const token = req.body?.token;
    if (typeof token !== "string" || token.length > 256)
      throw new HttpError(400, "invalid", "رمز غير صالح");
    if (!timingSafeEqual(hash(token), expected))
      throw new HttpError(403, "forbidden", "رمز التهيئة غير صحيح");
    await transaction(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('one_platform_owner'))");
      if ((await client.query("SELECT 1 FROM users WHERE owner LIMIT 1")).rowCount)
        throw new HttpError(409, "conflict", "يوجد مالك للمنصة بالفعل");
      const locked = await client.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [req.auth!.user.id]);
      const before = locked.rows[0];
      if (!before || before.archived || before.suspended)
        throw new HttpError(403, "forbidden", "الحساب غير نشط");
      const updated = await client.query(
        "UPDATE users SET kind='admin', owner=true WHERE id=$1 RETURNING *",
        [before.id],
      );
      await audit(client, userDTO(before), "owner.create", "user", before.id, userDTO(before), userDTO(updated.rows[0]));
    });
    res.json({ ok: true });
  }));
  return router;
}
