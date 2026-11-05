import { z } from "zod";
import { explanationMcpSchemas } from "../apps/api/src/routes-explanations.ts";

const inputSchema = (schema: z.ZodType) => z.toJSONSchema(schema, {
  io: "input",
  unrepresentable: "any",
});
const explanationContract = (pathParams: string[]) => ({
  queryFields: [] as string[],
  pathParams,
  source: "routes-explanations.ts",
});

// These handlers use parsed Zod objects/listQuery or dynamic filter names that
// the source scanner cannot discover through direct req.query.field accesses.
export const guideMcpContracts = {
  "GET /explanations/groups/:groupId/tree": explanationContract(["groupId"]),
  "GET /explanations/groups/:groupId/document": {
    ...explanationContract(["groupId"]),
    queryFields: Object.keys(explanationMcpSchemas.documentQuery.shape),
    querySchema: inputSchema(explanationMcpSchemas.documentQuery),
  },
  "GET /explanations/nodes/:nodeId": explanationContract(["nodeId"]),
  "POST /explanations/nodes": {
    ...explanationContract([]),
    bodyContract: "createNode",
    bodySchema: inputSchema(explanationMcpSchemas.createNode),
  },
  "GET /page-catalog": {
    queryFields: ["q", "page", "pageSize", "sort", "section", "scope", "type", "status", "companyId"],
    source: "routes-pages.ts",
  },
};
