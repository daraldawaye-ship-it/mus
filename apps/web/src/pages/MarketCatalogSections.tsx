import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, RefreshCw } from "lucide-react";
import { api, useSession } from "../api";
import { Button, Notice } from "../ui";
import { errorMessage } from "../phase2";
import { isMarketAdministrativeKind } from "../../../../packages/contracts/src/medicine-market";
import type {
  MarketCard, MarketDetail, MarketKind, MarketMeta, MarketReferenceEntry,
} from "../../../../packages/contracts/src/medicine-market";
import "./MarketCatalogSections.css";
import { MarketCardIcon, hasMarketCardImage } from "../MarketCardIcon";

type MarketType = MarketMeta["types"][number];
type CardPage = { items: MarketCard[]; total: number; page: number; pageSize: number };
const ROOT = "/medicine-market";
const SECTION_SIZE = 10;
const SECTION_ORDER: MarketKind[] = [
  "medicine", "composition", "scientific-name", "agent", "wholesaler",
  "manufacturer", "pharmacy", "prescription", "doctor", "hospital", "clinic", "college",
];
const hasValue = (value: unknown) => value !== null && value !== undefined && value !== "" &&
  (!Array.isArray(value) || value.length > 0);

function CompactRelation({ id }: { id: number }) {
  const { user } = useSession();
  // Share the existing relation cache; changing this layout never changes market records.
  const result = useQuery({
    queryKey: ["medicine-market", user?.id, "relation", id],
    queryFn: ({ signal }) => api<MarketDetail>(`${ROOT}/cards/${id}`, { signal }),
    enabled: id > 0,
    staleTime: 60_000,
  });
  return <>{result.data?.card.name ?? `كرت #${id}`}</>;
}

export function MarketCompactCard({ item, type, references, onOpen }: {
  item: MarketCard;
  type?: MarketType;
  references: MarketReferenceEntry[];
  onOpen: (id: number) => void;
}) {
  const publicFields = type?.fields.filter(field => field.visibility === "public") ?? [];
  const priorities = item.kind === "medicine"
    ? ["compositionId", "agentId", "englishName", "dosageFormId"]
    : item.kind === "composition" ? ["dosageFormId", "ingredients"]
    : item.kind === "scientific-name" ? ["englishName", "details"]
    : item.kind === "prescription" ? ["prescriptionLines"]
    : ["address", "phone", "landlinePhone", "cityCode", "agentId", "country", "countryCode", "specialty"];
  const preview = priorities.map(key => publicFields.find(field => field.key === key))
    .filter((field): field is MarketType["fields"][number] => !!field && hasValue(item.data[field.key]))
    .slice(0, 2);
  const priceField = item.kind === "medicine"
    ? ["defaultSalePrice", "purchasePrice"].find(key =>
        publicFields.some(field => field.key === key) && hasValue(item.data[key]))
    : undefined;
  const currency = publicFields.some(field => field.key === "currency") &&
    typeof item.data.currency === "string" ? item.data.currency : "";
  const status = item.archived ? "مؤرشف" : item.status === "pending" ? "بانتظار المصادقة" : "";
  return <button type="button" className={`market-compact-card${hasMarketCardImage(item)?" market-compact-card-with-photo":""}`}
    aria-label={`فتح الكرت: ${item.name}${status ? ` — ${status}` : ""}`}
    onClick={() => onOpen(item.id)}>
    <MarketCardIcon card={item} />
    <span className="market-compact-card-main">
      <strong className="market-compact-card-name" dir="auto" title={item.name}>{item.name}</strong>
      {status && <small className="market-compact-card-status">{status}</small>}
      {priceField ? <span className="market-compact-card-price"
        title={priceField === "defaultSalePrice" ? "سعر البيع الافتراضي" : "سعر الشراء من الوكيل"}>
        <small>{priceField === "defaultSalePrice" ? "بيع" : "شراء"}</small>{" "}
        <bdi>{String(item.data[priceField])}{currency ? ` ${currency}` : ""}</bdi>
      </span> : <small className="market-compact-card-id">#{item.id}</small>}
    </span>
    <span className="market-compact-card-secondary">
      <span className="market-compact-card-summary">
        {preview.map(field => {
          const value = item.data[field.key];
          const plain = field.type === "reference"
            ? references.find(entry => entry.code === value)?.name ?? String(value)
            : field.type === "ingredients" && Array.isArray(value) ? `${value.length} مكونات`
            : field.type === "prescription-lines" && Array.isArray(value) ? `${value.length} أسطر`
            : String(value);
          return <span key={field.key} className="market-compact-card-field" dir="auto"
            title={field.type === "relation" ? field.label : `${field.label}: ${plain}`}>
            {field.type === "relation" && typeof value === "number"
              ? <CompactRelation id={value} /> : plain}
          </span>;
        })}
        {preview.length === 0 && <span className="market-compact-card-field">عرض تفاصيل الكرت</span>}
      </span>
      <ChevronLeft size={15} aria-hidden="true" />
    </span>
  </button>;
}

function MarketSection({ type, q, sort, archived, references, onOpen, onBrowse }: {
  type: MarketType;
  q: string;
  sort: "updated" | "created";
  archived: boolean;
  references: MarketReferenceEntry[];
  onOpen: (id: number) => void;
  onBrowse: (kind: MarketKind) => void;
}) {
  const { user } = useSession();
  const section = useRef<HTMLElement>(null);
  const [visited, setVisited] = useState(type.key === "medicine");
  const [nearViewport, setNearViewport] = useState(type.key === "medicine");
  useEffect(() => {
    if (!section.current || typeof IntersectionObserver === "undefined") {
      setVisited(true); setNearViewport(true); return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      const near = !!entry?.isIntersecting;
      setNearViewport(near);
      if (near) setVisited(true);
    }, { rootMargin: "280px" });
    observer.observe(section.current);
    return () => observer.disconnect();
  }, []);
  const list = useQuery({
    queryKey: ["medicine-market", user?.id, "cards", "section", type.key, q, archived, sort],
    queryFn: ({ signal }) => api<CardPage>(`${ROOT}/cards?${new URLSearchParams({
      kind: type.key, q, sort, archived: String(archived), page: "1", pageSize: String(SECTION_SIZE),
    })}`, { signal }),
    enabled: visited || !!q,
    staleTime: 20_000,
    refetchInterval: nearViewport ? 20_000 : false,
    refetchIntervalInBackground: false,
  });
  // Search remains grouped by kind; no unrelated cards appear in a section.
  if (q && list.isSuccess && list.data.total === 0) return null;
  return <section ref={section} className="market-catalog-section"
    aria-labelledby={`market-section-${type.key}`} data-market-section={type.key}>
    <header className="market-catalog-section-heading">
      <h2 id={`market-section-${type.key}`}>{type.label}</h2>
      {list.data && <small>{list.data.total} كرت</small>}
      <Button variant="ghost" size="compact" onClick={() => onBrowse(type.key)}>
        عرض الكل <ChevronLeft size={14} />
      </Button>
    </header>
    {list.error ? <div className="market-section-error">
      <Notice tone="error">{errorMessage(list.error)}</Notice>
      <Button variant="secondary" size="compact" onClick={() => void list.refetch()}
        disabled={list.isFetching}><RefreshCw size={14} /> إعادة المحاولة</Button>
    </div> : list.data ? <>
      <div className="market-compact-list">
        {list.data.items.map(item => <MarketCompactCard key={item.id} item={item}
          type={type} references={references} onOpen={onOpen} />)}
      </div>
      {list.data.items.length === 0 && <p className="market-section-empty">لا توجد كروت في هذا القسم بعد.</p>}
      <footer className="market-catalog-section-footer">
        <small>{list.data.items.length} من {list.data.total}</small>
        <Button variant="secondary" size="compact" onClick={() => onBrowse(type.key)}>
          {list.data.total > SECTION_SIZE ? "عرض المزيد" : "الدخول إلى القسم"}
          <ChevronLeft size={14} />
        </Button>
      </footer>
    </> : <div className="market-section-placeholder" role="status">
      {visited || q ? "جارٍ تحميل الكروت…" : "يُحمّل القسم عند الوصول إليه…"}
    </div>}
  </section>;
}

export function MarketCatalogSections({ types, q, sort, archived, references, onOpen, onBrowse }: {
  types: MarketType[];
  q: string;
  sort: "updated" | "created";
  archived: boolean;
  references: MarketReferenceEntry[];
  onOpen: (id: number) => void;
  onBrowse: (kind: MarketKind) => void;
}) {
  const ordered = types.filter(type => !isMarketAdministrativeKind(type.key))
    .sort((a, b) => {
      const rank = (kind: MarketKind) => {
        const index = SECTION_ORDER.indexOf(kind);
        return index < 0 ? SECTION_ORDER.length : index;
      };
      return rank(a.key) - rank(b.key);
    });
  return <div className="market-catalog-sections">
    <p className="market-catalog-section-note">
      {q ? "نتائج البحث حسب القسم — حتى 10 كروت لكل قسم" :
        sort === "created" ? "آخر 10 كروت مضافة في كل قسم" : "آخر 10 كروت تحديثًا أو إضافةً في كل قسم"}
    </p>
    {ordered.length === 0 && <Notice>جارٍ تحميل أقسام السوق…</Notice>}
    {ordered.map(type => <MarketSection key={type.key} type={type} q={q} sort={sort}
      archived={archived} references={references} onOpen={onOpen} onBrowse={onBrowse} />)}
  </div>;
}
