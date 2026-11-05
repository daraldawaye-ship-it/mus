import { Router } from "express";
import type { Pool } from "pg";
import { readdir, stat, statfs } from "node:fs/promises";
import { resolve, join } from "node:path";
import { actor, handler } from "./http.ts";
import { currentActor, ownerOnly } from "./policies/access.ts";
import { databaseMonitor, exactTableCount } from "./services/system-monitor.ts";

const GB = 1e9;
const runtimeRoot = resolve("dist/public");
let cachedBuild: { sizeBytes: number; fileCount: number; at: number } | undefined;
async function builtFiles() {
  if (cachedBuild && Date.now() - cachedBuild.at < 300000) return cachedBuild;
  let sizeBytes = 0, fileCount = 0;
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) { sizeBytes += (await stat(full)).size; fileCount++; }
    }
  }
  try { await walk(runtimeRoot); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return (cachedBuild = { sizeBytes, fileCount, at: Date.now() });
}
async function owner(pool: Pool, req: Parameters<typeof actor>[0]) {
  const user = await currentActor(pool, actor(req), false);
  ownerOnly(user);
}
type Point = { timestamp: string; value: number };
type Series = { unit?: string; values?: Point[]; labels?: { field: string; value: string }[] };
async function renderMetric(key: string, resourceId: string, startTime: string, token: string) {
  const url = new URL("https://api.render.com/v1/metrics/" + key);
  url.searchParams.set("resource", resourceId);
  url.searchParams.set("startTime", startTime);
  url.searchParams.set("endTime", new Date().toISOString());
  url.searchParams.set("resolutionSeconds", "3600");
  const response = await fetch(url, {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    signal: AbortSignal.timeout(4500), redirect: "error"
  });
  if (!response.ok) throw new Error("render_metric_unavailable");
  const payload: unknown = await response.json();
  return Array.isArray(payload) ? payload as Series[] : [];
}
const latest = (series: Series[]) => series.flatMap(s => (s.values ?? []).map(v => ({
  value: v.value, unit: s.unit ?? "", timestamp: v.timestamp
}))).sort((a,b) => b.timestamp.localeCompare(a.timestamp))[0] ?? null;

/** The only data visible here is measurements, never the Render API token. */
export function systemMonitorRoutes(pool: Pool): Router {
  const router = Router();
  router.get("/system-monitor/main", handler(async (req,res) => {
    await owner(pool,req);
    res.json(await databaseMonitor(pool,"الرئيسي",Number(process.env.MAIN_DATABASE_DISK_GB ?? 5)));
  }));
  router.get("/system-monitor/main/count",handler(async(req,res)=>{
    await owner(pool,req);
    const schema = req.query.schema, table = req.query.table;
    if (typeof schema !== "string" || typeof table !== "string") {
      return res.status(400).json({error:{code:"invalid_table",message:"حدد الجدول"}});
    }
    res.json(await exactTableCount(pool,schema,table));
  }));
  router.get("/system-monitor/runtime",handler(async(req,res)=>{
    await owner(pool,req);
    const [build,fs] = await Promise.all([builtFiles(),statfs(runtimeRoot).catch(() => null)]);
    const memory = process.memoryUsage();
    res.json({
      updatedAt: new Date().toISOString(),
      buildSizeBytes: build.sizeBytes, buildFileCount: build.fileCount,
      processMemoryBytes: memory.rss, processHeapBytes: memory.heapUsed,
      processUptimeSeconds: Math.floor(process.uptime()),
      // Ephemeral container filesystem is NOT an allotted storage plan.
      ephemeralFileSystemBytes: fs ? fs.blocks*fs.bsize : null,
      ephemeralFreeBytes: fs ? fs.bavail*fs.bsize : null,
      storageNote: "مساحة الحاوية مؤقتة وليست مساحة تخزين مدفوعة أو مضمونة",
      serviceUrl: "https://dashboard.render.com/web/srv-dbdlueo473hc73cqtsb0"
    });
  }));
  router.get("/system-monitor/render",handler(async(req,res)=>{
    await owner(pool,req);
    const token = process.env.RENDER_API_KEY?.trim();
    const apiConnected = !!token;
    const start = new Date(), startOfMonth = new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth(),1)).toISOString();
    const serviceId = process.env.RENDER_SERVICE_ID ?? "srv-dbdlueo473hc73cqtsb0";
    if (!token) return res.json({apiConnected:false,updatedAt:new Date().toISOString(),bandwidthGB:null,memory:null,cpu:null,
      note:"يلزم مفتاح Render API للقراءة فقط في متغير RENDER_API_KEY حتى تظهر قياسات Render تلقائيًا؛ مؤشرات الفوترة تُراجع من لوحة Render.",
      billingUrl:"https://dashboard.render.com/billing"});
    try {
      const [bandwidth,memory,cpu] = await Promise.all([
        renderMetric("bandwidth",serviceId,startOfMonth,token),
        renderMetric("memory",serviceId,new Date(Date.now()-3600000).toISOString(),token),
        renderMetric("cpu",serviceId,new Date(Date.now()-3600000).toISOString(),token),
      ]);
      // Render bandwidth series is in GB; each timestamp is an interval, not a running counter.
      const bandwidthGB = bandwidth.reduce((sum,s)=>sum+(s.values ?? []).reduce((v,p)=>v+(s.unit?.toLowerCase()==="gb"?p.value:s.unit?.toLowerCase()==="mb"?p.value/1000:0),0),0);
      res.json({apiConnected,updatedAt:new Date().toISOString(),bandwidthGB,memory:latest(memory),cpu:latest(cpu),
        scope:"الخدمة الرئيسية فقط، وليست إجمالي الاستهلاك المفوتر لمساحة العمل",
        note:"الدقائق المجانية وPipeline وعدد النطاقات ورسوم الفوترة تعرضها لوحة Render؛ ليست ضمن قياسات هذه الواجهة.",
        billingUrl:"https://dashboard.render.com/billing"});
    } catch {
      res.json({apiConnected,updatedAt:new Date().toISOString(),bandwidthGB:null,memory:null,cpu:null,
        note:"تعذرت قراءة قياسات Render. تحقق من صلاحية المفتاح وراجع لوحة الفوترة.",
        billingUrl:"https://dashboard.render.com/billing"});
    }
  }));
  return router;
}
