import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import {
  optionValueError,
  type OptionDefinition,
  type OptionListRecord,
  type OptionScalar,
} from "../../../packages/contracts/src/index";
import { Button, Field, Select, ValueCell } from "./ui";

export const optionFilterKeys = [
  "optionId",
  "optionOperator",
  "optionValue",
] as const;

export function optionListValue(
  definition: OptionDefinition,
  value: OptionScalar | undefined,
) {
  if (value === null || value === undefined) return "غير محدد";
  if (typeof value === "boolean") return value ? "نعم" : "لا";
  if (definition.valueType === "list")
    return (
      definition.choices.find((choice) => choice.key === value)?.label ?? value
    );
  return value;
}

export function optionListColumns<T>(
  definitions: OptionDefinition[],
): ColumnDef<OptionListRecord<T>, unknown>[] {
  return definitions
    .filter((definition) => definition.active && definition.showInList)
    .map((definition) => ({
      id: `option.${definition.id}`,
      header: definition.name,
      accessorFn: (record) =>
        record.optionValues?.[String(definition.id)] ?? null,
      size: 150,
      cell: ({ row }) => (
        <ValueCell>
          <bdi>
            {optionListValue(
              definition,
              row.original.optionValues?.[String(definition.id)],
            )}
          </bdi>
        </ValueCell>
      ),
    }));
}

const operatorNames: Record<string, string> = {
  eq: "يساوي",
  contains: "يحتوي على",
  gte: "أكبر من أو يساوي",
  lte: "أصغر من أو يساوي",
  empty: "غير محدد",
  filled: "محدد",
};

/** One typed filter, combined with the list's existing URL filters and sorting. */
export function OptionListTools({
  definitions,
  query,
  onClearSearch,
}: {
  definitions: OptionDefinition[];
  query: string;
  onClearSearch: () => void;
}) {
  const [params, setParams] = useSearchParams();
  const savedId = params.get("optionId") ?? "";
  const savedOperator = params.get("optionOperator") ?? "eq";
  const savedValue = params.get("optionValue") ?? "";
  const [id, setId] = useState(savedId);
  const [operator, setOperator] = useState(savedOperator);
  const [value, setValue] = useState(savedValue);
  useEffect(() => {
    setId(savedId);
    setOperator(savedOperator);
    setValue(savedValue);
  }, [savedId, savedOperator, savedValue]);
  const searchable = definitions.filter(
    (definition) => definition.active && definition.searchable,
  );
  const definition = searchable.find((entry) => String(entry.id) === id);
  const operators =
    definition?.valueType === "text"
      ? ["eq", "contains", "empty", "filled"]
      : definition &&
          ["integer", "decimal", "date"].includes(definition.valueType)
        ? ["eq", "gte", "lte", "empty", "filled"]
        : ["eq", "empty", "filled"];
  const needsValue = !["empty", "filled"].includes(operator);
  const scalar = definition?.valueType === "boolean" ? value === "true" : value;
  const validation =
    definition && needsValue
      ? value === ""
        ? "أدخل قيمة التصفية."
        : definition.valueType === "boolean" &&
            !["true", "false"].includes(value)
          ? "اختر نعم أو لا."
          : optionValueError({ ...definition, required: true }, scalar)
      : null;
  const customSort = (params.get("sort") ?? "")
    .split(",")
    .some((part) => part.startsWith("option."));
  function clearFilter() {
    setId("");
    setOperator("eq");
    setValue("");
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const key of optionFilterKeys) next.delete(key);
      next.delete("page");
      return next;
    });
  }
  if (!searchable.length && !savedId && !customSort && !query) return null;
  return (
    <form
      className="table-filters"
      aria-label="تصفية الخيارات الإضافية"
      onSubmit={(event) => {
        event.preventDefault();
        if (!definition || validation || !operators.includes(operator)) return;
        setParams((previous) => {
          const next = new URLSearchParams(previous);
          next.set("optionId", id);
          next.set("optionOperator", operator);
          needsValue
            ? next.set("optionValue", value)
            : next.delete("optionValue");
          next.delete("page");
          return next;
        });
      }}
    >
      {(searchable.length > 0 || savedId) && (
        <>
          <Select
            label="تصفية حسب الخيار"
            value={id}
            onChange={(event) => {
              setId(event.target.value);
              setOperator("eq");
              setValue("");
            }}
          >
            <option value="">اختر خيارًا</option>
            {id && !definition && (
              <option value={id}>خيار غير متاح — أزل التصفية</option>
            )}
            {searchable.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </Select>
          {definition && (
            <Select
              label="شرط الخيار"
              value={operator}
              onChange={(event) => setOperator(event.target.value)}
            >
              {operators.map((entry) => (
                <option key={entry} value={entry}>
                  {operatorNames[entry]}
                </option>
              ))}
            </Select>
          )}
          {definition &&
            needsValue &&
            (definition.valueType === "boolean" ? (
              <Select
                label="قيمة الخيار"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              >
                <option value="">اختر القيمة</option>
                <option value="true">نعم</option>
                <option value="false">لا</option>
              </Select>
            ) : definition.valueType === "list" ? (
              <Select
                label="قيمة الخيار"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              >
                <option value="">اختر القيمة</option>
                {definition.choices.map((choice) => (
                  <option key={choice.key} value={choice.key}>
                    {choice.label}
                  </option>
                ))}
              </Select>
            ) : (
              <Field
                label="قيمة الخيار"
                type={definition.valueType === "date" ? "date" : "text"}
                inputMode={
                  definition.valueType === "decimal"
                    ? "decimal"
                    : definition.valueType === "integer"
                      ? "numeric"
                      : undefined
                }
                value={value}
                maxLength={2000}
                onChange={(event) => setValue(event.target.value)}
                error={value ? (validation ?? undefined) : undefined}
              />
            ))}
          <Button
            type="submit"
            variant="secondary"
            disabled={
              !definition || !!validation || !operators.includes(operator)
            }
          >
            تطبيق تصفية الخيار
          </Button>
          {(savedId || id) && (
            <Button variant="ghost" onClick={clearFilter}>
              إزالة تصفية الخيار
            </Button>
          )}
        </>
      )}
      {customSort && (
        <Button
          variant="ghost"
          onClick={() =>
            setParams((previous) => {
              const next = new URLSearchParams(previous);
              const remaining = (next.get("sort") ?? "")
                .split(",")
                .filter((part) => !part.startsWith("option."))
                .join(",");
              remaining ? next.set("sort", remaining) : next.delete("sort");
              next.delete("page");
              return next;
            })
          }
        >
          إزالة ترتيب الخيارات
        </Button>
      )}
      {query && (
        <Button variant="ghost" onClick={onClearSearch}>
          مسح البحث
        </Button>
      )}
    </form>
  );
}
