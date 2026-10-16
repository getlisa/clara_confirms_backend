/**
 * Team access: inviting colleagues onto a company account and managing their
 * roles (migration 115, docs/team-access-frontend.md).
 *
 * Rules enforced here (routes only translate errors):
 *  - One company per person: an email that belongs to an active user anywhere
 *    can't be invited. A REMOVED (soft-deleted) user of this same company, or
 *    a never-activated legacy invite row, is revived on accept — users.email is
 *    globally unique, so a new row could never be created for them.
 *  - No seat limit: a company can have any number of members.
 *  - The owner can't be demoted, deactivated or removed; nobody can change
 *    their own role or deactivate/remove themselves. Ownership moves only by an
 *    explicit transfer to another active admin.
 *  - Any role/active change or removal bumps token_version, which revokes the
 *    user's existing tokens on their next request.
 */

const db = require("../db");
const config = require("../config");
const logger = require("../utils/logger");
const invitationsDb = require("../db/user-invitations");
const auditLog = require("../db/audit-log");
const authService = require("../auth/auth.service");
const { invalidateUserState } = require("../auth/auth.middleware");
const { isValidRole, permissionsFor } = require("../auth/permissions");
const { sendMail, buildEmailTemplate, escapeHtml } = require("../utils/email");

const MIN_PASSWORD_LENGTH = 8;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_SENDS = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function teamError(status, code, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

const normEmail = (e) => String(e || "").trim().toLowerCase();
const fullName = (r) => [r?.first_name, r?.last_name].filter(Boolean).join(" ").trim() || null;

// ── Seats ───────────────────────────────────────────────────────────────────
//
// There is no seat limit; these counts are informational (the Team page shows
// them). max_users stays null so a client can tell "unlimited" from a number.

async function seatUsage(companyId) {
  const [{ rows }, pending] = await Promise.all([
    db.query(
      `SELECT COUNT(*)::int AS n FROM users
        WHERE company_id = $1 AND is_deleted = FALSE AND is_active = TRUE
          AND (password_hash IS NOT NULL OR supabase_id IS NOT NULL)`,
      [companyId]
    ),
    invitationsDb.countPendingSeats(companyId),
  ]);
  return { max_users: null, active_users: rows[0]?.n ?? 0, pending_invitations: pending };
}

// ── Emails ──────────────────────────────────────────────────────────────────

async function sendInviteEmail({ invitation, token, companyName, inviterName }) {
  const url = `${config.frontendUrl}/accept-invite?token=${encodeURIComponent(token)}`;
  const roleLabel = { admin: "an Admin", developer: "a Developer", confirmer: "a Confirmer" }[invitation.role] || "a member";
  const html = buildEmailTemplate({
    userName: invitation.first_name || null,
    companyName,
    title: `You've been invited to join ${companyName}`,
    bodyHtml: `
      <p>${inviterName ? `<strong>${escapeHtml(inviterName)}</strong> has invited you` : "You've been invited"} to join
      <strong>${escapeHtml(companyName)}</strong> on Clara Confirms as ${escapeHtml(roleLabel)}.</p>
      <p>Click the button below to set your password and get started.</p>
    `,
    buttonText: "Accept invitation",
    buttonUrl: url,
    footerText: `This invitation expires in ${invitationsDb.INVITE_TTL_DAYS} days. If you weren't expecting it, you can ignore this email.`,
  });
  await sendMail({
    to: invitation.email,
    subject: `You're invited to join ${companyName} on Clara Confirms`,
    text: `${inviterName || "Someone"} invited you to join ${companyName} on Clara Confirms as ${roleLabel}. Accept here: ${url}\n\nThis link expires in ${invitationsDb.INVITE_TTL_DAYS} days.`,
    html,
  });
}

async function companyAndInviter(companyId, inviterId) {
  const { rows } = await db.query(
    `SELECT c.name AS company_name, u.first_name, u.last_name
       FROM companies c LEFT JOIN users u ON u.id = $2 AND u.company_id = c.id
      WHERE c.id = $1`,
    [companyId, inviterId]
  );
  return { companyName: rows[0]?.company_name || "Clara Confirms", inviterName: fullName(rows[0]) };
}

// ── Invitations ─────────────────────────────────────────────────────────────

/** An existing users row blocking (or revivable by) an invite to `email`. */
async function existingUserFor(email) {
  const { rows } = await db.query(
    `SELECT id, company_id, is_deleted, is_active, (password_hash IS NOT NULL OR supabase_id IS NOT NULL) AS has_login
       FROM users WHERE email = $1`,
    [email]
  );
  return rows[0] || null;
}

function revivable(existing, companyId) {
  return !!existing && String(existing.company_id) === String(companyId) && (existing.is_deleted || !existing.has_login);
}

async function createInvitation({ companyId, actorUserId, email, role, firstName = null, lastName = null }) {
  const e = normEmail(email);
  if (!EMAIL_RE.test(e)) throw teamError(400, "invalid_email", "A valid email address is required");
  if (!isValidRole(role)) throw teamError(400, "invalid_role", "role must be one of: admin, developer, confirmer");

  const existing = await existingUserFor(e);
  if (existing && !revivable(existing, companyId)) {
    throw String(existing.company_id) === String(companyId)
      ? teamError(409, "already_member", "This person is already a member of your team")
      : teamError(409, "email_in_use", "This email already has a Clara Confirms account with another company");
  }
  if (await invitationsDb.findPending(companyId, e)) {
    throw teamError(409, "invite_pending", "An invitation is already open for this email — resend it instead");
  }
  const { invitation, token } = await invitationsDb.create({
    companyId, email: e, role, firstName: firstName?.trim() || null, lastName: lastName?.trim() || null, invitedBy: actorUserId,
  });
  const { companyName, inviterName } = await companyAndInviter(companyId, actorUserId);
  await sendInviteEmail({ invitation, token, companyName, inviterName });
  await auditLog.record({ companyId, actorUserId, action: "user.invited", targetType: "invitation", targetId: invitation.id, metadata: { email: e, role } });
  logger.info("team: invitation sent", { companyId, invitationId: invitation.id, role, invitedBy: actorUserId });
  return invitation;
}

async function resendInvitation({ companyId, actorUserId, invitationId }) {
  const inv = await invitationsDb.getById(companyId, invitationId);
  if (!inv) throw teamError(404, "not_found", "Invitation not found");
  if (!["pending", "expired"].includes(inv.status)) throw teamError(409, "not_open", `This invitation is ${inv.status}`);
  if (inv.sent_count >= MAX_SENDS) throw teamError(429, "resend_limit", "This invitation has been sent too many times — revoke it and invite again");
  if (Date.now() - new Date(inv.last_sent_at).getTime() < RESEND_COOLDOWN_MS) {
    throw teamError(429, "resend_cooldown", "Please wait a minute before resending");
  }
  const token = await invitationsDb.rotateToken(companyId, invitationId);
  if (!token) throw teamError(409, "not_open", "This invitation is no longer open");
  const fresh = await invitationsDb.getById(companyId, invitationId);
  const { companyName, inviterName } = await companyAndInviter(companyId, actorUserId);
  await sendInviteEmail({ invitation: fresh, token, companyName, inviterName });
  await auditLog.record({ companyId, actorUserId, action: "user.invite_resent", targetType: "invitation", targetId: invitationId });
  return fresh;
}

async function revokeInvitation({ companyId, actorUserId, invitationId }) {
  const ok = await invitationsDb.revoke(companyId, invitationId);
  if (!ok) throw teamError(404, "not_found", "No open invitation with that id");
  await auditLog.record({ companyId, actorUserId, action: "user.invite_revoked", targetType: "invitation", targetId: invitationId });
}

/** Public: what the accept page shows. Never reveals anything for a bad token. */
async function describeInvitation(token) {
  const inv = token ? await invitationsDb.getByToken(token) : null;
  if (!inv) throw teamError(404, "invalid_invitation", "This invitation link is invalid");
  if (inv.status !== "pending") {
    throw teamError(410, `invitation_${inv.status}`, {
      expired: "This invitation has expired — ask your admin to resend it",
      accepted: "This invitation has already been used — sign in instead",
      revoked: "This invitation was cancelled",
    }[inv.status] || "This invitation is no longer valid");
  }
  return {
    email: inv.email,
    role: inv.role,
    first_name: inv.first_name,
    last_name: inv.last_name,
    company_name: inv.company_name,
    invited_by_name: inv.invited_by_name,
    expires_at: inv.expires_at,
  };
}

/**
 * Public: accept an invitation — set a password and become a member. One
 * transaction with the invite row locked, so a double-submit can't create two
 * users or accept twice. Returns tokens so the frontend signs straight in.
 */
async function acceptInvitation({ token, password, firstName, lastName }) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw teamError(400, "weak_password", `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (!token) throw teamError(404, "invalid_invitation", "This invitation link is invalid");
  const passwordHash = await authService.hashPassword(password);

  const user = await db.transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM user_invitations WHERE token_hash = $1 FOR UPDATE`,
      [invitationsDb.hashToken(token)]
    );
    const inv = invitationsDb.withEffectiveStatus(rows[0]);
    if (!inv) throw teamError(404, "invalid_invitation", "This invitation link is invalid");
    if (inv.status !== "pending") throw teamError(410, `invitation_${inv.status}`, "This invitation is no longer valid");

    const first = (firstName ?? inv.first_name ?? "").trim();
    const last = (lastName ?? inv.last_name ?? "").trim();
    if (!first) throw teamError(400, "first_name_required", "First name is required");

    const { rows: existingRows } = await client.query(
      `SELECT id, company_id, is_deleted, (password_hash IS NOT NULL OR supabase_id IS NOT NULL) AS has_login
         FROM users WHERE email = $1 FOR UPDATE`,
      [inv.email]
    );
    const existing = existingRows[0] || null;
    let row;
    if (existing && revivable(existing, inv.company_id)) {
      const { rows: up } = await client.query(
        `UPDATE users SET first_name = $2, last_name = $3, password_hash = $4, role = $5,
                is_active = TRUE, is_deleted = FALSE, is_owner = FALSE, invited_by = $6, joined_at = NOW(),
                token_version = token_version + 1, updated_at = NOW()
          WHERE id = $1
          RETURNING id, company_id, email, first_name, last_name, role, is_owner, token_version`,
        [existing.id, first, last, passwordHash, inv.role, inv.invited_by]
      );
      row = up[0];
    } else if (existing) {
      throw teamError(409, "email_in_use", "This email already has a Clara Confirms account — sign in instead");
    } else {
      const { rows: ins } = await client.query(
        `INSERT INTO users (company_id, email, first_name, last_name, password_hash, role, is_active, invited_by, joined_at)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, NOW())
         RETURNING id, company_id, email, first_name, last_name, role, is_owner, token_version`,
        [inv.company_id, inv.email, first, last, passwordHash, inv.role, inv.invited_by]
      );
      row = ins[0];
    }
    await client.query(
      `UPDATE user_invitations SET status = 'accepted', accepted_at = NOW(), accepted_user_id = $2, updated_at = NOW()
        WHERE id = $1`,
      [inv.id, row.id]
    );
    return row;
  });

  invalidateUserState(user.id);
  await auditLog.record({ companyId: user.company_id, actorUserId: user.id, action: "user.joined", targetType: "user", targetId: user.id, metadata: { role: user.role } });
  const payload = authService.buildTokenPayload(user);
  const { rows: co } = await db.query(`SELECT name FROM companies WHERE id = $1`, [user.company_id]);
  return {
    token: authService.generateAccessToken(payload),
    refreshToken: authService.generateRefreshToken(payload),
    user: {
      id: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name,
      name: fullName(user), role: user.role, is_owner: user.is_owner === true,
      company_id: user.company_id, company_name: co[0]?.name || null,
      permissions: permissionsFor(user.role),
    },
  };
}

// ── Members ─────────────────────────────────────────────────────────────────

async function getMember(companyId, userId, client = db) {
  const { rows } = await client.query(
    `SELECT id, company_id, email, first_name, last_name, role, is_active, is_owner, is_deleted
       FROM users WHERE id = $1 AND company_id = $2 AND is_deleted = FALSE`,
    [userId, companyId]
  );
  return rows[0] || null;
}

async function updateMember({ companyId, actorUserId, userId, role, active }) {
  const target = await getMember(companyId, userId);
  if (!target) throw teamError(404, "not_found", "User not found");
  const isSelf = String(target.id) === String(actorUserId);
  if (role !== undefined) {
    if (!isValidRole(role)) throw teamError(400, "invalid_role", "role must be one of: admin, developer, confirmer");
    if (isSelf && role !== target.role) throw teamError(400, "self_role_change", "You can't change your own role");
    if (target.is_owner && role !== "admin") throw teamError(400, "owner_protected", "The account owner must stay an Admin — transfer ownership first");
  }
  if (active !== undefined) {
    if (typeof active !== "boolean") throw teamError(400, "invalid_active", "active must be a boolean");
    if (isSelf && active === false) throw teamError(400, "self_deactivate", "You can't deactivate yourself");
    if (target.is_owner && active === false) throw teamError(400, "owner_protected", "The account owner can't be deactivated");
  }
  const changes = {};
  if (role !== undefined && role !== target.role) changes.role = role;
  if (active !== undefined && active !== target.is_active) changes.is_active = active;
  if (!Object.keys(changes).length) return getMemberView(companyId, userId);

  const sets = Object.keys(changes).map((k, i) => `${k} = $${i + 3}`);
  await db.query(
    `UPDATE users SET ${sets.join(", ")}, token_version = token_version + 1, updated_at = NOW()
      WHERE id = $1 AND company_id = $2`,
    [userId, companyId, ...Object.values(changes)]
  );
  invalidateUserState(userId);
  if (changes.role) {
    await auditLog.record({ companyId, actorUserId, action: "user.role_changed", targetType: "user", targetId: userId, metadata: { from: target.role, to: changes.role } });
  }
  if (changes.is_active !== undefined) {
    await auditLog.record({ companyId, actorUserId, action: changes.is_active ? "user.reactivated" : "user.deactivated", targetType: "user", targetId: userId });
  }
  return getMemberView(companyId, userId);
}

async function removeMember({ companyId, actorUserId, userId }) {
  const target = await getMember(companyId, userId);
  if (!target) throw teamError(404, "not_found", "User not found");
  if (String(target.id) === String(actorUserId)) throw teamError(400, "self_remove", "You can't remove yourself");
  if (target.is_owner) throw teamError(400, "owner_protected", "The account owner can't be removed — transfer ownership first");
  await db.query(
    `UPDATE users SET is_deleted = TRUE, is_active = FALSE, token_version = token_version + 1, updated_at = NOW()
      WHERE id = $1 AND company_id = $2`,
    [userId, companyId]
  );
  invalidateUserState(userId);
  await auditLog.record({ companyId, actorUserId, action: "user.removed", targetType: "user", targetId: userId, metadata: { email: target.email } });
}

async function transferOwnership({ companyId, actorUserId, actorIsOwner, toUserId }) {
  if (!actorIsOwner) throw teamError(403, "owner_only", "Only the account owner can transfer ownership");
  if (String(toUserId) === String(actorUserId)) throw teamError(400, "already_owner", "You are already the owner");
  await db.transaction(async (client) => {
    const target = await getMember(companyId, toUserId, client);
    if (!target || !target.is_active) throw teamError(404, "not_found", "User not found");
    if (target.role !== "admin") throw teamError(400, "not_admin", "Ownership can only go to an Admin — promote them first");
    // Clear first: the one-owner-per-company unique index would reject two at once.
    await client.query(`UPDATE users SET is_owner = FALSE, updated_at = NOW() WHERE company_id = $1 AND is_owner`, [companyId]);
    await client.query(`UPDATE users SET is_owner = TRUE, updated_at = NOW() WHERE id = $1 AND company_id = $2`, [toUserId, companyId]);
  });
  invalidateUserState(actorUserId);
  invalidateUserState(toUserId);
  await auditLog.record({ companyId, actorUserId, action: "owner.transferred", targetType: "user", targetId: toUserId });
}

function memberView(r) {
  return {
    id: r.id,
    email: r.email,
    first_name: r.first_name,
    last_name: r.last_name,
    name: fullName(r) || "",
    role: r.role,
    is_owner: r.is_owner === true,
    active: r.is_active,
    joined_at: r.joined_at ?? null,
    created_at: r.created_at ?? null,
    last_login: r.last_login ?? null,
  };
}

async function listMembers(companyId) {
  const { rows } = await db.query(
    `SELECT id, email, first_name, last_name, role, is_owner, is_active, joined_at, created_at, last_login
       FROM users WHERE company_id = $1 AND is_deleted = FALSE
      ORDER BY is_owner DESC, created_at ASC`,
    [companyId]
  );
  return rows.map(memberView);
}

async function getMemberView(companyId, userId) {
  const { rows } = await db.query(
    `SELECT id, email, first_name, last_name, role, is_owner, is_active, joined_at, created_at, last_login
       FROM users WHERE id = $1 AND company_id = $2 AND is_deleted = FALSE`,
    [userId, companyId]
  );
  return rows[0] ? memberView(rows[0]) : null;
}

function invitationView(i) {
  return {
    id: Number(i.id),
    email: i.email,
    role: i.role,
    first_name: i.first_name,
    last_name: i.last_name,
    status: i.status,
    invited_by: i.invited_by != null ? Number(i.invited_by) : null,
    invited_by_name: i.invited_by_name ?? null,
    expires_at: i.expires_at,
    sent_count: i.sent_count,
    last_sent_at: i.last_sent_at,
    created_at: i.created_at,
  };
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  seatUsage,
  createInvitation,
  resendInvitation,
  revokeInvitation,
  describeInvitation,
  acceptInvitation,
  updateMember,
  removeMember,
  transferOwnership,
  listMembers,
  getMemberView,
  invitationView,
};
