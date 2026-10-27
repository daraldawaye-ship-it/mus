import { Router } from "express";
import type { Pool } from "pg";
import {
  pageActions,
  pageByKey,
  pageReferenceSchema,
  pageSettingSchema,
  type PageDirectory,
} from "../../../packages/contracts/src/index.ts";
import { transaction } from "./db.ts";
import { actor, handler, id, parse } from "./http.ts";
import { companyAccess, currentActor, ownerOnly } from "./policies/access.ts";
import { HttpError, missing } from "./errors.ts";
import { audit } from "./services/audit.ts";
import { listQuery } from "./services/lists.ts";
import {
  assertRequestPagesEnabled,
  directoryEntries,
  resolvePage,
} from "./services/pages.ts";

const optionalId = (value: unknown) =>
  value === undefined ? null : id(typeof value === "string" ? value : "");
const searchText = (value: string) =>
  value
    .normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .toLocaleLowerCase("ar");
export function pageRoutes(pool: Pool): Router {
  const router = Router();
  router.get(
    "/page-catalog",
    handler(async (req, res) => {
      const companyId = optionalId(req.query.companyId);
      const columns = {
        id: "id",
        name: "name",
        section: "section",
        type: "type",
        scope: "scope",
        order: "order",
        visible: "visible",
        enabled: "enabled",
      };
      const query = listQuery(req.query, columns, "order:asc");
      const result = await transaction(pool, async (client) => {
        await client.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const user = await currentActor(client, actor(req), false);
        const directory = await directoryEntries(client, user, companyId);
        // Administrators may audit and configure the entire page catalog.
        // Other users should discover only pages they can actually open.
        // User management and chat are admin-only in page navigation,
        // while their existing API permissions remain unchanged.
        const canInspectCatalog = user.owner;
        const entries = canInspectCatalog
          ? directory
          : directory.filter((entry) =>
              entry.visible &&
              entry.enabled &&
              entry.actionAccess.view &&
              ((user.kind === "admin") ||
                !["public.users", "public.chat", "company.chat"].includes(entry.key)),
            );
        const summary = {
          total: entries.length,
          available: entries.filter((entry) => entry.actionAccess.view).length,
          hidden: entries.filter((entry) => !entry.visible).length,
          disabled: entries.filter((entry) => !entry.enabled).length,
          reports: entries.filter((entry) => entry.type === "report").length,
        };
        const filter = (name: string, allowed: string[]) => {
          const value = req.query[name];
          if (value === undefined || value === "") return "";
          if (typeof value !== "string" || !allowed.includes(value))
            throw new HttpError(400, "invalid_query", "فلتر الدليل غير صالح");
          return value;
        };
        const sections = [...new Set(entries.map((entry) => entry.section))];
        const section = filter("section", sections),
          scope = filter("scope", ["public", "company"]),
          type = filter("type", ["page", "report", "form"]),
          status = filter("status", [
            "available",
            "restricted",
            "visible",
            "hidden",
            "enabled",
            "disabled",
          ]);
        const needle = searchText(query.q);
        const filtered = entries.filter(
          (entry) =>
            (!section || entry.section === section) &&
            (!scope || entry.scope === scope) &&
            (!type || entry.type === type) &&
            (!needle ||
              searchText(
                [
                  entry.name,
                  entry.section,
                  entry.description,
                  entry.key,
                  entry.route,
                  ...entry.keywords,
                ].join(" "),
              ).includes(needle)) &&
            (!status ||
              {
                available: entry.actionAccess.view,
                restricted: !entry.actionAccess.view,
                visible: entry.visible,
                hidden: !entry.visible,
                enabled: entry.enabled,
                disabled: !entry.enabled,
              }[status as "available"]),
        );
        const order = (
          typeof req.query.sort === "string" ? req.query.sort : "order:asc"
        )
          .split(",")
          .map((sort) => sort.split(":"));
        const collator = new Intl.Collator("ar", { numeric: true });
        filtered.sort((a, b) => {
          for (const [field, direction] of order) {
            const av = a[field as keyof typeof columns],
              bv = b[field as keyof typeof columns];
            const value =
              typeof av === "number" && typeof bv === "number"
                ? av - bv
                : collator.compare(String(av), String(bv));
            if (value) return direction === "desc" ? -value : value;
          }
          return collator.compare(a.key, b.key);
        });
        return {
          items: filtered.slice(query.offset, query.offset + query.pageSize),
          total: filtered.length,
          page: query.page,
          pageSize: query.pageSize,
          sections,
          summary,
        } satisfies PageDirectory;
      });
      res.json(result);
    }),
  );
  router.get(
    "/page-catalog/:pageKey/resolve",
    handler(async (req, res) => {
      const reference = parse(pageReferenceSchema, {
        pageKey: req.params.pageKey,
        companyId: optionalId(req.query.companyId),
        recordId: optionalId(req.query.recordId),
      });
      const result = await transaction(pool, async (client) => {
        await client.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        return resolvePage(
          client,
          await currentActor(client, actor(req), false),
          reference,
        );
      });
      res.json(result);
    }),
  );
  // Page-level grants shown within each page's detail card.
  router.get("/page-catalog/:pageKey/grants",handler(async(req,res)=>{
    const key=String(req.params.pageKey);
    const definition=pageByKey(key);
    if(!definition)missing();
    const companyId=optionalId(req.query.companyId);
    const result=await transaction(pool,async(client)=>{
      const user=await currentActor(client,actor(req),false);
      if(definition.scope==="company"){
        if(!companyId)throw new HttpError(400,"company_required","حدد الشركة");
        await companyAccess(client,user,companyId,"pages.manage");
      } else ownerOnly(user);
      const grants=await client.query(
        "SELECT id,action,principal_type AS \"principalType\",principal_value AS \"principalValue\",effect FROM page_access_grants WHERE page_key=$1 AND company_id IS NOT DISTINCT FROM $2 ORDER BY id",
        [key,companyId]
      );
      const people=await client.query(
        "SELECT id, display_name AS name, kind, monitor FROM users WHERE archived=false ORDER BY display_name,id"
      );
      const positions=companyId?await client.query(
        "SELECT DISTINCT jsonb_array_elements_text(COALESCE(to_jsonb(position_keys),'[]'::jsonb)) AS key FROM employees WHERE company_id=$1 AND active ORDER BY key",
        [companyId]
      ):{rows:[]};
      return {grants:grants.rows,users:people.rows,positions:positions.rows.map((r)=>r.key)};
    });
    res.json(result);
  }));
  router.put("/page-catalog/:pageKey/grants",handler(async(req,res)=>{
    const key=String(req.params.pageKey),definition=pageByKey(key);
    if(!definition)missing();
    const data=req.body??{};
    const companyId=data.companyId===null?null:optionalId(String(data.companyId));
    if(definition.scope==="company"&&!companyId)throw new HttpError(400,"company_required","حدد الشركة");
    if(definition.scope==="public"&&companyId)throw new HttpError(400,"invalid_scope","الصفحة ليست ضمن الشركة");
    const action=String(data.action??"");
    if(!pageActions.includes(action as typeof pageActions[number])||!definition.actions[action as typeof pageActions[number]])
      throw new HttpError(400,"invalid_action","إجراء غير صالح لهذه الصفحة");
    const principalType=String(data.principalType??"");
    const principalValue=String(data.principalValue??"").trim();
    const effect=data.effect;
    if(!["user","kind","monitor","position"].includes(principalType)||!principalValue||principalValue.length>100)
      throw new HttpError(400,"invalid_principal","حدد نوع المستفيد وقيمته");
    if(principalType==="kind"&&!["admin","supervisor","member"].includes(principalValue)||
       principalType==="monitor"&&principalValue!=="true"||
       principalType==="user"&&!/^[1-9]\d*$/.test(principalValue)||
       principalType==="position"&&!companyId)
      throw new HttpError(400,"invalid_principal","المستفيد غير صالح");
    if(effect!==null&&!["allow","deny"].includes(effect))
      throw new HttpError(400,"invalid_effect","اختر سماح أو منع أو إزالة");
    const result=await transaction(pool,async(client)=>{
      const user=await currentActor(client,actor(req));
      if(companyId)await companyAccess(client,user,companyId,"pages.manage",true);
      else ownerOnly(user);
      if(principalType==="user"){
        const lookup=await client.query("SELECT id FROM users WHERE id=$1 AND archived=false",[Number(principalValue)]);
        if(!lookup.rowCount)missing("المستخدم غير موجود");
      }
      if(principalType==="position"){
        const positions=await client.query("SELECT 1 FROM employees WHERE company_id=$1 AND active AND position_keys @> ARRAY[$2]::text[] LIMIT 1",[companyId,principalValue]);
        if(!positions.rowCount)throw new HttpError(400,"invalid_position","الصفة غير مرتبطة بموظف حالي");
      }
      if(effect===null){
        await client.query(
          "DELETE FROM page_access_grants WHERE page_key=$1 AND company_id IS NOT DISTINCT FROM $2 AND action=$3 AND principal_type=$4 AND principal_value=$5",
          [key,companyId,action,principalType,principalValue]
        );
      }else{
        await client.query(
          "INSERT INTO page_access_grants(page_key,company_id,action,principal_type,principal_value,effect,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (page_key,company_id,action,principal_type,principal_value) DO UPDATE SET effect=EXCLUDED.effect,updated_at=NOW()",
          [key,companyId,action,principalType,principalValue,effect,user.id]
        );
      }
      await audit(client,user,"page.settings","pageAccess",0,null,{key,companyId,action,principalType,principalValue,effect},companyId??undefined);
      return {saved:true};
    });
    res.json(result);
  }));
  router.put(
    "/page-catalog/:pageKey/settings",
    handler(async (req, res) => {
      const input = parse(pageSettingSchema, req.body),
        definition = pageByKey(String(req.params.pageKey));
      if (!definition) missing();
      const result = await transaction(pool, async (client) => {
        const user = await currentActor(client, actor(req));
        if (input.companyId) {
          if (definition.scope !== "company")
            throw new HttpError(
              400,
              "invalid_scope",
              "إعدادات الشركة تخص صفحات الشركة فقط.",
            );
          await companyAccess(
            client,
            user,
            input.companyId,
            "pages.manage",
            true,
          );
        } else ownerOnly(user);
        if (definition.critical)
          throw new HttpError(
            403,
            "protected_page",
            "هذه صفحة أساسية ولا يمكن تغيير إتاحتها.",
          );
        await client.query(
          "SELECT key FROM page_registry WHERE key=$1 FOR UPDATE",
          [definition.key],
        );
        const before = (
          await client.query(
            "SELECT * FROM page_settings WHERE page_key=$1 AND company_id IS NOT DISTINCT FROM $2 FOR UPDATE",
            [definition.key, input.companyId],
          )
        ).rows[0];
        if ((before?.revision ?? null) !== input.revision)
          throw new HttpError(
            409,
            "conflict",
            "تغيرت إعدادات الصفحة؛ أعد تحميلها قبل الحفظ.",
          );
        const after = before
          ? (
              await client.query(
                "UPDATE page_settings SET visible=$1,enabled=$2,sort_order=$3,revision=revision+1,updated_by=$4,updated_at=now() WHERE id=$5 RETURNING *",
                [input.visible, input.enabled, input.order, user.id, before.id],
              )
            ).rows[0]
          : (
              await client.query(
                "INSERT INTO page_settings(page_key,company_id,visible,enabled,sort_order,updated_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
                [
                  definition.key,
                  input.companyId,
                  input.visible,
                  input.enabled,
                  input.order,
                  user.id,
                ],
              )
            ).rows[0];
        const snapshot = (row: typeof after) =>
          row
            ? {
                pageKey: row.page_key,
                companyId: row.company_id,
                visible: row.visible,
                enabled: row.enabled,
                order: row.sort_order,
                revision: row.revision,
              }
            : null;
        await audit(
          client,
          user,
          "page.settings",
          "page",
          after.id,
          snapshot(before),
          snapshot(after),
          input.companyId,
        );
        return (await directoryEntries(client, user, input.companyId)).find(
          (entry) => entry.key === definition.key,
        )!;
      });
      res.json({ page: result });
    }),
  );
  return router;
}
export function pageAvailabilityGate(pool: Pool) {
  return async (
    req: import("express").Request,
    _res: import("express").Response,
    next: import("express").NextFunction,
  ) => {
    try {
      await assertRequestPagesEnabled(pool, req);
      next();
    } catch (error) {
      next(error);
    }
  };
}
