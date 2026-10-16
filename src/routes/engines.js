/**
 * Generic workflow-engine routes.
 *
 *   POST /engines/:kind          → start a run for this user's company (JWT)
 *   GET  /engines                → list recent runs (?kind=, ?limit=)
 *   GET  /engines/:runId         → snapshot JSON
 *   GET  /engines/:runId/stream  → SSE stream (?token=<signed>)
 *
 * SSE auth: browser EventSource cannot set Authorization headers, so
 * POST /engines/:kind returns a short-lived `streamToken` that the client
 * appends to the stream URL as `?token=...`. The token is bound to
 * (runId, companyId) and is signed with ENGINE_STREAM_SECRET.
 */

const express = require("express");
const { authenticate } = require("../auth/auth.middleware");
const engines = require("../engines");
const runsDb = require("../engines/core/db");
const sse = require("../engines/core/sse");
const token = require("../engines/core/token");
const logger = require("../utils/logger");
const { requirePermission, requireDynamicPermission, permissionForCallType, PERMISSIONS: PERM } = require("../auth/permissions");

const router = express.Router();

// Which engine decides the permission: syncs and CSV imports are sync.run, the
// scheduler (which places calls) is calls.make.
const ENGINE_PERMISSIONS = { crm_sync: PERM.SYNC_RUN, csv_import: PERM.SYNC_RUN, scheduler_run: PERM.CALLS_MAKE };
const enginePermission = requireDynamicPermission(
  (req) => ENGINE_PERMISSIONS[req.params.kind] || PERM.CALLS_MAKE,
  "sync.run | calls.make"
);

// ── Start a run ──────────────────────────────────────────────────────────────
router.post("/:kind", authenticate, enginePermission, async (req, res) => {
  const { kind } = req.params;
  const mod = engines.getEngine(kind);
  if (!mod) {
    return res.status(404).json({ error: `Unknown engine kind: ${kind}` });
  }
  try {
    const engine = await mod.start({
      companyId: req.user.companyId,
      startedBy: req.user.id,
      ...req.body, // engine-specific options pass through (e.g. {full:true})
    });
    const streamToken = token.sign({ runId: engine.id, companyId: engine.companyId });
    return res.status(201).json({
      runId:       String(engine.id),
      kind:        engine.kind,
      streamToken,
      streamUrl:   `/engines/${engine.id}/stream?token=${encodeURIComponent(streamToken)}`,
      snapshotUrl: `/engines/${engine.id}`,
    });
  } catch (err) {
    logger.error("Engine start failed", { kind, error: err.message });
    return res.status(500).json({ error: "Failed to start engine", detail: err.message });
  }
});

// ── List recent runs ─────────────────────────────────────────────────────────
router.get("/", authenticate, async (req, res) => {
  const kind = req.query.kind || null;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const runs = await runsDb.listRuns({ companyId: req.user.companyId, kind, limit });
  return res.json({ runs });
});

// ── Snapshot ─────────────────────────────────────────────────────────────────
router.get("/:runId", authenticate, async (req, res) => {
  const run = await runsDb.getRun(req.params.runId, { companyId: req.user.companyId });
  if (!run) return res.status(404).json({ error: "Engine run not found" });
  return res.json(run);
});

// ── SSE stream ───────────────────────────────────────────────────────────────
// Note: NOT behind `authenticate` middleware — uses signed query-string token
// since EventSource cannot send Authorization headers from the browser.
router.get("/:runId/stream", async (req, res) => {
  const t = req.query.token;
  const claim = token.verify(String(t || ""));
  if (!claim) {
    return res.status(401).json({ error: "Invalid or expired stream token" });
  }
  if (String(claim.runId) !== String(req.params.runId)) {
    return res.status(403).json({ error: "Token does not match runId" });
  }
  return sse.streamRun(req, res, {
    runId: req.params.runId,
    companyId: claim.companyId,
  });
});

module.exports = router;
