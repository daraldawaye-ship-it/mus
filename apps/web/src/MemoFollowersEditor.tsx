import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  type MemoFollower,
  type MemoFollowerInput,
  type MemoFollowerRole,
  type MemoRecipient,
} from "../../../packages/contracts/src/index";
import { api, useSession } from "./api";
import { ServerLookup } from "./phase2";
import { Button, Select, Notice } from "./ui";

type Level = "view" | "comment";
export function MemoFollowersEditor({
  companyId, value, onChange, disabled = false, known = [],
}: {
  companyId: number;
  value: MemoFollowerInput[];
  onChange: (followers: MemoFollowerInput[]) => void;
  disabled?: boolean;
  known?: MemoFollower[];
}) {
  const { user } = useSession();
  const base = `/companies/${companyId}`;
  const [employee, setEmployee] = useState<MemoRecipient | null>(null);
  const [roleId, setRoleId] = useState("");
  const [level, setLevel] = useState<Level>("view");
  const [names, setNames] = useState<Record<string, string>>({});
  const roles = useQuery({
    queryKey: ["memo-follower-roles", user?.id, companyId],
    queryFn: ({ signal }) =>
      api<{ roles: MemoFollowerRole[] }>(`${base}/memos/roles`, { signal }),
    enabled: !!user,
  });
  function key(item: MemoFollowerInput) {
    return item.kind === "employee" ? `employee:${item.employeeId}` : `role:${item.roleId}`;
  }
  function add(item: MemoFollowerInput, name: string) {
    const identity = key(item);
    if (value.some((entry) => key(entry) === identity)) return;
    setNames((before) => ({ ...before, [identity]: name }));
    onChange([...value, item]);
    setEmployee(null);
    setRoleId("");
  }
  function label(item: MemoFollowerInput) {
    const identity = key(item);
    const previous = known.find((f) =>
      f.kind === item.kind && (f.kind === "employee" ? f.employeeId ===
        (item.kind === "employee" ? item.employeeId : null) : f.roleId ===
        (item.kind === "role" ? item.roleId : null)),
    );
    return names[identity] ?? previous?.name ??
      (item.kind === "role" ? roles.data?.roles.find((r) => r.id === item.roleId)?.name : undefined) ??
      (item.kind === "employee" ? `موظف #${item.employeeId}` : `دور #${item.roleId}`);
  }
  return (
    <div className="form-stack" aria-label="المتابعون وصلاحياتهم">
      <p className="muted">المتابعة للقراءة أو التعليق فقط، ولا تنقل مسؤولية التنفيذ أو حق الاعتماد.</p>
      {value.length ? (
        <div className="form-stack">
          {value.map((item, index) => (
            <div className="memo-action-buttons" key={key(item)}>
              <span>{item.kind === "role" ? "الدور: " : "الموظف: "}{label(item)}</span>
              <Select label="مستوى المتابعة" value={item.accessLevel} disabled={disabled}
                onChange={(event) => onChange(value.map((f,i) => i===index
                  ? { ...f, accessLevel: event.target.value as Level } : f))}>
                <option value="view">اطلاع فقط</option>
                <option value="comment">اطلاع وتعليق</option>
              </Select>
              {!disabled && <Button variant="secondary" onClick={() =>
                onChange(value.filter((_, i) => i !== index))}>إزالة</Button>}
            </div>
          ))}
        </div>
      ) : <p className="muted">لا يوجد متابعون إضافيون.</p>}
      {!disabled && (
        <>
          <Select label="صلاحية المتابع الجديد" value={level}
            onChange={(event) => setLevel(event.target.value as Level)}>
            <option value="view">اطلاع فقط</option>
            <option value="comment">اطلاع وتعليق</option>
          </Select>
          <ServerLookup<MemoRecipient>
            companyId={companyId}
            resource={`${base}/memos/recipients`}
            label="اختيار موظف متابع"
            value={employee}
            onChange={setEmployee}
            display={(item) => item.name}
            emptyLabel="ابحث عن موظف فعال"
          />
          <Button variant="secondary" disabled={!employee || value.length >= 100}
            onClick={() => employee && add({kind:"employee",employeeId:employee.id,accessLevel:level},employee.name)}>
            إضافة الموظف متابعًا
          </Button>
          <Select label="أو اختر دورًا معتمدًا في الشركة" value={roleId}
            onChange={(event) => setRoleId(event.target.value)}>
            <option value="">اختر الدور</option>
            {(roles.data?.roles ?? []).map((role) =>
              <option key={role.id} value={role.id}>{role.name}</option>)}
          </Select>
          <Button variant="secondary" disabled={!roleId || value.length >= 100}
            onClick={() => {
              const selected = roles.data?.roles.find((role) => role.id === Number(roleId));
              if (selected) add({kind:"role",roleId:selected.id,accessLevel:level},selected.name);
            }}>إضافة الدور متابعًا</Button>
          {roles.error && <Notice tone="warning">تعذر جلب أدوار الشركة؛ يمكنك إضافة الموظفين مباشرة.</Notice>}
        </>
      )}
    </div>
  );
}
