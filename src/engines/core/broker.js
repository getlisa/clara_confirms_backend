/**
 * In-process pub/sub keyed by runId. Each subscriber is a callback `(event) => void`.
 *
 * Lifetime: a subscriber is registered when an SSE client opens the stream and
 * removed when the client disconnects or the run finishes. We do NOT persist
 * the subscriber set anywhere — durability comes from `engine_runs.state_history`,
 * not from this broker. If the process restarts, clients reconnect and replay
 * from the DB.
 *
 * Multi-instance caveat: subscribers attached on instance A won't receive
 * events from a run executing on instance B. Acceptable for v1 since a run
 * typically starts and ends within a single Vercel function invocation; a
 * client that subscribes from a different instance will be served via DB
 * replay (and live-tail won't fire, but the snapshot will reflect terminal
 * state once the engine finishes).
 */

const subscribers = new Map(); // runId(string) → Set<fn>

function subscribe(runId, fn) {
  const key = String(runId);
  let set = subscribers.get(key);
  if (!set) {
    set = new Set();
    subscribers.set(key, set);
  }
  set.add(fn);
  return () => {
    const s = subscribers.get(key);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) subscribers.delete(key);
  };
}

function publish(runId, event) {
  const set = subscribers.get(String(runId));
  if (!set) return;
  for (const fn of set) {
    try { fn(event); } catch { /* subscriber threw — ignore, don't block others */ }
  }
}

function subscriberCount(runId) {
  const s = subscribers.get(String(runId));
  return s ? s.size : 0;
}

module.exports = { subscribe, publish, subscriberCount };
