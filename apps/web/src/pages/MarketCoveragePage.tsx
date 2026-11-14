import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { marketTypes, type MarketKind } from "../../../../packages/contracts/src/medicine-market";
import { api, useSession } from "../api";
import { Button, Card, Notice, PageHeader } from "../ui";

type Coverage = { total: number; fields: { key: string; label: string; filled: number }[] };
const format = new Intl.NumberFormat("en-US");

const cellStyle = { border: "1px solid #748394", padding: "3px 8px", textAlign: "center" } as const;

export default function MarketCoveragePage() {
  const { user } = useSession();
  const [kind, setKind] = useState<MarketKind>("medicine");
  const query = useQuery({
    queryKey: ["medicine-market", user?.id, "coverage", kind],
    queryFn: ({signal}) => api<Coverage>("/medicine-market/owner/card-coverage?kind=" + kind, {signal}),
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
          <thead><tr><th scope="col" style={cellStyle}>الخيار</th><th scope="col" style={cellStyle}>مرتبط أو معبّأ</th><th scope="col" style={cellStyle}>فارغ</th></tr></thead>
          <tbody>{query.data.fields.map(field => <tr key={field.key}>
            <th scope="row" style={{...cellStyle, textAlign:"start"}}>{field.label}</th>
            <td style={cellStyle}>{format.format(field.filled)}</td>
            <td style={cellStyle}>{format.format(query.data.total - field.filled)}</td>
          </tr>)}</tbody>
        </table>
      </> : <Notice>جارٍ حساب أعداد الكروت…</Notice>}
    </Card>
  </section>;
}
