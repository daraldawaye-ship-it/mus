import type { Item } from "../../../../packages/contracts/src/items.ts";

type UnitStructure = Pick<Item,
  "unit1Name" | "unit2Name" | "unit3Name" | "factor2" | "factor3" | "hasExpiry">;

/**
 * After stock movements exist, only activation/renaming of previously inactive
 * unit slots is allowed. Existing active unit names, their factors, the first
 * unit and expiry tracking are immutable so historical units are not rewritten.
 * The caller must separately verify ZERO stock in EVERY location/batch inside
 * the same locked item transaction before applying such an addition.
 */
export function addsOnlyPreviouslyInactiveUnits(
  before: UnitStructure, next: UnitStructure,
): boolean {
  if (before.unit1Name !== next.unit1Name || before.hasExpiry !== next.hasExpiry) return false;
  if (before.factor2 > 1 &&
      (before.factor2 !== next.factor2 || before.unit2Name !== next.unit2Name)) return false;
  if (before.factor3 > 1 &&
      (before.factor3 !== next.factor3 || before.unit3Name !== next.unit3Name)) return false;
  // A third unit depends on an active second unit. Never change an existing
  // third-unit conversion by activating its former parent retroactively.
  if (next.factor3 > 1 && next.factor2 <= 1) return false;
  if (before.factor3 > 1 && before.factor2 <= 1 && next.factor2 > 1) return false;
  // Inactive slot names can be entered first by the item card's field autosave.
  // A factor >1 is activated only with the required corresponding name.
  if (next.factor2 > 1 && !next.unit2Name.trim()) return false;
  if (next.factor3 > 1 && !next.unit3Name.trim()) return false;
  return true;
}
