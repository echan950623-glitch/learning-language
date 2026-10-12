/** Fetch complete result sets with a stable unique order and fail closed on errors. */
export async function fetchAllRows<T>(
  query: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown; status?: number }>,
  pageSize = 500,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const result = await query(from, from + pageSize - 1);
    if (result.error) throw result.error;
    const page = (result.data ?? []) as T[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}
