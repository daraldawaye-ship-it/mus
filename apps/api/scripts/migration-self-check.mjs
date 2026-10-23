const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function check(base,origin) {
  const options={signal:AbortSignal.timeout(10000),redirect:"manual"};
  const health=await fetch(base+"/api/health",options);
  if(health.status!==200||(await health.json()).ok!==true)throw new Error("HEALTH_FAILED");
  const root=await fetch(base+"/",{...options,signal:AbortSignal.timeout(10000)});
  if(root.status!==200 || !(await root.text()).includes("/assets/"))throw new Error("FRONTEND_FAILED");
  const privateApi=await fetch(base+"/api/companies",{...options,signal:AbortSignal.timeout(10000)});
  if(privateApi.status!==401)throw new Error("PRIVATE_API_AUTH_FAILED");
  const discovery=await fetch(base+"/.well-known/oauth-protected-resource",{...options,signal:AbortSignal.timeout(10000)});
  if(discovery.status!==200 || (await discovery.json()).resource!==origin+"/mcp")throw new Error("OAUTH_ORIGIN_FAILED");
  return {health:health.status,frontend:root.status,private_api:privateApi.status,oauth:discovery.status};
}
export async function verifyWebsite() {
  const origin=(process.env.APP_ORIGIN||process.env.RENDER_EXTERNAL_URL).replace(/\/$/,"");
  let result;
  for(let attempt=0;attempt<10;attempt++){
    try{result=await check("http://127.0.0.1:"+(process.env.PORT||3000),origin);break;}
    catch(error){if(attempt===9)throw error;await wait(500);}
  }
  console.log("MIGRATION_LOCAL_HTTP_VERIFIED "+JSON.stringify(result));
  // Wait for the platform's healthy-instance routing to switch to this deploy.
  void(async()=>{
    for(let attempt=0;attempt<18;attempt++){
      await wait(5000);
      try{const external=await check(origin,origin);console.log("MIGRATION_EXTERNAL_HTTP_VERIFIED "+JSON.stringify(external));return;}
      catch{}
    }
    console.error("MIGRATION_EXTERNAL_HTTP_CHECK_REQUIRES_REVIEW");
  })();
}
