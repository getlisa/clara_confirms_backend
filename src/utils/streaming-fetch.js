/**
 * fetch() whose timeout covers only the RESPONSE phase, never the body transfer.
 *
 * WHY THIS EXISTS — it fixed a crash, not a style problem.
 *
 * `AbortSignal.timeout(ms)` keeps counting while the body is still streaming, so
 * it aborts a download that is progressing perfectly well and merely large or
 * slow. When those bytes are being piped to an HTTP response, the abort surfaces
 * as an `'error'` event on the stream — and an `'error'` event with no listener
 * takes the whole Node process down:
 *
 *     DOMException [TimeoutError]: The operation was aborted due to timeout
 *     Emitted 'error' event on Readable instance at: ...
 *
 * For audio that is trivially easy to hit: an <audio> element issues range
 * requests and holds connections open while the listener scrubs, so a single
 * viewer playing a long recording could kill the backend for everyone.
 *
 * A response-phase timeout is what was actually wanted: fail fast when the
 * upstream never answers, then let however many megabytes take however long
 * they need.
 */

/**
 * @param {string} url
 * @param {object} [opts]
 * @param {object} [opts.headers]
 * @param {number} [opts.responseTimeoutMs]  time allowed to produce HEADERS (not the body)
 * @returns {Promise<{response: Response, abort: (reason?: any) => void}>}
 *   `abort` lets the caller cancel the in-flight body — wire it to the client
 *   disconnecting, so a closed tab does not leave the upstream transfer running.
 */
async function fetchStreaming(url, { headers = undefined, responseTimeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`No response within ${responseTimeoutMs}ms`)),
    responseTimeoutMs
  );

  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    // Headers are in: stop the clock. The body may now take as long as it takes.
    clearTimeout(timer);
    return { response, abort: (reason) => controller.abort(reason) };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

module.exports = { fetchStreaming };
