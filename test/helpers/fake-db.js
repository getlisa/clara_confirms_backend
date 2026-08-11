/**
 * Minimal stand-in for src/db — routes queries by SQL substring/regex and
 * records every call, so a test can assert not only on the result but on which
 * queries the code did (and did not) issue.
 */

function createFakeDb() {
  const calls = [];
  const routes = [];

  const api = {
    calls,

    /** Later registrations win, so a test can override a default route. */
    on(pattern, rows) {
      routes.unshift({ pattern, rows });
      return api;
    },

    reset() {
      calls.length = 0;
      routes.length = 0;
    },

    /** Every recorded SQL statement, whitespace-collapsed. */
    sqls() {
      return calls.map((c) => c.sql);
    },

    matched(pattern) {
      return api.sqls().filter((s) => (pattern instanceof RegExp ? pattern.test(s) : s.includes(pattern)));
    },

    async query(text, params) {
      const sql = String(text).replace(/\s+/g, " ").trim();
      calls.push({ sql, params });
      for (const route of routes) {
        const hit = route.pattern instanceof RegExp ? route.pattern.test(sql) : sql.includes(route.pattern);
        if (!hit) continue;
        const rows = typeof route.rows === "function" ? await route.rows(params) : route.rows;
        return { rows: rows || [], rowCount: (rows || []).length };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  return api;
}

module.exports = { createFakeDb };
