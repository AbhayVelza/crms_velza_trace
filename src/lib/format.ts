// Small text helpers shared by screens (no business rules).

/** "1 retailer", "3 retailers", "0 lots". `plural` defaults to singular + "s". */
export function countLabel(n: number, singular: string, plural = `${singular}s`): string {
  return `${n.toLocaleString("en-IN")} ${n === 1 ? singular : plural}`;
}

/** "Lot 00006" for one lot, "Lots 00004–00006" for a range. */
export function lotRangeLabel(first: string, last: string): string {
  return first === last ? `Lot ${first}` : `Lots ${first}–${last}`;
}
