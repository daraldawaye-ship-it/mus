import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { marketTypes, type MarketKind } from "../../../../packages/contracts/src/medicine-market";
import { api, useSession } from "../api";
import { Button, Card, Notice, PageHeader } from "../ui";

type Coverage = { total: number; fields: { key: string; label: string; filled: number }[] };
const format = new Intl.NumberFormat("en-US");

const cellStyle = { border: "1px solid #748394", padding: "3px 8px", textAlign: "center" } as const;

type Column = "label" | "filled" | "empty";
const headings: [Column, string][] = [["label", "الخيار"], ["filled", "مرتبط أو معبّأ"], ["empty", "فارغ"]];
const collator = new Intl.Collator("ar", {numeric: true});

export default function MarketCoveragePage() {
  const { user } = useSession();
  const [kind, setKind] = useState<MarketKind>("medicine");
  const [sort, setSort] = useState<{column: Column; ascending: boolean} | null>(null);
  function sortBy(column: Column) {
    setSort(previous => ({
      column, ascending: previous?.column === column ? !previous.ascending : column === "label",
    }));
  }
  const query = useQuery({
    queryKey: ["medicine-market", user?.id, "coverage", kind],
    queryFn: ({signal}) => api<Coverage>("/medicine-market/owner/card-coverage?kind=" + kind, {signal}),
  });
  const rows = [...(query.data?.fields ?? [])];
  if (sort) rows.sort((a, b) => {
    const result = sort.column === "label" ? collator.compare(a.label, b.label)
      : sort.column === "filled" ? a.filled - b.filled : b.filled - a.filled;
    return sort.ascending ? result : -result;
  });
  return <section dir="rtl">
    <PageHeader title="اكتمال كروت السوق" actions={<Link to="/medicine-market">العودة إلى السوق</Link>} />
    <Card>
      <div className="page-actions">
        <label>نوع الكرت <select value={kind} onChange={event => setKind(event.target.value as MarketKind)}>
          {marketTypes.map(type => <option key={type.key} value={type.key}>{type.label}</option>)}
        </select></label>
        <Button size="compact" variant="secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>تحديث</Button>
      </div>
      {query.isError ? <Notice tone="error">تعذر تحميل الإحصاءات. اضغط تحديث للمحاولة مجددًا.</Notice> : query.data ? <>
        <p>إجمالي الكروت المنشورة غير المؤرشفة <strong>{format.format(query.data.total)}</strong></p>
        <table style={{width:"100%", borderCollapse:"collapse"}}>
          <thead><tr>{headings.map(([column, title]) => <th key={column} scope="col" style={cellStyle}
            aria-sort={sort?.column === column ? (sort.ascending ? "ascending" : "descending") : undefined}>
            <button type="button" onClick={() => sortBy(column)} style={{width:"100%", background:"transparent", border:0, color:"inherit", font:"inherit", cursor:"pointer"}}>
              {title} <span aria-hidden="true">{sort?.column === column ? (sort.ascending ? "↑" : "↓") : "↕"}</span>
            </button>
          </th>)}</tr></thead>
          <tbody>{rows.map(field => <tr key={field.key}>
            <th scope="row" style={{...cellStyle, textAlign:"start"}}>{field.label}</th>
            <td style={cellStyle}>{format.format(field.filled)}</td>
            <td style={cellStyle}>{format.format(query.data.total - field.filled)}</td>
          </tr>)}</tbody>
        </table>
      </> : <Notice>جارٍ حساب أعداد الكروت…</Notice>}
    </Card>
  </section>;
}
