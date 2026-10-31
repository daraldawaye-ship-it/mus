import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("manual offline mode keeps current work local until server-confirmed return",async()=>{
  const oldNavigator=Object.getOwnPropertyDescriptor(globalThis,"navigator");
  const oldFetch=globalThis.fetch;
  Object.defineProperty(globalThis,"navigator",{
    configurable:true,writable:true,value:{onLine:true},
  });
  try {
    const mode=await import("../apps/web/src/connection-mode.ts");
    const states:string[]=[];
    const unsubscribe=mode.subscribeConnection(()=>states.push(mode.connectionSnapshot()));
    mode.setManualOffline();
    assert.equal(mode.isOfflineNow(),true);
    assert.equal(mode.connectionSnapshot(),"manual-offline");
    globalThis.fetch=async()=>({ok:false,status:503} as Response);
    assert.equal(await mode.returnToOnline(),false);
    assert.equal(mode.connectionSnapshot(),"manual-offline");
    globalThis.fetch=async(input)=> {
      assert.equal(input,"/api/health");
      return {ok:true,status:200} as Response;
    };
    assert.equal(await mode.returnToOnline(),true);
    assert.equal(mode.connectionSnapshot(),"online");
    assert.equal(mode.isOfflineNow(),false);
    mode.markNetworkFailure();
    assert.equal(mode.connectionSnapshot(),"network-unreachable");
    assert.equal(await mode.returnToOnline(),true);
    assert.equal(mode.connectionSnapshot(),"online");
    assert.deepEqual(states,[
      "manual-offline","online","network-unreachable","online",
    ]);
    unsubscribe();
  }finally{
    globalThis.fetch=oldFetch;
    if(oldNavigator)Object.defineProperty(globalThis,"navigator",oldNavigator);
    else Reflect.deleteProperty(globalThis,"navigator");
  }
});

test("offline-only recovery button does not remount invoices or trigger a manual disconnect",()=>{
  const invoice=readFileSync("apps/web/src/pages/CommercePages.tsx","utf8");
  const finance=readFileSync("apps/web/src/pages/FinancePages.tsx","utf8");
  const questions=readFileSync("apps/web/src/pages/QuestionsPage.tsx","utf8");
  const app=readFileSync("apps/web/src/App.tsx","utf8");
  const switcher=readFileSync("apps/web/src/ConnectionModeControl.tsx","utf8");
  assert.match(invoice,/if \(isOfflineNow\(\) \|\| sessionRequiresLogin\(\)\) \{\s*await saveOnDevice\(\)/);
  assert.match(finance,/if \(isOfflineNow\(\) && !document/);
  assert.match(questions,/if\(isOfflineNow\(\)\) throw new TypeError/);
  assert.match(invoice,/queueOfflineOperation\(user\.id, companyId, "invoice"/);
  assert.match(finance,/queueOfflineOperation\(sessionUser\.id, companyId, "voucher"/);
  assert.match(questions,/queueOfflineOperation\(user\.id,companyId,"answer"/);
  assert.match(app,/<ConnectionModeControl \/>/);
  assert.match(switcher,/returnToOnline\(\)/);
  assert.match(switcher,/العودة إلى وضع الاتصال/);
  assert.match(switcher,/if \(!offline\) return null/);
  assert.doesNotMatch(switcher,/setManualOffline/);
  assert.doesNotMatch(switcher,/وضع عدم الاتصال/);
  assert.match(switcher,/connectionSnapshot, returnToOnline, subscribeConnection/);
  assert.doesNotMatch(switcher,/location\.reload|navigate\(/);
});

test("API uses user-scoped reads offline and marks transport loss, not HTTP errors",()=>{
  const api=readFileSync("apps/web/src/api.tsx","utf8");
  const context=readFileSync("apps/web/src/employee-cashbox.ts","utf8");
  const lookup=readFileSync("apps/web/src/phase2.tsx","utf8");
  assert.match(api,/if \(isOfflineNow\(\)\) \{/);
  assert.match(api,/const saved = await fallbackRead\(\)/);
  assert.match(api,/if \(!options\.signal\?\.aborted && error instanceof TypeError\) markNetworkFailure\(\)/);
  assert.match(api,/markNetworkSuccess\(\)/);
  assert.match(context,/if \(isOfflineNow\(\)\)/);
  assert.match(lookup,/networkMode: "always"/);
});

test("notification permission reminder is hidden during an outage and retry resumes on restore",()=>{
  const push=readFileSync("apps/web/src/DeviceNotificationSettings.tsx","utf8");
  const sync=readFileSync("apps/web/src/OfflineStatus.tsx","utf8");
  assert.match(push,/connection !== "online"/);
  assert.match(push,/isOfflineNow\(\)/);
  assert.match(push,/alraesy-network-restored/);
  assert.match(sync,/subscribeConnection\(connected\)/);
  assert.match(sync,/if \(!offlineForSession\(\)\) void syncPending\(userId/);
  assert.match(sync,/sessionRequiresLogin\(\)/);
  assert.doesNotMatch(sync,/window\.addEventListener\("offline", connected\)/);
});
