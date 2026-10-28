/** Sale-side eligibility for the editable "إضافة طبيب أو جهة" reward.
 * A newly created unclassified card qualifies immediately; an already saved
 * entity or unclassified card does not. Never infer eligibility from a name.
 */
export function eligibleDoctorReferral(
  kind: "doctor" | "nurse" | "entity" | null,
  newlyCreated: boolean,
): boolean {
  return newlyCreated || kind === "doctor" || kind === "nurse";
}

/** A customer reward is based on whether the number existed at this sale,
 * not on whether a name was typed or the number had been used in past invoices.
 */
export function customerRegistrationReward(
  customerNumber: string,
  newlyCreated: boolean,
): "new" | "existing" | null {
  if (!customerNumber) return null;
  return newlyCreated ? "new" : "existing";
}
