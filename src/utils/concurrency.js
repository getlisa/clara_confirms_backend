/**
 * Run `fn` over `items` with at most `limit` in flight at once, preserving
 * input order in the results array regardless of finish order. A worker-pool
 * rather than chunking into batches, so a slow item never stalls the whole
 * batch behind it.
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

module.exports = { mapWithConcurrency };
