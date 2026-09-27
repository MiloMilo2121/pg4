/**
 * Run `fn` over `items` with at most `concurrency` calls in flight. Workers
 * pull the next index from a shared cursor, so there is no in-flight
 * bookkeeping to get wrong. Rejects with the first error `fn` throws (other
 * workers finish their current item); callers that must never abort wrap
 * `fn` in their own try/catch.
 */
export async function pool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`pool: concurrency must be a positive integer (got ${concurrency})`);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}
