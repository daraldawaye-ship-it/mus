import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  optionValueError,
  type OptionDefinition,
} from "../../../packages/contracts/src/index";
import { api, useScopeGuard, useSession } from "./api";
import { errorMessage } from "./phase2";
import { Button, Card, Field, Notice, Select } from "./ui";

type StoredValue = {
  id: number;
  definitionId: number;
  value: string | boolean | null;
  revision: number;
};
type RecordOptions = {
  definitions: OptionDefinition[];
  values: StoredValue[];
  native: { archived: boolean; hasExpiry: boolean | null };
};
type Props = {
  companyId: number;
  recordKind: "item" | "account";
  recordId: number;
  canEdit: boolean;
};
export function RecordOptionCard(props: Props) {
  const { user } = useSession();
  return (
    <RecordOptionFields
      key={`${user?.id}:${props.companyId}:${props.recordKind}:${props.recordId}`}
      {...props}
    />
  );
}
function RecordOptionFields({
  companyId,
  recordKind,
  recordId,
  canEdit,
}: Props) {
  const { user } = useSession();
  const client = useQueryClient();
  const guard = useScopeGuard(
    `company:${companyId}:${recordKind}:${recordId}:options`,
  );
  const key = ["record-options", user?.id, companyId, recordKind, recordId];
  const url = `/companies/${companyId}/configuration/record-options?recordKind=${recordKind}&recordId=${recordId}`;
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api<RecordOptions>(url, { signal }),
    enabled: !!user,
  });
  const [edited, setEdited] = useState<Record<number, string | boolean | null>>(
    {},
  );
  const [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const valueOf = (definition: OptionDefinition): string | boolean | null => {
    if (
      definition.nativeBinding === "items.archived" ||
      definition.nativeBinding === "accounts.archived"
    )
      return query.data?.native.archived ?? false;
    if (definition.nativeBinding === "items.has_expiry")
      return query.data?.native.hasExpiry ?? true;
    return Object.prototype.hasOwnProperty.call(edited, definition.id)
      ? edited[definition.id]!
      : (query.data?.values.find((v) => v.definitionId === definition.id)
          ?.value ?? null);
  };
  const show = (value: string | boolean | null): string =>
    value === null
      ? "غير محدد"
      : typeof value === "boolean"
        ? value
          ? "نعم"
          : "لا"
        : value;
  const save = async (definition: OptionDefinition) => {
    if (pending !== null || !canEdit) return;
    const validation = optionValueError(definition, valueOf(definition));
    if (validation) {
      setError(definition.name + ": " + validation);
      return;
    }
    setPending(definition.id);
    setError("");
    setNotice("");
    try {
      const row = query.data?.values.find(
        (v) => v.definitionId === definition.id,
      );
      await api(url, {
        method: "PUT",
        signal: guard.signal,
        body: {
          definitionId: definition.id,
          value: valueOf(definition),
          revision: row?.revision ?? null,
        },
      });
      if (!guard.isCurrent()) return;
      await Promise.all([
        client.invalidateQueries({ queryKey: key }),
        client.invalidateQueries({
          queryKey: [
            "list",
            user?.id,
            `company:${companyId}:${recordKind === "item" ? "items" : "accounts"}`,
          ],
        }),
      ]);
      if (guard.isCurrent()) {
        setEdited((previous) => {
          const next = { ...previous };
          delete next[definition.id];
          return next;
        });
        setNotice("تم حفظ الخيار: " + definition.name);
      }
    } catch (cause) {
      if (guard.isCurrent()) setError(errorMessage(cause));
    } finally {
      if (guard.isCurrent()) setPending(null);
    }
  };
  return (
    <Card
      title="الخيارات الإضافية"
      description="القيم تخص هذا السجل؛ الافتراضي يطبّق عند إنشاء سجلات جديدة فقط."
    >
      {query.isPending && <Notice>جارٍ تحميل خيارات السجل…</Notice>}
      {query.error && (
        <Notice tone="error">
          {errorMessage(query.error)}{" "}
          <Button onClick={() => void query.refetch()}>إعادة المحاولة</Button>
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice tone="success">{notice}</Notice>}
      {query.data && query.data.definitions.length === 0 && (
        <p>لا توجد خيارات إضافية لهذا الكرت بعد.</p>
      )}
      {query.data?.definitions
        .filter(
          (definition) =>
            definition.active ||
            query.data?.values.some((v) => v.definitionId === definition.id),
        )
        .map((definition) => {
          const stored = query.data?.values.find(
            (v) => v.definitionId === definition.id,
          );
          const locked =
            !!definition.nativeBinding || !definition.active || !canEdit;
          const current = valueOf(definition);
          const changed = Object.prototype.hasOwnProperty.call(
            edited,
            definition.id,
          );
          const validation = changed
            ? optionValueError(definition, current)
            : null;
          return (
            <div className="configuration-value-row" key={definition.id}>
              <div className="configuration-value-heading">
                <strong>
                  {definition.name}
                  {definition.required ? " *" : ""}
                </strong>
                {definition.description && (
                  <small className="muted">{definition.description}</small>
                )}
              </div>
              {locked ? (
                <span>
                  {definition.valueType === "list"
                    ? (definition.choices.find((c) => c.key === current)
                        ?.label ?? show(current))
                    : show(current)}{" "}
                  {definition.nativeBinding
                    ? "(مرتبط بحقل الكرت الأساسي)"
                    : definition.active
                      ? ""
                      : "(مؤرشف)"}
                </span>
              ) : definition.valueType === "boolean" ? (
                <Select
                  label={definition.name}
                  value={current === null ? "" : String(current)}
                  disabled={pending !== null}
                  onChange={(e) =>
                    setEdited((previous) => ({
                      ...previous,
                      [definition.id]:
                        e.target.value === ""
                          ? null
                          : e.target.value === "true",
                    }))
                  }
                >
                  <option value="">غير محدد</option>
                  <option value="true">نعم</option>
                  <option value="false">لا</option>
                </Select>
              ) : definition.valueType === "list" ? (
                <Select
                  label={definition.name}
                  value={String(current ?? "")}
                  disabled={pending !== null}
                  onChange={(e) =>
                    setEdited((previous) => ({
                      ...previous,
                      [definition.id]: e.target.value || null,
                    }))
                  }
                >
                  <option value="">غير محدد</option>
                  {definition.choices.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              ) : (
                <Field
                  label={definition.name}
                  disabled={pending !== null}
                  maxLength={2000}
                  error={validation ?? undefined}
                  type={definition.valueType === "date" ? "date" : "text"}
                  inputMode={
                    definition.valueType === "decimal"
                      ? "decimal"
                      : definition.valueType === "integer"
                        ? "numeric"
                        : undefined
                  }
                  value={String(current ?? "")}
                  onChange={(e) =>
                    setEdited((previous) => ({
                      ...previous,
                      [definition.id]: e.target.value || null,
                    }))
                  }
                />
              )}
              {!locked && (
                <Button
                  variant="secondary"
                  size="compact"
                  disabled={pending !== null || !changed || !!validation}
                  onClick={() => void save(definition)}
                >
                  {pending === definition.id ? "جارٍ الحفظ…" : "حفظ القيمة"}
                </Button>
              )}
            </div>
          );
        })}
    </Card>
  );
}
