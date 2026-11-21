import { useQuery } from "@tanstack/react-query";
import { MAX_ID, userKindLabels, type User } from "../../../packages/contracts/src/index";
import { api, useSession } from "./api";
import { Notice } from "./ui";

type UserCard = Pick<User, "id" | "displayName" | "kind" | "category" | "archived" | "suspended" | "createdAt">;

const shortDate = new Intl.DateTimeFormat("ar-YE", {
  dateStyle: "medium", timeZone: "Asia/Aden", calendar: "gregory",
});

/** A global account card. The caller must pass a selected user ID, never an employee ID. */
export function DockUserCardBody({ userId, actorId }: { userId: number; actorId: number }) {
  const { user: actor, employeePreview } = useSession();
  const allowed = !!actor?.owner && actor.id === actorId && !employeePreview;
  const valid = Number.isSafeInteger(userId) && userId > 0 && userId <= MAX_ID;
  const result = useQuery({
    queryKey: ["dock-user-card", actorId, userId],
    enabled: allowed && valid,
    retry: false,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      const response = await api<{ user: UserCard }>(`/users/${userId}/dock-card`, { signal });
      if (response.user?.id !== userId) throw new Error("تعذر التحقق من الحساب المحدد.");
      const { id, displayName, kind, category, archived, suspended, createdAt } = response.user;
      return { id, displayName, kind, category, archived, suspended, createdAt };
    },
  });

  if (!allowed || !valid) return <Notice tone="warning">لا يمكن عرض الحساب المحدد.</Notice>;
  if (result.isError) return <Notice tone="error">تعذر تحميل كرت المستخدم.</Notice>;
  if (!result.data) return <Notice>جارٍ تحميل كرت المستخدم…</Notice>;

  const account = result.data;
  const created = new Date(account.createdAt);
  return <section aria-label="بيانات المستخدم العام">
    <dl className="details-list">
      <dt>الاسم</dt><dd>{account.displayName}</dd>
      <dt>رقم المستخدم</dt><dd><bdi>#{account.id}</bdi></dd>
      <dt>نوع الحساب</dt><dd>{userKindLabels[account.kind]}</dd>
      {account.category && <><dt>الفئة</dt><dd>{account.category}</dd></>}
      <dt>الحالة</dt><dd>{account.archived ? "مؤرشف" : account.suspended ? "موقوف" : "نشط"}</dd>
      {Number.isFinite(created.getTime()) && <><dt>تاريخ الإنشاء</dt><dd>{shortDate.format(created)}</dd></>}
    </dl>
  </section>;
}
