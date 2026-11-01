import assert from "node:assert/strict";
import test from "node:test";
import { readApiJson, UnexpectedApiResponse } from "../apps/web/src/api-response.ts";

test("correct API JSON is returned unchanged including login and validation errors",async()=>{
  const login=new Response(JSON.stringify({user:{id:1},csrf:"test"}),{
    status:200,headers:{"content-type":"application/json; charset=utf-8"},
  });
  assert.deepEqual(await readApiJson(login),{user:{id:1},csrf:"test"});
  const invalid=new Response(JSON.stringify({error:{code:"invalid_login",message:"بيانات الدخول غير صحيحة"}}),{
    status:401,headers:{"content-type":"application/problem+json"},
  });
  assert.deepEqual(await readApiJson(invalid),{
    error:{code:"invalid_login",message:"بيانات الدخول غير صحيحة"},
  });
  assert.deepEqual(await readApiJson(new Response(null,{status:204})),{});
});

test("HTML SPA fallback on login is rejected without showing raw source",async()=>{
  for (const status of [200,503]) {
    const html=new Response("<!DOCTYPE html><html><script>private!</script></html>",{
      status,headers:{"content-type":"text/html; charset=utf-8"},
    });
    await assert.rejects(()=>readApiJson(html),(error:unknown)=>{
      assert.ok(error instanceof UnexpectedApiResponse);
      assert.match(error.message,/رد خادم الموقع/);
      assert.doesNotMatch(error.message,/DOCTYPE|private!/);
      return true;
    });
  }
});

test("bad JSON and HTML disguised as JSON yield safe localized errors",async()=>{
  for(const content of ["<!DOCTYPE html>","{broken"]) {
    const response=new Response(content,{
      status:200,headers:{"content-type":"application/json"},
    });
    await assert.rejects(()=>readApiJson(response),UnexpectedApiResponse);
  }
});

test("plain text is not accepted as a JSON API response",async()=>{
  const response=new Response("Service unavailable",{
    status:502,headers:{"content-type":"text/plain"},
  });
  await assert.rejects(()=>readApiJson(response),UnexpectedApiResponse);
});
