import assert from "node:assert/strict";
import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
import { test } from "node:test";
import { encryptPayload, hashEndpoint, validPushEndpoint, validPushKeys } from "../apps/api/src/services/web-push.ts";
import { automaticPushPromptAllowed, denialReminderDue,PUSH_REMINDER_INTERVAL_MS } from "../apps/web/src/push-permission-policy.ts";

test("push endpoints reject non-push hosts and embedded credentials",()=>{
  assert.equal(validPushEndpoint("https://fcm.googleapis.com/fcm/send/test"),true);
  assert.equal(validPushEndpoint("https://web.push.apple.com/Q"),true);
  assert.equal(validPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/abc"),true);
  assert.equal(validPushEndpoint("https://example.org/anything"),false);
  assert.equal(validPushEndpoint("https://fcm.googleapis.com.evil.org/"),false);
  assert.equal(validPushEndpoint("http://fcm.googleapis.com/"),false);
  assert.equal(validPushEndpoint("https://user:pass@fcm.googleapis.com/"),false);
  assert.equal(hashEndpoint("one").length,64);
});
test("webpush aes128gcm payload decrypts under the receiver's subscription keys",()=>{
  const receiver=createECDH("prime256v1");
  const pub=receiver.generateKeys();
  const auth=Buffer.alloc(16,9);
  assert(validPushKeys(pub.toString("base64url"),auth.toString("base64url")));
  assert(!validPushKeys("bad","bad"));
  const message={title:"تنبيه جديد",body:"تم استلام مذكرة",url:"/notifications",id:42};
  const envelope=encryptPayload(pub.toString("base64url"),auth.toString("base64url"),message);
  const salt=envelope.subarray(0,16);
  assert.equal(envelope.readUInt32BE(16),4096);
  assert.equal(envelope[20],65);
  const sender=envelope.subarray(21,86);
  const shared=receiver.computeSecret(sender);
  const ikm=Buffer.from(hkdfSync("sha256",shared,auth,
    Buffer.concat([Buffer.from("WebPush: info\0"),pub,sender]),32));
  const cek=Buffer.from(hkdfSync("sha256",ikm,salt,
    Buffer.from("Content-Encoding: aes128gcm\0"),16));
  const nonce=Buffer.from(hkdfSync("sha256",ikm,salt,
    Buffer.from("Content-Encoding: nonce\0"),12));
  const encrypted=envelope.subarray(86);
  const decipher=createDecipheriv("aes-128-gcm",cek,nonce);
  decipher.setAuthTag(encrypted.subarray(-16));
  const plain=Buffer.concat([decipher.update(encrypted.subarray(0,-16)),decipher.final()]);
  assert.equal(plain.at(-1),2);
  assert.deepEqual(JSON.parse(plain.subarray(0,-1).toString("utf8")),message);
});

test("denied notification permission reminders recur after three days, never immediately",()=>{
  const now=Date.UTC(2026,9,20);
  assert.equal(PUSH_REMINDER_INTERVAL_MS,259200000);
  assert.equal(denialReminderDue(null,now),false);
  assert.equal(denialReminderDue(0,now),false);
  assert.equal(denialReminderDue(now,now),false);
  assert.equal(denialReminderDue(now-2*86400000,now),false);
  assert.equal(denialReminderDue(now-3*86400000,now),true);
  assert.equal(denialReminderDue(now+60000,now),false);
});

test("permission is auto-requested only once from a trusted browser activation", () => {
  assert.equal(automaticPushPromptAllowed("default", true, "click"), true);
  assert.equal(automaticPushPromptAllowed("default", true, "keydown", "Enter"), true);
  assert.equal(automaticPushPromptAllowed("default", true, "keydown", " "), true);
  assert.equal(automaticPushPromptAllowed("default", true, "keydown", "Escape"), false);
  assert.equal(automaticPushPromptAllowed("default", true, "scroll"), false);
  assert.equal(automaticPushPromptAllowed("default", false, "click"), false);
  assert.equal(automaticPushPromptAllowed("granted", true, "click"), false);
  assert.equal(automaticPushPromptAllowed("denied", true, "click"), false);
});
