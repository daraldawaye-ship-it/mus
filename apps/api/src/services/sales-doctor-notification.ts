/** An archived referral stays archived: each new invoice produces one review event. */
export function archivedDoctorSaleNotice(
  companyId: number,
  doctor: { id: number; name: string },
  invoiceId: number,
  invoiceNumber: string,
  creatorName?: string,
) {
  return {
    code: "SALES_ARCHIVED_DOCTOR_USED",
    companyId,
    // Keep each separate invoice visible even while an earlier notice is pending.
    subjectKey: `archived-doctor:${doctor.id}:invoice:${invoiceId}`,
    eventKey: `sales:archived-doctor:${invoiceId}`,
    title: "استخدام طبيب أو جهة مؤرشفة",
    message: `اُستخدم الاسم المؤرشف «${doctor.name}» في فاتورة المبيعات رقم ${invoiceNumber}. لم يُنشأ كرت مكرر ولم تُغيّر حالة الأرشفة. راجع الكرت.${creatorName ? ` منشئ الفاتورة: ${creatorName}.` : ''}`,
    href: `/companies/${companyId}/doctors?focus=${doctor.id}`,
  };
}
