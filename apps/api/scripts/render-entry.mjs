import {createServer} from "node:http";

async function migrateIfConfigured() {
if (process.env.MIGRATION_UNFREEZE_SOURCE_ID) {
  const {sourceReadOnly}=await import("./migration-transfer.mjs");
  await sourceReadOnly({sourceUrl:process.env.MIGRATION_SOURCE_DATABASE_URL,
    adminUrl:process.env.DATABASE_URL,runId:process.env.MIGRATION_UNFREEZE_SOURCE_ID,
    restore:true,enforceHosts:true});
  console.log("MIGRATION_SOURCE_WRITE_ACCESS_RESTORED");
} else if (process.env.MIGRATION_FINAL_ID || process.env.MIGRATION_STAGE_ID) {
  const runId=process.env.MIGRATION_FINAL_ID || process.env.MIGRATION_STAGE_ID;
  let frozen=false;
  try {
    const { stageMigration,sourceReadOnly,discardCandidate } = await import("./migration-transfer.mjs");
    if(process.env.MIGRATION_DISCARD_CANDIDATE_ID)
      await discardCandidate({adminUrl:process.env.DATABASE_URL,runId:process.env.MIGRATION_DISCARD_CANDIDATE_ID});
    if(process.env.MIGRATION_FREEZE_SOURCE==="true") {
      frozen=true;
      await sourceReadOnly({sourceUrl:process.env.MIGRATION_SOURCE_DATABASE_URL,
        adminUrl:process.env.DATABASE_URL,runId,enforceHosts:true});
      console.log("MIGRATION_SOURCE_READ_ONLY_CONFIRMED");
    }
    const summary = await stageMigration({
      sourceUrl: process.env.MIGRATION_SOURCE_DATABASE_URL,
      adminUrl: process.env.DATABASE_URL,
      runId,
      enforceHosts: true,
      inPlace:Boolean(process.env.MIGRATION_FINAL_ID),
    });
    console.log((process.env.MIGRATION_FINAL_ID?"MIGRATION_FINAL_VERIFIED ":"MIGRATION_STAGE_VERIFIED ") + JSON.stringify(summary));
  } catch (error) {
    console.error("MIGRATION_STAGE_FAILED " + (error.code ?? "CHECK_FAILED"));
    if(frozen) {
      try {
        const {sourceReadOnly}=await import("./migration-transfer.mjs");
        await sourceReadOnly({sourceUrl:process.env.MIGRATION_SOURCE_DATABASE_URL,
          adminUrl:process.env.DATABASE_URL,runId,
          restore:true,enforceHosts:true});
        console.log("MIGRATION_SOURCE_WRITE_ACCESS_RESTORED");
      } catch {console.error("MIGRATION_SOURCE_UNFREEZE_REQUIRES_RETRY");}
    }
    process.exit(1);
  }
}
}

if(process.env.MIGRATION_MAINTENANCE==="true") {
  const server=createServer((req,res)=>{
    const healthy=req.method==="GET" && req.url?.split("?",1)[0]==="/api/health";
    res.writeHead(healthy?200:503,{"Content-Type":"application/json; charset=utf-8",
      "Cache-Control":"no-store","Retry-After":"300"});
    res.end(JSON.stringify(healthy?{ok:true,mode:"migration"}:{error:"يجري نقل بيانات الموقع. يرجى المحاولة بعد قليل."}));
  });
  server.listen(Number(process.env.PORT||3000),"0.0.0.0",()=>console.log("MIGRATION_TARGET_MAINTENANCE_READY"));
  process.once("SIGTERM",()=>server.close(()=>process.exit(0)));
} else {
  await migrateIfConfigured();
  await import("../src/index.ts");
  if(process.env.MIGRATION_SELF_CHECK==="true") {
    const {verifyWebsite}=await import("./migration-self-check.mjs");
    await verifyWebsite();
  }
}
