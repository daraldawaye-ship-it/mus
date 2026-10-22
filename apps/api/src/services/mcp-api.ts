import type { Request, Response, NextFunction, Router } from "express";
import { z } from "zod";
import contracts from "../mcp-contracts.json" with { type: "json" };
import { permissionRequest } from "./permission-rules.ts";
import type { User } from "../../../../packages/contracts/src/index.ts";

export const API_READ_SCOPE = "tijara.read";
export const API_WRITE_SCOPE = "tijara.write";
// Company users connect with site-only scopes. The global general table
// remains an administrative resource, even when bundled with site access.
export const SITE_READ_SCOPE = API_READ_SCOPE;
export const SITE_WRITE_SCOPE = API_READ_SCOPE + " " + API_WRITE_SCOPE;
export const FULL_READ_SCOPE = "general_table.read tijara.read";
export const FULL_WRITE_SCOPE =
  "general_table.read general_table.write tijara.read tijara.write";
export const oauthScopes = [
  "general_table.read",
  "general_table.read general_table.write",
  SITE_READ_SCOPE,
  SITE_WRITE_SCOPE,
  FULL_READ_SCOPE,
  FULL_WRITE_SCOPE,
];

export function scopeIncludes(scope: string, permission: string): boolean {
  return scope.split(/\s+/).includes(permission);
}
export function scopeRequiresPublicAdmin(scope: string): boolean {
  return scopeIncludes(scope, "general_table.read") ||
    scopeIncludes(scope, "general_table.write");
}
export function canReadGeneralTable(
  scope: string,
  user: Pick<User, "owner" | "kind">,
): boolean {
  return scopeIncludes(scope, "general_table.read") &&
    (user.owner || user.kind === "admin");
}

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
}
interface Operation {
  method: string;
  path: string;
}
export function apiOperations(router: Router): Operation[] {
  const result: Operation[] = [];
  const visit = (layers: Layer[]) => {
    for (const layer of layers) {
      if (layer.route) {
        const { path, methods } = layer.route;
        // Credential lifecycle stays in the browser's dedicated authentication flow.
        if (path.includes("password")) continue;
        for (const method of ["get", "post", "put", "patch", "delete"])
          if (methods[method])
            result.push({ method: method.toUpperCase(), path });
      } else if (layer.handle?.stack) visit(layer.handle.stack);
    }
  };
  visit(router.stack as Layer[]);
  return result;
}
const common = {
  operation: {
    type: "string",
    description:
      "القيمة method + space + path من catalog، مثل GET /companies/:companyId/employees",
  },
  pathParams: {
    type: "object",
    additionalProperties: { type: ["string", "integer"] },
  },
  query: {
    type: "object",
    additionalProperties: { type: ["string", "integer", "boolean"] },
  },
};
export const apiTools = [
  {
    name: "tijara_api_catalog",
    description:
      "اكتشف عمليات الرئيسي الحالية وحقول الطلب قبل التنفيذ. يشمل الشركات والمستخدمين والموظفين وحساباتهم وخياراتهم والدوام والمحفظة والمذكرات والإشعارات والحسابات والفواتير والمخزون والإعدادات. أرسل operation للحصول على عقد عملية بعينها، أو filter للبحث في المسارات. لا يمنح وصولًا يتجاوز حساب المستخدم.",
    inputSchema: {
      type: "object",
      properties: { operation: { type: "string" }, filter: { type: "string" } },
      additionalProperties: false,
    },
    securitySchemes: [
      { type: "oauth2", scopes: ["general_table.read", API_READ_SCOPE] },
    ],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "tijara_api_read",
    description:
      "نفّذ عملية GET مسجلة من catalog بنفس صلاحيات الموقع وعزل الشركات. استخدم معرفات مؤكدة وpathParams وquery؛ يدعم البحث والصفحات والفرز. اقرأ catalog أولًا. لا تقبل روابط خارجية أو SQL.",
    inputSchema: {
      type: "object",
      properties: common,
      required: ["operation"],
      additionalProperties: false,
    },
    securitySchemes: [
      { type: "oauth2", scopes: ["general_table.read", API_READ_SCOPE] },
    ],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "tijara_api_write",
    description:
      "نفّذ عملية POST/PUT/PATCH/DELETE مسجلة من catalog بعد طلب المستخدم. تشمل إنشاء وتعديل الموظفين وإعدادات حضورهم وخياراتهم وحساباتهم وغيرها من عمليات الموقع المنفذة. اقرأ عقد العملية والسجل أولًا؛ احفظ revisions ومفاتيح UUID وأعد استخدامهما عند إعادة المحاولة. العمليات المالية قد ترحّل أو تعكس مستندات. تطبق صلاحيات الموقع والمعاملات والتدقيق؛ لا SQL أو تجاوز للصلاحيات.",
    inputSchema: {
      type: "object",
      properties: {
        ...common,
        body: { type: "object", additionalProperties: true },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    securitySchemes: [
      {
        type: "oauth2",
        scopes: [
          "general_table.read",
          "general_table.write",
          API_READ_SCOPE,
          API_WRITE_SCOPE,
        ],
      },
    ],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];
const catalogSchema = z
  .object({
    operation: z.string().max(300).optional(),
    filter: z.string().max(120).optional(),
  })
  .strict();
const requestSchema = z
  .object({
    operation: z.string().max(300),
    pathParams: z
      .record(
        z.string(),
        z.union([z.string().max(200), z.number().int().safe()]),
      )
      .default({}),
    query: z
      .record(
        z.string(),
        z.union([z.string().max(4000), z.number().int().safe(), z.boolean()]),
      )
      .default({}),
    body: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export function apiCatalog(router: Router, input: unknown) {
  const { operation, filter } = catalogSchema.parse(input);
  const operations = apiOperations(router).filter(
    (op) =>
      (!operation || op.method + " " + op.path === operation) &&
      (!filter || op.path.toLowerCase().includes(filter.toLowerCase())),
  );
  return {
    operations: operations.map((op) => ({
      operation: op.method + " " + op.path,
      tool: op.method === "GET" ? "tijara_api_read" : "tijara_api_write",
      ...(operation
        ? ((contracts as Record<string, unknown>)[
            op.method + " " + op.path
          ] as object)
        : {}),
    })),
    instructions:
      "المسارات نسبية إلى /api. اقرأ العملية المحددة للحصول على bodySchema. القوائم تدعم q/page/pageSize/sort حيث يتاح ذلك. كل المبالغ والكميات الدقيقة نصوص. bodySchema وصف بنيوي؛ تحقق الخادم من العلاقات والصلاحيات والقواعد الإضافية يبقى نهائيًا. لا تفترض حقولًا أو قيم أجور. read ثم تعديل باستخدام أحدث revision أو UUID حيث يطلب العقد. إنشاء الموظف بـ userId موجود؛ createSalesCashbox ينشئ صندوقًا جديدًا، والحافظة والسلفة تُهيآن تلقائيًا. إعداد الدوام وخيارات الموظف عمليتان مستقلتان. لا تنسخ معرف حساب مالي خاص بموظف آخر.",
  };
}

/** Dispatch directly to the SAME domain router, without HTTP, cookies, new sessions,
 * arbitrary paths, or a second implementation of financial/permission logic. */
export function dispatchApi(
  router: Router,
  req: Request,
  res: Response,
  next: NextFunction,
  user: User,
  tool: string,
  input: unknown,
  rpcId: string | number,
) {
  const args = requestSchema.parse(input);
  const operation = apiOperations(router).find(
    (op) => op.method + " " + op.path === args.operation,
  );
  if (
    !operation ||
    (operation.method === "GET") !== (tool === "tijara_api_read")
  )
    throw new Error(
      "Unknown operation or wrong read/write tool; inspect tijara_api_catalog",
    );
  if (tool === "tijara_api_read" && args.body !== undefined)
    throw new Error("Read operations cannot have a body");
  const required = [...operation.path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map(
    (m) => m[1]!,
  );
  if (
    Object.keys(args.pathParams).some((key) => !required.includes(key)) ||
    required.some((key) => args.pathParams[key] === undefined)
  )
    throw new Error("Supply exactly the operation's pathParams");
  const path = operation.path.replace(
    /:([A-Za-z][A-Za-z0-9]*)/g,
    (_, key: string) => {
      const value = String(args.pathParams[key]);
      if (!/^[A-Za-z0-9_.:-]+$/.test(value) || value === "." || value === "..")
        throw new Error("Invalid path parameter");
      return encodeURIComponent(value);
    },
  );
  const query = new URLSearchParams(
    Object.entries(args.query).map(([k, v]) => [k, String(v)]),
  ).toString();
  const url = path + (query ? "?" + query : "");
  const previous = {
    method: req.method,
    url: req.url,
    originalUrl: req.originalUrl,
    baseUrl: req.baseUrl,
    body: req.body,
    auth: req.auth,
  };
  const json = res.json;
  const restore = () => {
    Object.assign(req, previous);
    res.json = json;
  };
  req.method = operation.method;
  req.url = url;
  req.originalUrl = "/api" + url;
  req.baseUrl = "/api";
  req.body = args.body ?? {};
  req.auth = { user, tokenHash: "", csrf: "" };
  res.json = function (data: unknown) {
    const status = res.statusCode;
    restore();
    return json.call(res.status(200), {
      jsonrpc: "2.0",
      id: rpcId,
      result: {
        content: [{ type: "text", text: JSON.stringify({ status, data }) }],
        structuredContent: { status, data },
        ...(status >= 400 ? { isError: true } : {}),
      },
    });
  };
  permissionRequest.run(req, () =>
    router(req, res, (error?: unknown) => {
      if (error)
        next(error); // Existing API error handler is also wrapped as an MCP result.
      else
        res
          .status(404)
          .json({ error: { code: "not_found", message: "المسار غير موجود" } });
    }),
  );
}
