/**
 * Invite a user to a company — shared by the /users/invite route and the
 * onboarding orchestrator. Inserts a passwordless active user and emails a
 * 7-day invite link (reset-password page with ?invite=true).
 *
 * Throws Error with a `.status` (400/403/409) on validation failures so callers
 * can map to HTTP responses. Returns the new user row on success.
 */

const jwt = require("jsonwebtoken");
const db = require("../db");
const config = require("../config");
const logger = require("../utils/logger");
const { sendMail, buildEmailTemplate } = require("../utils/email");
const companySettings = require("../db/company-settings");

async function inviteUser(companyId, { email, first_name, last_name, role } = {}, invitedBy = null) {
  if (!email || !first_name) {
    throw Object.assign(new Error("Email and first name are required"), { status: 400 });
  }
  if (companyId == null) {
    throw Object.assign(new Error("Company context missing"), { status: 400 });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const userRole = role === "admin" ? "admin" : "user";

  const existing = await db.query("SELECT id FROM users WHERE email = $1", [normalizedEmail]);
  if (existing.rows.length > 0) {
    throw Object.assign(new Error("Email is already registered"), { status: 409 });
  }

  // Enforce max_users from company_settings (count only non-deleted users).
  const maxUsers = Number(await companySettings.getMaxUsers(companyId)) || companySettings.DEFAULT_MAX_USERS;
  const countResult = await db.query(
    "SELECT COUNT(*)::int AS count FROM users WHERE company_id = $1 AND is_deleted = FALSE",
    [companyId]
  );
  const currentCount = Number(countResult.rows[0]?.count ?? 0);
  if (currentCount >= maxUsers) {
    throw Object.assign(
      new Error(`This company can have up to ${maxUsers} user(s). Contact your admin to increase the limit.`),
      { status: 403, max_users: maxUsers }
    );
  }

  const companyResult = await db.query("SELECT name FROM companies WHERE id = $1", [companyId]);
  const companyName = companyResult.rows[0]?.name || "Clara Confirms";

  const insertResult = await db.query(
    `INSERT INTO users (company_id, email, first_name, last_name, role, is_active)
     VALUES ($1, $2, $3, $4, $5, true)
     RETURNING id, email, first_name, last_name, role, is_active, created_at`,
    [companyId, normalizedEmail, first_name.trim(), (last_name || "").trim(), userRole]
  );
  const newUser = insertResult.rows[0];

  const inviteToken = jwt.sign(
    { email: normalizedEmail, companyId, type: "invite" },
    config.jwt.secret,
    { expiresIn: "7d" }
  );
  const inviteUrl = `${config.frontendUrl}/reset-password?token=${encodeURIComponent(inviteToken)}&invite=true`;

  const html = buildEmailTemplate({
    userName: first_name.trim(),
    companyName,
    title: "You've been invited to join " + companyName,
    bodyHtml: `
      <p>You've been invited to join <strong>${companyName}</strong> on Clara Confirms.</p>
      <p>Click the button below to set up your password and access your account.</p>
    `,
    buttonText: "Set Up Your Account",
    buttonUrl: inviteUrl,
    footerText: "This invitation link expires in 7 days.",
  });

  await sendMail({ to: normalizedEmail, subject: `You're invited to ${companyName}`, html });

  logger.info("User invited", { invitedUserId: newUser.id, invitedBy, companyId });
  return newUser;
}

module.exports = { inviteUser };
