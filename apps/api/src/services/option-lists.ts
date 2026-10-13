import type { Request } from "express";
import type { QueryResultRow } from "pg";
import type { Database } from "../db.ts";
import { HttpError } from "../errors.ts";
import { id } from "../http.ts";
import { searchPattern } from "./lists.ts";
import {
  optionValueError,
  type OptionDefinition,
  type OptionScalar,
} from "../../../../packages/contracts/src/index.ts";

type Kind = "item" | "account";
function invalid(message = "تصفية الخيار غير صالحة."): never {
  throw new HttpError(400, "invalid_option_filter", message);
}

/** Read metadata through the same company/module permission as the master list. */
export async function optionListPlan(
  db: Database,
  req: Request,
  companyId: number,
  kind: Kind,
  alias: string,
) {
  const result = await db.query<OptionDefinition>(
    `SELECT id,key,page_key AS "pageKey",record_kind AS "recordKind",name,description,
    value_type AS "valueType",default_value AS "defaultValue",choices,required,searchable,
    show_on_card AS "showOnCard",show_in_list AS "showInList",sort_order AS "sortOrder",active,
    is_system AS system,native_binding AS "nativeBinding",revision
    FROM option_definitions WHERE company_id=$1 AND record_kind=$2 AND active AND (show_in_list OR searchable)
    ORDER BY sort_order,id`,
    [companyId, kind],
  );
  const definitions = result.rows;
  const recordColumn = kind === "item" ? "item_id" : "account_id";
  // Alias and identifiers are server-owned; option IDs come from PostgreSQL.
  const json = (definition: OptionDefinition) =>
    definition.nativeBinding
      ? definition.nativeBinding.endsWith(".archived")
        ? `to_jsonb(NOT ${alias}.active)`
        : `to_jsonb(${alias}.has_expiry)`
      : `(SELECT ov.value FROM option_values ov WHERE ov.company_id=${alias}.company_id AND ov.definition_id=${definition.id} AND ov.${recordColumn}=${alias}.id)`;
  const scalar = (definition: OptionDefinition) =>
    `(${json(definition)} #>> '{}')`;
  const label = (definition: OptionDefinition) =>
    definition.valueType === "list"
      ? `(SELECT choice->>'label' FROM option_definitions od CROSS JOIN LATERAL jsonb_array_elements(od.choices) choice
        WHERE od.company_id=${alias}.company_id AND od.id=${definition.id} AND choice->>'key'=${scalar(definition)})`
      : definition.valueType === "boolean"
        ? `(CASE ${scalar(definition)} WHEN 'true' THEN 'نعم' WHEN 'false' THEN 'لا' END)`
        : scalar(definition);
  const typed = (definition: OptionDefinition) =>
    definition.valueType === "integer" || definition.valueType === "decimal"
      ? `(${scalar(definition)})::numeric`
      : definition.valueType === "date"
        ? `(${scalar(definition)})::date`
        : definition.valueType === "boolean"
          ? `(${scalar(definition)})::boolean`
          : label(definition);
  const sortColumns = Object.fromEntries(
    definitions
      .filter((d) => d.showInList)
      .map((d) => [`option.${d.id}`, typed(d)]),
  );
  const search = definitions
    .filter((d) => d.searchable)
    .map((d) => `${label(d)} ILIKE $2`)
    .join(" OR ");
  const query = req.query;
  let selected: OptionDefinition | undefined;
  let operator: string | undefined;
  let value: OptionScalar = null;
  if (query.optionId !== undefined) {
    const definitionId = id(
      typeof query.optionId === "string" ? query.optionId : undefined,
    );
    selected = definitions.find((d) => d.id === definitionId && d.searchable);
    if (!selected)
      invalid(
        "الخيار المستخدم في التصفية مؤرشف أو غير متاح للبحث؛ أزل تصفية الخيار.",
      );
    if (typeof query.optionOperator !== "string") invalid();
    operator = query.optionOperator;
    const allowed = [
      "eq",
      "empty",
      "filled",
      ...(selected.valueType === "text" ? ["contains"] : []),
      ...(["integer", "decimal", "date"].includes(selected.valueType)
        ? ["gte", "lte"]
        : []),
    ];
    if (!allowed.includes(operator)) invalid();
    if (operator !== "empty" && operator !== "filled") {
      if (typeof query.optionValue !== "string") invalid();
      value =
        selected.valueType === "boolean"
          ? query.optionValue === "true"
            ? true
            : query.optionValue === "false"
              ? false
              : invalid()
          : query.optionValue;
      const error = optionValueError({ ...selected, required: false }, value);
      if (error) invalid(error);
    }
  } else if (
    query.optionOperator !== undefined ||
    query.optionValue !== undefined
  )
    invalid();

  return {
    definitions,
    sortColumns,
    search,
    filter(parameters: unknown[]): string {
      if (!selected || !operator) return "";
      const expression = scalar(selected);
      if (operator === "empty")
        return `(${expression} IS NULL OR ${expression}='')`;
      if (operator === "filled")
        return `(${expression} IS NOT NULL AND ${expression}<>'')`;
      parameters.push(
        operator === "contains" ? searchPattern(String(value)) : value,
      );
      const parameter = `$${parameters.length}`;
      if (operator === "contains") return `${expression} ILIKE ${parameter}`;
      // Choice filters compare stable keys, while sorting/search use their labels.
      const left = selected.valueType === "list" ? expression : typed(selected);
      const comparison =
        operator === "gte" ? ">=" : operator === "lte" ? "<=" : "=";
      return `${left} ${comparison} ${parameter}`;
    },
    async rows<T>(rows: QueryResultRow[], dto: (row: QueryResultRow) => T) {
      const visible = definitions.filter((d) => d.showInList);
      const custom = visible.filter((d) => !d.nativeBinding);
      const stored =
        custom.length && rows.length
          ? await db.query<{
              record_id: number;
              definition_id: number;
              value: OptionScalar;
            }>(
              `SELECT ${recordColumn} AS record_id,definition_id,value FROM option_values
          WHERE company_id=$1 AND record_kind=$2 AND ${recordColumn}=ANY($3::integer[]) AND definition_id=ANY($4::integer[])`,
              [
                companyId,
                kind,
                rows.map((row) => row.id),
                custom.map((d) => d.id),
              ],
            )
          : null;
      const values = new Map<number, Record<string, OptionScalar>>();
      for (const row of stored?.rows ?? []) {
        const record = values.get(row.record_id) ?? {};
        record[String(row.definition_id)] = row.value;
        values.set(row.record_id, record);
      }
      return rows.map((row) => ({
        ...dto(row),
        optionValues: Object.fromEntries(
          visible.map((definition) => [
            String(definition.id),
            definition.nativeBinding
              ? definition.nativeBinding.endsWith(".archived")
                ? !row.active
                : row.has_expiry
              : (values.get(row.id)?.[String(definition.id)] ?? null),
          ]),
        ),
      }));
    },
  };
}
