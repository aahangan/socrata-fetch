/** Quotes a value as a SoQL string literal, doubling embedded single quotes. */
export const soqlString = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** Quotes values for a SoQL `in (...)` list: `quoteList(["a", "b"])` → `'a','b'`. */
export const quoteList = (values: readonly string[]): string => values.map(soqlString).join(",");

/** Columns from `required` that appear in none of the rows: a sign the dataset's schema changed. */
export function missingColumns(rows: readonly Record<string, unknown>[], required: readonly string[]): string[] {
  if (!rows.length) return [];
  return required.filter((c) => !rows.some((r) => c in r));
}
