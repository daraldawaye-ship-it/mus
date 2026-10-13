import type { PoolClient } from "pg";
import { HttpError } from "../errors.ts";

/**
 * Phone is a login lookup, not an SMS verified assertion.
 * Preserve legacy email-only users; do not silently resolve legacy duplicate
 * phone numbers to any particular account.
 */
export async function assertPhoneAvailable(
  client: PoolClient,
  phone: string,
  exceptId: number | null = null,
): Promise<void> {
  if (!phone) return;
  const occupied = await client.query(
    "SELECT 1 FROM users WHERE phone=$1 AND id IS DISTINCT FROM $2 LIMIT 1",
    [phone, exceptId],
  );
  if (occupied.rows.length)
    throw new HttpError(
      409, "phone_in_use", "رقم الهاتف مستخدم في حساب آخر. راجع البيانات أو استخدم حسابك الحالي",
    );
}
