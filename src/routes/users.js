/**
 * Users Routes — the company's team (migration 115, docs/team-access-frontend.md).
 *
 * Members, invitations, roles and ownership. All routes are company-scoped;
 * everything that changes the team needs `users.manage` (admins). The rules
 * themselves (owner protection, seats, self-change guards) live in
 * services/team.js.
 */

const express = require("express");
const logger = require("../utils/logger");
const { authenticate } = require("../auth/auth.middleware");
const { requirePermission, PERMISSIONS } = require("../auth/permissions");
const team = require("../services/team");
const invitationsDb = require("../db/user-invitations");
const auditLog = require("../db/audit-log");
const { getCompanyTimezone, toOffsetISOString } = require("../utils/timezone");

const router = express.Router();
router.use(authenticate);

const manage = requirePermission(PERMISSIONS.USERS_MANAGE);

const TS_FIELDS = ["joined_at", "created_at", "last_login", "expires_at", "last_sent_at"];
function localize(obj, tz) {
  if (!obj) return obj;
  const out = { ...obj };
  for (const f of TS_FIELDS) if (f in out) out[f] = toOffsetISOString(out[f], tz);
  return out;
}

function sendTeamError(res, err, label) {
  if (err.status && err.status < 500) {
    return res.status(err.status).json({ error: err.message, code: err.code, ...(err.seats ? { seats: err.seats } : {}) });
  }
  logger.error(`${label} failed`, { error: err.message });
  return res.status(500).json({ error: "Something went wrong" });
}

/**
 * GET /users — the team. Any member may see who's on it.
 */
router.get("/", async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const [members, seats, tz] = await Promise.all([
      team.listMembers(companyId), team.seatUsage(companyId), getCompanyTimezone(companyId),
    ]);
    return res.json({ users: members.map((m) => localize(m, tz)), seats });
  } catch (err) {
    return sendTeamError(res, err, "GET /users");
  }
});

// ── Invitations ─────────────────────────────────────────────────────────────

router.get("/invitations", manage, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const [rows, tz] = await Promise.all([invitationsDb.listOpen(companyId), getCompanyTimezone(companyId)]);
    return res.json({ invitations: rows.map(team.invitationView).map((i) => localize(i, tz)) });
  } catch (err) {
    return sendTeamError(res, err, "GET /users/invitations");
  }
});

async function createInvitationHandler(req, res) {
  try {
    const { email, role, first_name, last_name } = req.body || {};
    const invitation = await team.createInvitation({
      companyId: req.user.companyId,
      actorUserId: req.user.userId,
      email,
      role,
      firstName: first_name,
      lastName: last_name,
    });
    const tz = await getCompanyTimezone(req.user.companyId);
    return res.status(201).json({ invitation: localize(team.invitationView(invitation), tz) });
  } catch (err) {
    return sendTeamError(res, err, "POST /users/invitations");
  }
}

router.post("/invitations", manage, createInvitationHandler);

/**
 * POST /users/invite — DEPRECATED alias of POST /users/invitations, kept for
 * one release so the current frontend keeps working. `role` defaults to
 * developer (the old non-admin role "user" maps to it).
 */
router.post("/invite", manage, (req, res) => {
  const role = req.body?.role === "admin" ? "admin" : (req.body?.role || "developer");
  req.body = { ...(req.body || {}), role: role === "user" ? "developer" : role };
  return createInvitationHandler(req, res);
});

router.post("/invitations/:id/resend", manage, async (req, res) => {
  try {
    const invitation = await team.resendInvitation({
      companyId: req.user.companyId, actorUserId: req.user.userId, invitationId: Number(req.params.id),
    });
    const tz = await getCompanyTimezone(req.user.companyId);
    return res.json({ invitation: localize(team.invitationView(invitation), tz) });
  } catch (err) {
    return sendTeamError(res, err, "POST /users/invitations/:id/resend");
  }
});

router.delete("/invitations/:id", manage, async (req, res) => {
  try {
    await team.revokeInvitation({ companyId: req.user.companyId, actorUserId: req.user.userId, invitationId: Number(req.params.id) });
    return res.json({ message: "Invitation revoked" });
  } catch (err) {
    return sendTeamError(res, err, "DELETE /users/invitations/:id");
  }
});

// ── Ownership + audit ───────────────────────────────────────────────────────

router.post("/transfer-ownership", manage, async (req, res) => {
  try {
    await team.transferOwnership({
      companyId: req.user.companyId,
      actorUserId: req.user.userId,
      actorIsOwner: req.user.isOwner === true,
      toUserId: Number(req.body?.user_id),
    });
    const tz = await getCompanyTimezone(req.user.companyId);
    const users = (await team.listMembers(req.user.companyId)).map((m) => localize(m, tz));
    return res.json({ message: "Ownership transferred", users });
  } catch (err) {
    return sendTeamError(res, err, "POST /users/transfer-ownership");
  }
});

router.get("/audit-log", manage, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const [rows, tz] = await Promise.all([
      auditLog.list(companyId, { limit: req.query.limit, offset: req.query.offset }),
      getCompanyTimezone(companyId),
    ]);
    return res.json({ entries: rows.map((r) => ({ ...r, id: Number(r.id), created_at: toOffsetISOString(r.created_at, tz) })) });
  } catch (err) {
    return sendTeamError(res, err, "GET /users/audit-log");
  }
});

// ── Members ─────────────────────────────────────────────────────────────────

/**
 * PATCH /users/:id — change a member's role and/or active state.
 * Body: { role?: "admin"|"developer"|"confirmer", active?: boolean }
 */
router.patch("/:id", manage, async (req, res) => {
  try {
    const { role, active } = req.body || {};
    if (role === undefined && active === undefined) return res.status(400).json({ error: "No updates provided", code: "no_updates" });
    const user = await team.updateMember({
      companyId: req.user.companyId, actorUserId: req.user.userId, userId: Number(req.params.id), role, active,
    });
    const tz = await getCompanyTimezone(req.user.companyId);
    return res.json({ user: localize(user, tz) });
  } catch (err) {
    return sendTeamError(res, err, "PATCH /users/:id");
  }
});

/** DELETE /users/:id — remove a member (soft delete; their sessions end at once). */
router.delete("/:id", manage, async (req, res) => {
  try {
    await team.removeMember({ companyId: req.user.companyId, actorUserId: req.user.userId, userId: Number(req.params.id) });
    return res.json({ message: "User removed" });
  } catch (err) {
    return sendTeamError(res, err, "DELETE /users/:id");
  }
});

module.exports = router;
