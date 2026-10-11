import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CompanyContext,
  Page,
} from "../../../packages/contracts/src/index";
import { api, useSession } from "./api";
import { Button, Field, Notice, Select } from "./ui";

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "تعذر إكمال الطلب. حاول مجددًا.";

export function moduleAccess(
  context: CompanyContext,
  module: "accounts" | "currencies" | "locations",
  manage = false,
) {
  return (
    context.general ||
    context.permissions.some(
      (permission) =>
        permission === `${module}.manage` ||
        (!manage && permission === `${module}.view`),
    )
  );
}

export function useMasterChanges(companyId: number) {
  const client = useQueryClient();
  const { user } = useSession();
  return async () => {
    await client.invalidateQueries({
      predicate: ({ queryKey }) =>
        queryKey[1] === user?.id &&
        ((queryKey[0] === "company" && queryKey[2] === companyId) ||
          (queryKey[0] === "master" && queryKey[2] === companyId) ||
          (queryKey[0] === "list" &&
            String(queryKey[2]).startsWith(`company:${companyId}:`))),
    });
  };
}

/** Searches each page on the server, while preserving an explicit selection. */
export function ServerLookup<T extends { id: number }>({
  companyId,
  resource,
  label,
  value,
  onChange,
  display,
  disabled = false,
  required = false,
  accept,
  emptyLabel = "اختر من النتائج",
}: {
  companyId: number;
  resource: string;
  label: string;
  value: T | null;
  onChange: (value: T | null) => void;
  display: (value: T) => string;
  disabled?: boolean;
  required?: boolean;
  accept?: (value: T) => boolean;
  emptyLabel?: string;
}) {
  const { user } = useSession();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const result = useQuery({
    queryKey: ["master", user?.id, companyId, "lookup", resource, query, page],
    queryFn: ({ signal }) => {
      const [path, search = ""] = resource.split("?");
      const params = new URLSearchParams(search);
      params.set("q", query);
      params.set("page", String(page));
      params.set("pageSize", "20");
      params.set("sort", "code:asc");
      return api<Page<T>>(`${path}?${params}`, { signal });
    },
    enabled: !!user,
  });
  const items = (result.data?.items ?? []).filter(
    (item) => !accept || accept(item),
  );
  const options =
    value && !items.some((item) => item.id === value.id)
      ? [value, ...items]
      : items;
  return (
    <div className="server-lookup">
      <Field
        label={`بحث عن ${label}`}
        type="search"
        value={query}
        disabled={disabled}
        onChange={(event) => {
          setQuery(event.target.value);
          setPage(1);
        }}
        placeholder="الاسم أو الكود"
      />
      <Select
        label={label}
        value={value?.id ?? ""}
        required={required}
        disabled={disabled || result.isFetching}
        onChange={(event) =>
          onChange(
            options.find((item) => item.id === Number(event.target.value)) ??
              null,
          )
        }
      >
        <option value="">{emptyLabel}</option>
        {options.map((item) => (
          <option key={item.id} value={item.id}>
            {display(item)}
          </option>
        ))}
      </Select>
      {result.error && (
        <Notice tone="error">{errorMessage(result.error)}</Notice>
      )}
      <div className="lookup-pages">
        <Button
          size="compact"
          variant="secondary"
          disabled={disabled || result.isFetching || page <= 1}
          onClick={() => setPage(page - 1)}
        >
          نتائج سابقة
        </Button>
        <span className="muted" aria-live="polite">
          {result.isFetching
            ? "جارٍ البحث…"
            : `صفحة ${page} · ${result.data?.total ?? 0} نتيجة`}
        </span>
        <Button
          size="compact"
          variant="secondary"
          disabled={
            disabled ||
            result.isFetching ||
            page * 20 >= (result.data?.total ?? 0)
          }
          onClick={() => setPage(page + 1)}
        >
          نتائج تالية
        </Button>
      </div>
    </div>
  );
}
