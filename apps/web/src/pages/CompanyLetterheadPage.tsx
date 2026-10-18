import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { CompanyContext } from "../../../../packages/contracts/src/index";
import { api, useScopeGuard, useSession } from "../api";
import { errorMessage } from "../phase2";
import { useCompanyLetterhead } from "../CompanyPrintHeader";
import { ImageUpload } from "../ImageUpload";
import { Button, Card, Notice, PageHeader } from "../ui";

/**
 * Own company page: deliberately independent of company.edit. Viewing uses
 * company membership, editing uses the owner check in the image/API endpoints.
 */
export function CompanyLetterheadPage({context}:{context:CompanyContext}) {
  const company = context.company;
  const {user} = useSession();
  const queryClient = useQueryClient();
  const guard = useScopeGuard(`company:${company.id}:letterhead`);
  const letterhead = useCompanyLetterhead(company.id);
  const isOwner = !!user && (user.owner || company.createdBy === user.id);
  const [pendingMediaId, setPendingMediaId] = useState<string | null | undefined>();
  const [pendingImageUrl, setPendingImageUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const imageUrl = pendingMediaId === undefined
    ? letterhead.data?.imageUrl
    : pendingMediaId === null ? null : pendingImageUrl;

  async function save() {
    if (!isOwner || saving || pendingMediaId === undefined) return;
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      await api(`/companies/${company.id}/letterhead`, {
        method:"PUT",body:{mediaId:pendingMediaId},signal:guard.signal,
      });
      if (!guard.isCurrent()) return;
      await queryClient.invalidateQueries({
        queryKey:["company-letterhead",user?.id,company.id],
      });
      if (!guard.isCurrent()) return;
      setPendingMediaId(undefined);
      setPendingImageUrl(null);
      setSuccess("حُفظت الترويسة؛ ستظهر أعلى الفواتير والسندات والتقارير عند الطباعة.");
    } catch (reason) {
      if (guard.isCurrent()) setError(errorMessage(reason));
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }

  return (
    <>
      <PageHeader title="ترويسة الشركة للطباعة"
        description={`الترويسة المعتمدة لمطبوعات ${company.name}، مستقلة عن بقية الشركات.`} />
      <Card title="صورة الترويسة">
        <p className="muted">
          تُطبع الصورة بعرض الصفحة دون تشويه نسبها، فوق بيانات الفاتورة أو السند أو التقرير.
        </p>
        {letterhead.isLoading && <Notice>جارٍ تحميل ترويسة الشركة…</Notice>}
        {letterhead.error && <Notice tone="error">{errorMessage(letterhead.error)}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        {success && <Notice tone="success">{success}</Notice>}
        {!isOwner && (
          <Notice>يمكنك مشاهدة الترويسة الحالية؛ تغييرها متاح لمالك الشركة فقط.</Notice>
        )}
        {isOwner ? (
          <>
            <ImageUpload
              purpose="letterhead"
              companyId={company.id}
              preview={imageUrl}
              disabled={saving}
              onUploaded={(asset) => {
                setPendingMediaId(asset.id);
                setPendingImageUrl(asset.fullUrl);
                setSuccess("");
                setError("");
              }}
              onClear={() => {
                setPendingMediaId(null);
                setPendingImageUrl(null);
                setSuccess("");
              }}
            />
            <div className="form-actions">
              <Button type="button" onClick={() => void save()}
                disabled={saving || letterhead.isLoading || pendingMediaId === undefined}>
                {saving ? "جارٍ حفظ الترويسة…" : "حفظ الترويسة"}
              </Button>
            </div>
          </>
        ) : imageUrl ? (
          <img className="company-letterhead-settings-preview"
            src={imageUrl} alt={`الترويسة المعتمدة لشركة ${company.name}`} />
        ) : !letterhead.isLoading && !letterhead.error ? (
          <Notice>لم تُحدد ترويسة لهذه الشركة بعد.</Notice>
        ) : null}
      </Card>
    </>
  );
}
