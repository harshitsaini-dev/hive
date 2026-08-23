/**
 * Runs an async mapper over a list, a few at a time.
 *
 * Gmail meters per-user requests (roughly 250 quota units a second, and a
 * message metadata fetch costs 5). Firing a whole page of 500 at once with
 * `Promise.all` is the fastest way to collect 429s rather than messages, and
 * the retries then make it slower than never having parallelised at all.
 *
 * Results come back in input order regardless of completion order, because
 * the caller is building a date-sorted list and silently reordering it would
 * be a maddening bug to find.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []

  const results = new Array<R>(items.length)
  let next = 0

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      // Each worker pulls the next index rather than taking a fixed slice, so
      // one slow item does not leave other workers idle.
      while (next < items.length) {
        const index = next++
        results[index] = await mapper(items[index] as T, index)
      }
    },
  )

  await Promise.all(workers)
  return results
}
