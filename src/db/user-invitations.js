/**
 * user_invitations (migration 115) — pending invites to join a company.
 *
 * The emailed token is never stored, only its SHA-256 (token_hash), so a DB
 * read can't be turned into a working invite link. `status` is persisted as
 * pending/accepted/revoked; an expired invite stays 'pending' in the row and is
 * reported as 'expired' by withEffectiveStatus — nothing has to sweep it.
 */

const crypto = require("crypto");
const db = require("./index");

const INVITE_TTL_DAYS = 7;

function newToken() {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function withEffectiveStatus(row) {
  if (!row) return null;
  const expired = row.status === "pending" && new Date(row.expires_at).getTime() <= Date.now();
  return { ...row, status: expired ? "expired" : row.status };
}

const COLS = `i.id, i.company_id, i.email, i.role, i.first_name, i.last_name, i.status, i.invited_by,
  i.expires_at, i.sent_count, i.last_sent_at, i.accepted_at, i.accepted_user_id, i.revoked_at, i.created_at,
  NULLIF(btrim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')), '') AS invited_by_name`;

async function create({ companyId, email, role, firstName = null, lastName = null, invitedBy }) {
  const { token, tokenHash } = newToken();
  const { rows } = await db.query(
    `INSERT INTO user_invitations (company_id, email, role, first_name, last_name, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + ($8 || ' days')::interval)
     RETURNING id`,
    [companyId, email, role, firstName, lastName, tokenHash, invitedBy, String(INVITE_TTL_DAYS)]
  );
  return { invitation: await getById(companyId, rows[0].id), token };
}

async function getById(companyId, id) {
  const { rows } = await db.query(
    `SELECT ${COLS} FROM user_invitations i LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.company_id = $1 AND i.id = $2`,
    [companyId, id]
  );
  return withEffectiveStatus(rows[0]);
}

/** The invite a token belongs to, with the company name — for the public accept page. */
async function getByToken(token) {
  const { rows } = await db.query(
    `SELECT ${COLS}, c.name AS company_name
       FROM user_invitations i
       JOIN companies c ON c.id = i.company_id
       LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.token_hash = $1`,
    [hashToken(token)]
  );
  return withEffectiveStatus(rows[0]);
}

/** Open (pending or expired-but-not-replaced) invites, newest first. */
async function listOpen(companyId) {
  const { rows } = await db.query(
    `SELECT ${COLS} FROM user_invitations i LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.company_id = $1 AND i.status = 'pending'
      ORDER BY i.created_at DESC`,
    [companyId]
  );
  return rows.map(withEffectiveStatus);
}

async function findPending(companyId, email) {
  const { rows } = await db.query(
    `SELECT ${COLS} FROM user_invitations i LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.company_id = $1 AND i.email = $2 AND i.status = 'pending'`,
    [companyId, email]
  );
  return withEffectiveStatus(rows[0]);
}

/** Pending, unexpired invites — they hold a seat until accepted, revoked or expired. */
async function countPendingSeats(companyId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM user_invitations
      WHERE company_id = $1 AND status = 'pending' AND expires_at > NOW()`,
    [companyId]
  );
  return rows[0]?.n ?? 0;
}

/** New token + a fresh 7-day expiry. Returns the raw token (for the email) or null. */
async function rotateToken(companyId, id) {
  const { token, tokenHash } = newToken();
  const { rowCount } = await db.query(
    `UPDATE user_invitations
        SET token_hash = $3, expires_at = NOW() + ($4 || ' days')::interval,
            sent_count = sent_count + 1, last_sent_at = NOW(), updated_at = NOW()
      WHERE company_id = $1 AND id = $2 AND status = 'pending'`,
    [companyId, id, tokenHash, String(INVITE_TTL_DAYS)]
  );
  return rowCount ? token : null;
}

async function revoke(companyId, id) {
  const { rowCount } = await db.query(
    `UPDATE user_invitations SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
      WHERE company_id = $1 AND id = $2 AND status = 'pending'`,
    [companyId, id]
  );
  return rowCount > 0;
}

module.exports = {
  INVITE_TTL_DAYS,
  hashToken,
  withEffectiveStatus,
  create,
  getById,
  getByToken,
  listOpen,
  findPending,
  countPendingSeats,
  rotateToken,
  revoke,
};
