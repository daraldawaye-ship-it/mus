import assert from "node:assert/strict";
import test from "node:test";
import { oauthRedirectAllowed } from "../apps/api/src/services/oauth-redirect.ts";

test("Codex OAuth permits production loopback listeners and existing ChatGPT callbacks", () => {
  for (const uri of [
    "http://127.0.0.1:36477/callback/6M49Wa89rRZK",
    "http://127.0.0.1:4321/callback",
    "https://chatgpt.com/connector_platform_oauth_redirect",
    "https://chatgpt.com/connector/alraesy/oauth/callback",
    "https://chat.openai.com/connector/alraesy/callback",
    "https://platform.openai.com/connector/alraesy/callback",
  ]) assert.equal(oauthRedirectAllowed(uri, true), true, uri);
});

test("Codex OAuth rejects public destinations and ambiguous loopback callback URLs", () => {
  for (const uri of [
    "http://localhost:4321/callback",
    "http://127.0.0.1/callback",
    "http://127.0.0.1:0/callback",
    "http://127.0.0.1:65536/callback",
    "http://127.0.0.1:04321/callback",
    "http://127.0.0.2:4321/callback",
    "http://127.1:4321/callback",
    "http://2130706433:4321/callback",
    "http://0x7f000001:4321/callback",
    "http://127.0.0.1.example.com:4321/callback",
    "http://127.0.0.1:4321@evil.example/callback",
    "http://user@127.0.0.1:4321/callback",
    "http://127.0.0.1:4321/callback?next=https://evil.example",
    "http://127.0.0.1:4321/callback#fragment",
    "http://127.0.0.1:4321/callback\n",
    " http://127.0.0.1:4321/callback",
    "http://127.0.0.1:4321/callback/",
    "http://127.0.0.1:4321/callback/../../callback",
    "http://127.0.0.1:4321/other/../callback",
    "http://127.0.0.1:4321/%63allback",
    "http://127.0.0.1:4321/callback/%2fother",
    "http://127.0.0.1:4321/other",
    "https://evil.example/connector/alraesy",
    "https://chatgpt.com.evil.example/connector/alraesy",
    "https://chatgpt.com/other",
    "https://user@chatgpt.com/connector/alraesy",
    "https://chatgpt.com/connector/alraesy#fragment",
  ]) assert.equal(oauthRedirectAllowed(uri, true), false, uri);
});

test("development keeps existing local OAuth clients compatible", () => {
  assert.equal(oauthRedirectAllowed("http://localhost:4322/callback", false), true);
  assert.equal(oauthRedirectAllowed("http://127.0.0.1:4322/development-callback", false), true);
});
