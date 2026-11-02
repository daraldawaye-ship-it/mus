import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { passwordSchema, registerSchema, passwordChangeSchema, ownerPasswordResetSchema } from "../packages/contracts/src/index.ts";

const read=(path:string)=>readFileSync(path,"utf8");
test("three-character alphabetic and numeric passwords work in all flows", () => {
  for (const value of ["abc","123","ا12"]) {
    assert.equal(passwordSchema.parse(value),value);
    assert.equal(ownerPasswordResetSchema.parse({newPassword:value}).newPassword,value);
    assert.equal(passwordChangeSchema.parse({newPassword:value}).newPassword,value);
  }
  assert.equal(passwordChangeSchema.safeParse({
    currentPassword:"old",newPassword:"abc",
  }).success,false, "no old password should be requested or submitted");
  assert.equal(registerSchema.parse({
    name:"Tester",displayName:"Test",phone:"712345678",email:"",password:"123",image:"",
  }).password,"123");
  for (const value of ["","1","xy"]) {
    assert.equal(passwordSchema.safeParse(value).success,false);
  }
});

test("owner issues only random one-hour links with hashed storage and atomic one-use redemption", () => {
  const publicRoutes=read("apps/api/src/routes-public.ts");
  const authRoutes=read("apps/api/src/routes-auth.ts");
  const migration=read("apps/api/migrations/20261102_user_magic_login_links.sql");
  const authMiddleware=read("apps/api/src/http.ts");
  assert.match(publicRoutes,/router\.post\("\/users\/:id\/login-link"/);
  assert.match(publicRoutes,/ownerOnly\(owner\)/);
  assert.match(publicRoutes,/randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(publicRoutes,/clock_timestamp\(\)\+interval '1 hour'/);
  assert.match(publicRoutes,/tokenHash\(rawToken\)/);
  assert.match(publicRoutes,/ON CONFLICT\(user_id\) DO UPDATE/);
  assert.match(publicRoutes,/if \(target\.rows\[0\]\.owner\)/);
  assert.match(publicRoutes,/if \(target\.rows\[0\]\.archived\)/);
  assert.match(authRoutes,/DELETE FROM user_login_links\s+WHERE token_hash=\$1 AND expires_at>clock_timestamp\(\)\s+RETURNING user_id/);
  assert.match(authRoutes,/await transaction\(pool,async client =>/);
  assert.match(authRoutes,/createSession\(client,user\.id\)/);
  assert.match(authRoutes,/user_login_links WHERE user_id=\$1/);
  assert.match(authMiddleware,/req\.headers\.origin !== origin/);
  assert.match(migration,/token_hash char\(64\) NOT NULL UNIQUE/);
  assert.doesNotMatch(migration,/raw_token|login_url/);
});

test("quick-login fragment is removed before same-origin JSON redemption", () => {
  const page=read("apps/web/src/QuickLoginPage.tsx");
  const publicPage=read("apps/web/src/pages/PublicPages.tsx");
  const app=read("apps/web/src/App.tsx");
  const client=read("apps/web/src/api.tsx");
  assert.match(publicPage,/\/quick-login#\$\{result\.token\}/);
  assert.match(publicPage,/navigator\.clipboard\.writeText/);
  assert.match(page,/window\.location\.hash\.slice\(1\)/);
  assert.match(page,/window\.history\.replaceState\(window\.history\.state, "", "\/quick-login"\)/);
  assert.match(page,/api<SessionResponse>\("\/auth\/login-link\/redeem"/);
  assert.match(page,/acceptRegistration\(session\)/);
  assert.match(app,/Route path="\/quick-login" element=\{<QuickLoginPage \/>\}/);
  assert.match(client,/path !== "\/auth\/login-link\/redeem"/);
  assert.match(publicPage,/minLength=\\{3\\}/);
  assert.doesNotMatch(publicPage,/label="كلمة المرور الحالية"/);
  assert.doesNotMatch(publicPage,/passwords\\.currentPassword/);
  const routes = read("apps/api/src/routes-auth.ts");
  assert.doesNotMatch(routes,/passwordMatches\\(input\\.currentPassword/);
  assert.match(routes,/DELETE FROM sessions WHERE user_id=\\$1 AND token_hash<>\\$2/);

});
