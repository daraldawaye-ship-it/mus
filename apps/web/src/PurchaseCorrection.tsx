import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Invoice } from "../../../packages/contracts/src/index";
import { api, useSession } from "./api";
import { ServerLookup, errorMessage } from "./phase2";

type Choice = { id: number; code: string; name: string };
type Line = {
  key: string;
  item: Choice | null;
  unit: number;
  quantity: string;
  unitPrice: string;
  expiryDate: string;
};
type Impact = {
  documentDate: string;
  oldTotal: string;
  newTotal: string;
  difference: string;
  stock: { name: string; batch: string; quantity: string; cost: string }[];
  ledger: { name: string; code: string; delta: string }[];
};
type Entry = {
  original_id: number;
  reversal_id: number;
  replacement_id: number;
  actor_id: number;
  actor_name: string;
  corrected_at: string;
  reason: string;
  before_invoice: Invoice;
  after_invoice: Invoice;
  impact: Impact;
};
const label = (v: Choice) => v.code + " — " + v.name;
const localTime = (v: string) =>
  new Intl.DateTimeFormat("ar-YE", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "Asia/Aden",
  }).format(new Date(v));

function ImpactTable({ impact }: { impact: Impact }) {
  return (
    <section>
      <p>
        تاريخ الترحيل {impact.documentDate} · الصافي قبل {impact.oldTotal} وبعد{" "}
        {impact.newTotal} · الفرق {impact.difference}
      </p>
      <table>
        <caption>فرق المخزون بالوحدة الصغرى والتكلفة بالعملة الأساسية</caption>
        <thead>
          <tr>
            <th>الصنف</th>
            <th>الدفعة</th>
            <th>الكمية</th>
            <th>التكلفة</th>
          </tr>
        </thead>
        <tbody>
          {impact.stock.map((r, i) => (
            <tr key={i}>
              <td>{r.name}</td>
              <td>{r.batch}</td>
              <td>{r.quantity}</td>
              <td>{r.cost}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table>
        <caption>
          صافي أثر القيود بالعملة الأساسية (الموجب مدين والسالب دائن)
        </caption>
        <tbody>
          {impact.ledger.map((r, i) => (
            <tr key={i}>
              <th>
                {r.code} — {r.name}
              </th>
              <td>{r.delta}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
function Snapshot({ v }: { v: Invoice }) {
  return (
    <section>
      <p>
        الفاتورة {v.number} · {v.documentDate} · المورد {v.supplierAccountName}{" "}
        · حساب السداد {v.counterpartyAccountName} · الخصم {v.discount} · الصافي{" "}
        {v.total} {v.currencyCode}
      </p>
      <ul>
        {v.lines.map((l) => (
          <li key={l.id}>
            {l.itemCode} — {l.itemName}، {l.quantity} {l.unitName} ×{" "}
            {l.unitPrice}، انتهاء {l.expiryDate || "—"}
          </li>
        ))}
      </ul>
    </section>
  );
}
export function PurchaseCorrection({
  invoice: v,
  canEdit,
}: {
  invoice: Invoice;
  canEdit: boolean;
}) {
  const base = `/companies/${v.companyId}`,
    path = base + "/invoices/" + v.id + "/purchase-correction";
  const { user } = useSession(),
    navigate = useNavigate(),
    cache = useQueryClient();
  const history = useQuery({
    queryKey: ["commerce", user?.id, path],
    queryFn: ({ signal }) => api<{ items: Entry[] }>(path + "s", { signal }),
  });
  const [editing, setEditing] = useState(false),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [key] = useState(() => crypto.randomUUID());
  const [account, setAccount] = useState<Choice | null>({
    id: v.counterpartyAccountId,
    code: v.counterpartyAccountCode,
    name: v.counterpartyAccountName,
  });
  const [supplier, setSupplier] = useState<Choice | null>(
    v.supplierAccountId
      ? {
          id: v.supplierAccountId,
          code: v.supplierAccountCode || "",
          name: v.supplierAccountName || "",
        }
      : null,
  );
  const [discount, setDiscount] = useState(v.discount);
  const [lines, setLines] = useState<Line[]>(() =>
    v.lines.map((l) => ({
      key: crypto.randomUUID(),
      item: { id: l.itemId, name: l.itemName, code: l.itemCode },
      unit: l.unit,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      expiryDate: l.expiryDate || "",
    })),
  );
  const [preview, setPreview] = useState<{
    impact: Impact;
    previewHash: string;
  } | null>(null);
  function update(i: number, change: Partial<Line>) {
    setLines(lines.map((l, index) => (index === i ? { ...l, ...change } : l)));
  }
  async function submit() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await api<{
        impact: Impact;
        previewHash: string;
        replacementId?: number;
      }>(path, {
        method: "POST",
        body: {
          reason,
          previewHash: preview?.previewHash,
          invoice: {
            idempotencyKey: key,
            kind: "purchase",
            documentDate: v.documentDate,
            branchId: v.branchId,
            locationId: v.locationId,
            currencyId: v.currencyId,
            counterpartyAccountId: account?.id,
            supplierAccountId: supplier?.id,
            supplierReceiptNumber: v.supplierReceiptNumber,
            description: v.description,
            discount,
            lines: lines.map((l) => ({
              itemId: l.item?.id,
              unit: l.unit,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              expiryDate: l.expiryDate || null,
            })),
          },
        },
      });
      if (response.replacementId) {
        await cache.invalidateQueries({ queryKey: ["commerce"] });
        navigate(base + "/invoices/" + response.replacementId);
      } else setPreview(response);
    } catch (e) {
      setError(errorMessage(e));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }
  const allowed =
    canEdit &&
    history.isSuccess &&
    !v.returning &&
    !v.mixed &&
    !history.data.items.some(
      (h) => h.original_id === v.id || h.reversal_id === v.id,
    );
  return (
    <section className="commerce-no-print">
      {history.isError && <p role="alert">{errorMessage(history.error)}</p>}
      {history.data?.items.map((h) => (
        <details key={h.original_id}>
          <summary>
            سجل تعديل الفاتورة {h.before_invoice.number} إلى{" "}
            {h.after_invoice.number} · {localTime(h.corrected_at)}
          </summary>
          <p>
            عدّلها {h.actor_name} (حساب {h.actor_id}) · السبب {h.reason}
          </p>
          <Link to={base + "/invoices/" + h.original_id}>الأصل</Link> ·{" "}
          <Link to={base + "/invoices/" + h.reversal_id}>مستند العكس</Link> ·{" "}
          <Link to={base + "/invoices/" + h.replacement_id}>التصحيح</Link>
          <h4>قبل التعديل</h4>
          <Snapshot v={h.before_invoice} />
          <h4>بعد التعديل</h4>
          <Snapshot v={h.after_invoice} />
          <ImpactTable impact={h.impact} />
        </details>
      ))}
      {allowed && !editing && (
        <button
          className="button button-secondary"
          onClick={() => setEditing(true)}
        >
          تعديل الفاتورة
        </button>
      )}
      {allowed && editing && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <fieldset disabled={busy || !!preview}>
            <legend>تعديل فاتورة مشتريات {v.number}</legend>
            <ServerLookup
              companyId={v.companyId}
              resource={base + "/commerce-options?type=accounts"}
              label="حساب السداد / الذمة"
              value={account}
              onChange={setAccount}
              display={label}
              singleInput
              required
            />
            <ServerLookup
              companyId={v.companyId}
              resource={base + "/commerce-options?type=accounts"}
              label="المورد"
              value={supplier}
              onChange={setSupplier}
              display={label}
              singleInput
              required
            />
            {lines.map((l, i) => (
              <fieldset key={l.key}>
                <legend>البند {i + 1}</legend>
                <ServerLookup
                  companyId={v.companyId}
                  resource={base + "/commerce-options?type=items"}
                  label="الصنف"
                  searchPlaceholder="ابحث باسم الصنف أو رمزه"
                  noResultsLabel="لا توجد أصناف مطابقة"
                  value={l.item}
                  onChange={(item) => update(i, { item })}
                  display={label}
                  singleInput
                  required
                />
                <label>
                  الوحدة{" "}
                  <select
                    value={l.unit}
                    onChange={(e) =>
                      update(i, { unit: Number(e.target.value) })
                    }
                  >
                    {[1, 2, 3].map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </label>
                <label>
                  الكمية{" "}
                  <input
                    required
                    inputMode="numeric"
                    value={l.quantity}
                    onChange={(e) => update(i, { quantity: e.target.value })}
                  />
                </label>
                <label>
                  سعر الوحدة{" "}
                  <input
                    required
                    inputMode="decimal"
                    value={l.unitPrice}
                    onChange={(e) => update(i, { unitPrice: e.target.value })}
                  />
                </label>
                <label>
                  الانتهاء{" "}
                  <input
                    type="date"
                    value={l.expiryDate}
                    onChange={(e) => update(i, { expiryDate: e.target.value })}
                  />
                </label>
                <button
                  type="button"
                  disabled={lines.length === 1}
                  onClick={() =>
                    setLines(lines.filter((row) => row.key !== l.key))
                  }
                >
                  حذف البند
                </button>
              </fieldset>
            ))}
            <button
              type="button"
              disabled={lines.length >= 100}
              onClick={() =>
                setLines([
                  ...lines,
                  {
                    key: crypto.randomUUID(),
                    item: null,
                    unit: 1,
                    quantity: "1",
                    unitPrice: "",
                    expiryDate: "",
                  },
                ])
              }
            >
              إضافة بند
            </button>
            <label>
              الخصم{" "}
              <input
                required
                value={discount}
                onChange={(e) => setDiscount(e.target.value)}
              />
            </label>
            <label>
              سبب التعديل{" "}
              <textarea
                required
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          </fieldset>
          {preview && <ImpactTable impact={preview.impact} />}
          {error && <p role="alert">{error}</p>}
          <button
            className="button button-primary"
            disabled={
              busy ||
              !reason.trim() ||
              !supplier ||
              !account ||
              lines.some((l) => !l.item)
            }
          >
            {preview ? "اعتماد التصحيح" : "معاينة الفروقات"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (preview) setPreview(null);
              else setEditing(false);
            }}
          >
            {preview ? "العودة للتعديل" : "إغلاق"}
          </button>
        </form>
      )}
    </section>
  );
}
