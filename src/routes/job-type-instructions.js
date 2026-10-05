/**
 * Pre-visit instructions by job type (CMAP-230) — the surface the frontend
 * uses to author them.
 *
 * GET    /job-type-instructions            — list, optionally one job type
 * GET    /job-type-instructions/job-types  — picker options from real job data
 * POST   /job-type-instructions            — create
 * PATCH  /job-type-instructions/:id        — update any subset
 * DELETE /job-type-instructions/:id        — remove
 *
 * These are delivered to the agent AFTER a visit is confirmed — see
 * services/job-confirmation-context.js for the resolution and
 * db/call-type-configs.js for the spoken step.
 *
 * docs/previsit-instructions-frontend.md is the frontend contract: §2 covers
 * the picker (the only safe source of job_type values), §4 the status codes,
 * and §5 what requires_acknowledgement changes about the call.
 */

const express = require("express");
const { authenticate, getCompanyId } = require("../auth");
const jobTypeInstructionsDb = require("../db/job-type-instructions");
const logger = require("../utils/logger");

const router = express.Router();
router.use(authenticate);

// Long enough for a real instruction, short enough that the agent can say it.
// The dynamic variable is truncated at 500 chars across ALL instructions for a
// job type, so a single 2000-char entry would silently crowd out the rest.
const MAX_INSTRUCTION_CHARS = 400;

function validate(body, { partial = false } = {}) {
  if (!partial || "job_type" in body) {
    const jt = jobTypeInstructionsDb.normalizeJobType(body.job_type);
    if (!jt) return "job_type is required";
  }
  if (!partial || "instruction" in body) {
    const text = body.instruction == null ? "" : String(body.instruction).trim();
    if (!text) return "instruction is required";
    if (text.length > MAX_INSTRUCTION_CHARS) return `instruction must be ${MAX_INSTRUCTION_CHARS} characters or fewer`;
  }
  if ("sort_order" in body && body.sort_order != null && !Number.isInteger(body.sort_order)) {
    return "sort_order must be an integer";
  }
  return null;
}

router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const instructions = await jobTypeInstructionsDb.list(companyId, {
      jobType: req.query.job_type || null,
      activeOnly: req.query.active === "true",
    });

    // Grouped as well as flat: the UI lists these under a job-type heading,
    // and grouping here keeps that logic out of the client.
    const byJobType = [];
    const seen = new Map();
    for (const row of instructions) {
      if (!seen.has(row.job_type)) {
        const group = { job_type: row.job_type, job_type_label: row.job_type_label, instructions: [] };
        seen.set(row.job_type, group);
        byJobType.push(group);
      }
      seen.get(row.job_type).instructions.push(row);
    }

    return res.json({ instructions, by_job_type: byJobType });
  } catch (err) {
    logger.error("GET /job-type-instructions failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load instructions" });
  }
});

/**
 * Declared BEFORE any "/:id" route so the literal path is not swallowed by the
 * parameter. (There is no GET /:id today, but adding one later would silently
 * break this if the order were reversed.)
 */
router.get("/job-types", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });
    const jobTypes = await jobTypeInstructionsDb.listJobTypeOptions(companyId);
    return res.json({ job_types: jobTypes });
  } catch (err) {
    logger.error("GET /job-type-instructions/job-types failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load job types" });
  }
});

router.post("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const body = req.body || {};
    const invalid = validate(body);
    if (invalid) return res.status(400).json({ error: invalid });

    const instruction = await jobTypeInstructionsDb.create({
      companyId,
      jobType: body.job_type,
      instruction: body.instruction,
      requiresAcknowledgement: body.requires_acknowledgement === true,
      sortOrder: body.sort_order ?? 0,
      active: body.active !== false,
    });
    return res.status(201).json({ instruction });
  } catch (err) {
    if (err.code === "DUPLICATE") return res.status(409).json({ error: err.message });
    logger.error("POST /job-type-instructions failed", { error: err.message });
    return res.status(500).json({ error: "Failed to create instruction" });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const body = req.body || {};
    const invalid = validate(body, { partial: true });
    if (invalid) return res.status(400).json({ error: invalid });

    const instruction = await jobTypeInstructionsDb.update(companyId, req.params.id, body);
    if (!instruction) return res.status(404).json({ error: "Instruction not found" });
    return res.json({ instruction });
  } catch (err) {
    if (err.code === "DUPLICATE") return res.status(409).json({ error: err.message });
    logger.error("PATCH /job-type-instructions failed", { error: err.message });
    return res.status(500).json({ error: "Failed to update instruction" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });
    const removed = await jobTypeInstructionsDb.remove(companyId, req.params.id);
    if (!removed) return res.status(404).json({ error: "Instruction not found" });
    return res.status(204).send();
  } catch (err) {
    logger.error("DELETE /job-type-instructions failed", { error: err.message });
    return res.status(500).json({ error: "Failed to delete instruction" });
  }
});

module.exports = router;
