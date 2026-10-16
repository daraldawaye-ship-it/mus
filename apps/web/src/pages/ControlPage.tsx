import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanyContext } from "../../../../packages/contracts/src/index";
import { api, useSession } from "../api";
import { Button, Card, Field, Notice, PageHeader, Select } from "../ui";

type ControlPolicy = { accountantAllowed: boolean; employeeIds: number[]; revision: number | null };
type ControlOption = {
  key: string;
  label: string;
  category: string;
  scope: "company" | "employee";
  type: "boolean" | "hours";
  defaultValue: boolean | number;
  value: boolean | number;
  min?: number;
  max?: number;
  revision: number | null;
  canEdit: boolean;
  integrated: boolean;
  policy: ControlPolicy | null;
};
type Employee = { id: number; name: string; role: string };
type Response = {
  companyId: number;
  employeeId: number | null;
  owner: boolean;
  employees: Employee[];
  options: ControlOption[];
};
function ControlRow({
  option, companyId, selectedEmployeeId, owner, employees, refresh,
}: {
  option: ControlOption;
  companyId: number;
  selectedEmployeeId: number | null;
  owner: boolean;
  employees: Employee[];
  refresh: () => Promise<unknown>;
}) {
  const [value, setValue] = useState<boolean | number>(option.value);
  const [accountantAllowed, setAccountantAllowed] = useState(option.policy?.accountantAllowed ?? false);
  const [delegated, setDelegated] = useState(option.policy?.employeeIds ?? []);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    setValue(option.value);
    setAccountantAllowed(option.policy?.accountantAllowed ?? false);
    setDelegated(option.policy?.employeeIds ?? []);
    setMessage("");
    setError("");
  }, [option.value, option.revision, option.policy?.revision, option.key, selectedEmployeeId]);
  const key = encodeURIComponent(option.key);
  const save = async () => {
    setError("");
    setMessage("");
    setBusy(true);
    try {
      await api(`/companies/${companyId}/control/${key}`, {
        method: "PUT",
        body: {
          value,
          revision: option.revision,
          employeeId: option.scope === "employee" ? selectedEmployeeId : null,
        },
      });
      await refresh();
      setMessage("حُفظ الخيار.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذر حفظ الخيار.");
    } finally {
      setBusy(false);
    }
  };
  const reset = async () => {
    setError("");
    setMessage("");
    setBusy(true);
    try {
      await api(`/companies/${companyId}/control/${key}`, {
        method: "PUT",
        body: {
          value: null, revision: option.revision,
          employeeId: option.scope === "employee" ? selectedEmployeeId : null,
        },
      });
      await refresh();
      setMessage("عادت القيمة الافتراضية.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذر إعادة الخيار.");
    } finally {
      setBusy(false);
    }
  };
  const savePolicy = async () => {
    if (!option.policy) return;
    setError("");
    setMessage("");
    setBusy(true);
    try {
      await api(`/companies/${companyId}/control/${key}/policy`, {
        method: "PUT",
        body: { accountantAllowed, employeeIds: delegated, revision: option.policy.revision },
      });
      await refresh();
      setMessage("حُفظت صلاحيات تعديل الخيار.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذر حفظ التفويض.");
    } finally {
      setBusy(false);
    }
  };
  const noEmployee = option.scope === "employee" && !selectedEmployeeId;
  return (
    <div className="control-option">
      <div className="control-option-main">
        <div>
          <strong>{option.label}</strong>
          <small className="control-option-help">القيمة الافتراضية: {option.type === "boolean"
            ? (option.defaultValue ? "مفعّل" : "معطّل")
            : `${option.defaultValue} ساعة`}</small>
        </div>
        <div className="control-option-input">
          {option.type === "boolean" ? (
            <label className="control-toggle">
              <input type="checkbox" checked={value === true}
                onChange={(event) => setValue(event.target.checked)}
                disabled={!option.canEdit || busy || noEmployee}
                aria-label={option.label} />
              <span>{value ? "إظهار / سماح" : "إخفاء / منع"}</span>
            </label>
          ) : (
            <Field label="عدد الساعات" type="number"
              min={option.min ?? 0} max={option.max ?? 72} step={1}
              value={String(value)} onChange={(event) => setValue(Number(event.target.value))}
              disabled={!option.canEdit || busy || noEmployee} />
          )}
          <Button size="compact" disabled={!option.canEdit || busy || noEmployee ||
            value === option.value || (option.type === "hours" && (
              !Number.isSafeInteger(value) || Number(value) < (option.min ?? 0) ||
              Number(value) > (option.max ?? 72)))}
            onClick={() => void save()}>حفظ</Button>
          <Button size="compact" variant="ghost"
            disabled={!option.canEdit || busy || noEmployee || option.revision === null}
            onClick={() => void reset()}>افتراضي</Button>
        </div>
      </div>
      {!option.integrated && <small className="control-option-help">
        إعداد محفوظ؛ ربط تأثيره بالوظيفة سيتم في دفعة مستقلة.
      </small>}
      {owner && option.policy && (
        <details className="control-delegation">
          <summary>من يستطيع تعديل هذا الخيار؟</summary>
          <label className="control-toggle">
            <input type="checkbox" checked={accountantAllowed} disabled={busy}
              onChange={(event) => setAccountantAllowed(event.target.checked)} />
            المحاسب (دور المحاسب الفعال بالشركة)
          </label>
          <div className="control-editors">
            {employees.map((employee) => (
              <label className="control-toggle" key={employee.id}>
                <input type="checkbox" disabled={busy}
                  checked={delegated.includes(employee.id)}
                  onChange={(event) => setDelegated(previous => event.target.checked
                    ? [...previous, employee.id]
                    : previous.filter(id => id !== employee.id))} />
                {employee.name}
              </label>
            ))}
          </div>
          <Button variant="secondary" size="compact" disabled={busy ||
            (accountantAllowed === option.policy.accountantAllowed &&
              delegated.length === option.policy.employeeIds.length &&
              delegated.every(id => option.policy!.employeeIds.includes(id)))}
            onClick={() => void savePolicy()}>حفظ التفويض</Button>
        </details>
      )}
      {message && <Notice tone="success">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
export function ControlPage({ context }: { context: CompanyContext }) {
  const { user } = useSession();
  const companyId = context.company.id;
  const [scope, setScope] = useState<"company" | "employee">("company");
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<number | null>(context.employee?.id ?? null);
  const [search, setSearch] = useState("");
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["control", user?.id, companyId, selectedEmployeeId],
    queryFn: () => api<Response>(`/companies/${companyId}/control${selectedEmployeeId ? `?employeeId=${selectedEmployeeId}` : ""}`),
    enabled: !!user,
  });
  const refresh = async () => {
    await client.invalidateQueries({queryKey: ["control", user?.id, companyId]});
  };
  const data = query.data;
  const options = (data?.options ?? []).filter(option =>
    option.scope === scope &&
    (`${option.label} ${option.category} ${option.key}`).toLocaleLowerCase("ar")
      .includes(search.toLocaleLowerCase("ar")));
  const categories = [...new Set(options.map(option => option.category))];
  return (
    <div className="stack">
      <PageHeader title="الكنترول" description="مركز التحكم بخيارات الشركة والموظف، مع تفويض تعديل كل خيار من المالك." />
      <Notice tone="warning">هذه الخيارات مرتبطة بوظائفها. يطبَّق ضبط الانصراف التلقائي على الجلسات الجديدة، ولا يتغير توقيت جلسات الحضور السابقة. ويتطلب الخروج عند السكون بقاء الموقع مفتوحًا.</Notice>
      <Card>
        <div className="control-toolbar">
          <div className="control-tabs" role="group" aria-label="نوع الكنترول">
            <Button variant={scope === "company" ? "primary" : "secondary"}
              onClick={() => setScope("company")}>كنترول الشركة</Button>
            <Button variant={scope === "employee" ? "primary" : "secondary"}
              onClick={() => setScope("employee")}>كنترول الموظف</Button>
            <Button variant="ghost" disabled title="تفعّل إعدادات المستخدم في مرحلة لاحقة">كنترول المستخدم (لاحقًا)</Button>
          </div>
          <Field label="البحث عن خيار" value={search}
            onChange={(event) => setSearch(event.target.value)} />
          {scope === "employee" && data?.owner && (
            <Select label="الموظف" value={selectedEmployeeId ?? ""}
              onChange={(event) => setSelectedEmployeeId(event.target.value ? Number(event.target.value) : null)}>
              <option value="">اختر موظفًا</option>
              {data.employees.map(employee => (
                <option value={employee.id} key={employee.id}>{employee.name}</option>
              ))}
            </Select>
          )}
        </div>
      </Card>
      {query.isLoading && <Notice>جارٍ تحميل خيارات الكنترول…</Notice>}
      {query.error && <Notice tone="error">{query.error.message}</Notice>}
      {scope === "employee" && data && !data.employeeId && (
        <Notice>اختر الموظف الذي تريد تعديل إعداداته.</Notice>
      )}
      {categories.map(category => (
        <Card key={category} title={category}>
          <div className="control-options">
            {options.filter(option => option.category === category).map(option => (
              <ControlRow key={`${option.key}:${data?.employeeId ?? "company"}`}
                option={option} companyId={companyId} owner={!!data?.owner}
                employees={data?.employees ?? []} selectedEmployeeId={data?.employeeId ?? null}
                refresh={refresh} />
            ))}
          </div>
        </Card>
      ))}
      {!query.isLoading && data && options.length === 0 &&
        <Notice>لا توجد خيارات مطابقة للبحث.</Notice>}
    </div>
  );
}
