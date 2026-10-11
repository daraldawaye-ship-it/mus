import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Pool } from "pg";
import { registerSchema } from "../../../packages/contracts/src/index.ts";
import { HttpError } from "./errors.ts";
import { handler, parse } from "./http.ts";
import { authLimiter, provisionOwner } from "./services/auth.ts";

// A single-use bootstrap capability. Remove OWNER_SETUP_TOKEN after provisioning.
export function setupRoutes(pool: Pool): Router {
  const router = Router();
  const limiter = authLimiter();
  const secret = process.env.OWNER_SETUP_TOKEN ?? "";
  const enabled = /^[A-Za-z0-9_-]{43,128}$/.test(secret);
  const digest = (token: string) => createHash("sha256").update(token).digest();
  const expected = enabled ? digest(secret) : randomBytes(32);
  const noOwner = async () =>
    !(await pool.query("SELECT 1 FROM users WHERE owner LIMIT 1")).rowCount;

  router.get("/setup-owner", handler(async (_req, res) => {
    if (!enabled || !(await noOwner())) { res.status(404).send("Not found"); return; }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.type("html").send(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>تهيئة مالك تجارة</title><style>body{background:#f5f7f8;color:#172b2a;font:16px system-ui;margin:2rem auto;padding:1rem;max-width:470px}main{background:white;border:1px solid #ddd;border-radius:12px;padding:24px}label{display:block;margin:14px 0 5px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #aaa;border-radius:7px;font:inherit}button{margin-top:20px;padding:12px;width:100%;border:0;border-radius:8px;background:#176b61;color:white;font:inherit}p{line-height:1.7}#message{white-space:pre-wrap}</style></head><body><main><h2>تهيئة مالك المنصة</h2><p>هذه الصفحة للاستخدام الأول فقط. أدخل رمز التهيئة من إعدادات Railway، ثم بيانات الحساب. كلمة المرور لا تُخزّن في الإعدادات.</p><form id="owner-form"><label for="token">رمز التهيئة</label><input id="token" type="password" autocomplete="off" required><label for="name">الاسم</label><input id="name" maxlength="120" required><label for="email">البريد الإلكتروني</label><input id="email" type="email" autocomplete="email" maxlength="254" required><label for="password">كلمة المرور (12 حرفًا على الأقل)</label><input id="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" required><label for="confirm">تأكيد كلمة المرور</label><input id="confirm" type="password" minlength="12" maxlength="128" autocomplete="new-password" required><button type="submit">إنشاء حساب المالك</button></form><p id="message" role="status"></p></main><script src="/setup-owner.js" defer></script></body></html>`);
  }));
  router.get("/setup-owner.js", handler(async (_req, res) => {
    if (!enabled || !(await noOwner())) { res.status(404).end(); return; }
    res.setHeader("Cache-Control", "no-store");
    res.type("js").send(`document.getElementById('owner-form').addEventListener('submit',async event=>{event.preventDefault();const byId=id=>document.getElementById(id).value;const msg=document.getElementById('message');if(byId('password')!==byId('confirm')){msg.textContent='كلمتا المرور غير متطابقتين';return;}const button=event.target.querySelector('button');button.disabled=true;try{const response=await fetch('/api/setup-owner',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:byId('token'),name:byId('name'),email:byId('email'),password:byId('password')})});const body=await response.json();if(!response.ok)throw Error(body.error?.message||'تعذر إنشاء الحساب');msg.textContent='تم إنشاء المالك. يمكنك الآن تسجيل الدخول من الصفحة الرئيسية.';event.target.remove();}catch(error){msg.textContent=error.message;button.disabled=false;}});`);
  }));
  router.post("/api/setup-owner", handler(async (req, res) => {
    limiter(`owner-setup:${req.ip}`, 5);
    if (!enabled || !(await noOwner())) throw new HttpError(404, "not_found", "المسار غير موجود");
    const body = req.body;
    if (!body || typeof body !== "object" || typeof body.token !== "string" || body.token.length > 256)
      throw new HttpError(400, "invalid", "بيانات غير صالحة");
    if (!timingSafeEqual(digest(body.token), expected))
      throw new HttpError(403, "forbidden", "رمز التهيئة غير صحيح");
    const input = parse(registerSchema, {
      name: body.name, displayName: body.name, email: body.email,
      password: body.password, phone: "", image: ""
    });
    await provisionOwner(pool, input);
    res.status(201).json({ ok: true });
  }));
  return router;
}
