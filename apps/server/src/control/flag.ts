/** Normalize a candidate before dedup / hash / verify / submit. */
export function normalizeFlagValue(value: string): string {
  return String(value ?? "").trim();
}
