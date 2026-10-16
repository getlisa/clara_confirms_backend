/**
 * Team access (migration 115): roles, permissions, live user state, the
 * invitation lifecycle and member-management guard rails, and copilot gating.
 * Runs against an in-memory fake of the users / user_invitations tables.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());

// ── in-memory tables ────────────────────────────────────────────────────────
let users, invites, nextUserId, nextInviteId, maxUsers, sentMail, audits;
const sha = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
function resetData() {
  users = [
    { id: 1, company_id: 7, email: "owner@acme.test", first_name: "Olive", last_name: "Owner", role: "admin", is_active: true, is_deleted: false, is_owner: true, token_version: 0, has_login: true },
    { id: 2, company_id: 7, email: "dev@acme.test", first_name: "Dev", last_name: "One", role: "developer", is_active: true, is_deleted: false, is_owner: false, token_version: 0, has_login: true },
    { id: 3, company_id: 7, email: "gone@acme.test", first_name: "Gone", last_name: "Away", role: "confirmer", is_active: false, is_deleted: true, is_owner: false, token_version: 2, has_login: true },
    { id: 4, company_id: 99, email: "other@elsewhere.test", first_name: "Other", last_name: "Co", role: "admin", is_active: true, is_deleted: false, is_owner: true, token_version: 0, has_login: true },
  ];
  invites = []; nextUserId = 10; nextInviteId = 1; maxUsers = 5; sentMail = []; audits = [];
}
resetData();

const effective = (i) => (i && i.status === "pending" && new Date(i.expires_at) <= new Date() ? { ...i, status: "expired" } : i);

async function query(sql, params = []) {
  const q = String(sql).replace(/\s+/g, " ");
  if (/FROM users WHERE id = \$1$/.test(q.trim()) || /FROM users WHERE id = \$1 *$/.test(q)) {
    const u = users.find((x) => String(x.id) === String(params[0]));
    return { rows: u ? [u] : [] };
  }
  if (/FROM users WHERE email = \$1/.test(q)) {
    const u = users.find((x) => x.email === params[0]);
    return { rows: u ? [{ ...u }] : [] };
  }
  if (/SELECT COUNT\(\*\)::int AS n FROM users/.test(q)) {
    return { rows: [{ n: users.filter((u) => String(u.company_id) === String(params[0]) && !u.is_deleted && u.is_active && u.has_login).length }] };
  }
  if (/FROM companies c LEFT JOIN users u/.test(q)) {
    const u = users.find((x) => String(x.id) === String(params[1]));
    return { rows: [{ company_name: "Acme Fire", first_name: u?.first_name, last_name: u?.last_name }] };
  }
  if (/SELECT name FROM companies/.test(q)) return { rows: [{ name: "Acme Fire" }] };
  if (/SELECT \* FROM user_invitations WHERE token_hash = \$1/.test(q)) {
    return { rows: invites.filter((i) => i.token_hash === params[0]).map((i) => ({ ...i })) };
  }
  if (/UPDATE users SET first_name = \$2, last_name = \$3, password_hash = \$4, role = \$5/.test(q)) {
    const u = users.find((x) => x.id === params[0]);
    Object.assign(u, { first_name: params[1], last_name: params[2], role: params[4], is_active: true, is_deleted: false, is_owner: false, has_login: true, token_version: u.token_version + 1 });
    return { rows: [{ ...u }] };
  }
  if (/^INSERT INTO users/.test(q.trim())) {
    const u = { id: nextUserId++, company_id: params[0], email: params[1], first_name: params[2], last_name: params[3], role: params[5], is_active: true, is_deleted: false, is_owner: false, token_version: 0, has_login: true };
    users.push(u);
    return { rows: [{ ...u }] };
  }
  if (/UPDATE user_invitations SET status = 'accepted'/.test(q)) {
    const i = invites.find((x) => x.id === params[0]);
    Object.assign(i, { status: "accepted", accepted_user_id: params[1] });
    return { rows: [], rowCount: 1 };
  }
  if (/FROM users WHERE id = \$1 AND company_id = \$2 AND is_deleted = FALSE/.test(q)) {
    const u = users.find((x) => String(x.id) === String(params[0]) && String(x.company_id) === String(params[1]) && !x.is_deleted);
    return { rows: u ? [{ ...u }] : [] };
  }
  if (/FROM users WHERE company_id = \$1 AND is_deleted = FALSE/.test(q)) {
    return { rows: users.filter((u) => String(u.company_id) === String(params[0]) && !u.is_deleted) };
  }
  if (/UPDATE users SET is_deleted = TRUE/.test(q)) {
    const u = users.find((x) => String(x.id) === String(params[0]));
    Object.assign(u, { is_deleted: true, is_active: false, token_version: u.token_version + 1 });
    return { rows: [], rowCount: 1 };
  }
  if (/UPDATE users SET (role|is_active).* token_version = token_version \+ 1/.test(q)) {
    const u = users.find((x) => String(x.id) === String(params[0]));
    const cols = [...q.matchAll(/(role|is_active) = \$(\d+)/g)];
    for (const [, col, idx] of cols) u[col] = params[Number(idx) - 1];
    u.token_version += 1;
    return { rows: [], rowCount: 1 };
  }
  if (/UPDATE users SET is_owner = FALSE/.test(q)) {
    users.filter((u) => String(u.company_id) === String(params[0])).forEach((u) => { u.is_owner = false; });
    return { rows: [], rowCount: 1 };
  }
  if (/UPDATE users SET is_owner = TRUE/.test(q)) {
    const u = users.find((x) => String(x.id) === String(params[0]));
    u.is_owner = true;
    return { rows: [], rowCount: 1 };
  }
  throw new Error(`fake db: unhandled query: ${q.slice(0, 120)}`);
}
stub("db", { query, transaction: async (cb) => cb({ query }) });

stub("db/user-invitations", {
  INVITE_TTL_DAYS: 7,
  hashToken: sha,
  withEffectiveStatus: effective,
  create: async ({ companyId, email, role, firstName, lastName, invitedBy }) => {
    const token = `tok-${nextInviteId}`;
    const inv = { id: nextInviteId++, company_id: companyId, email, role, first_name: firstName, last_name: lastName, token_hash: sha(token), status: "pending", invited_by: invitedBy, expires_at: new Date(Date.now() + 7 * 86400000), sent_count: 1, last_sent_at: new Date(0), created_at: new Date() };
    invites.push(inv);
    return { invitation: { ...inv }, token };
  },
  getById: async (c, id) => effective(invites.find((i) => i.id === id && String(i.company_id) === String(c))),
  getByToken: async (t) => { const i = invites.find((x) => x.token_hash === sha(t)); return i ? effective({ ...i, company_name: "Acme Fire", invited_by_name: "Olive Owner" }) : null; },
  findPending: async (c, e) => invites.find((i) => String(i.company_id) === String(c) && i.email === e && i.status === "pending") || null,
  countPendingSeats: async (c) => invites.filter((i) => String(i.company_id) === String(c) && i.status === "pending" && new Date(i.expires_at) > new Date()).length,
  rotateToken: async (c, id) => { const i = invites.find((x) => x.id === id); i.sent_count++; i.last_sent_at = new Date(); i.token_hash = sha(`rot-${id}`); return `rot-${id}`; },
  revoke: async (c, id) => { const i = invites.find((x) => x.id === id && x.status === "pending"); if (!i) return false; i.status = "revoked"; return true; },
  listOpen: async () => [],
});
stub("db/audit-log", { record: async (e) => { audits.push(e); }, list: async () => [] });
stub("db/company-settings", { getMaxUsers: async () => maxUsers, DEFAULT_MAX_USERS: 3 });
stub("utils/email", { sendMail: async (m) => { sentMail.push(m); }, buildEmailTemplate: (o) => JSON.stringify(o), escapeHtml: (s) => String(s) });
const invalidated = [];
stub("auth/auth.middleware", { invalidateUserState: (id) => invalidated.push(id) });
stub("auth/auth.service", {
  hashPassword: async (p) => `hash:${p}`,
  buildTokenPayload: (u) => ({ userId: u.id, role: u.role, tokenVersion: u.token_version }),
  generateAccessToken: (p) => `access:${p.userId}:${p.role}`,
  generateRefreshToken: (p) => `refresh:${p.userId}`,
});

const perms = require("../src/auth/permissions");
const team = require("../src/services/team");

test.beforeEach(() => { resetData(); invalidated.length = 0; });

// ── permission matrix ───────────────────────────────────────────────────────

test("admin has every permission", () => {
  for (const p of Object.values(perms.PERMISSIONS)) assert.ok(perms.hasPermission("admin", p), p);
});

test("developer: calls, syncs, CSV import, settings, agent voice/name — not prompt, users, CRM credentials, company", () => {
  for (const p of ["calls.make", "sync.run", "settings.edit", "agent.voice", "jobs.edit", "confirmations.send", "todos.manage"]) assert.ok(perms.hasPermission("developer", p), p);
  for (const p of ["prompt.edit", "users.manage", "integrations.manage", "company.manage", "agent.manage"]) assert.ok(!perms.hasPermission("developer", p), p);
});

test("confirmer: read, copilot, confirmations (incl. confirmation calls) — nothing else", () => {
  assert.deepEqual(perms.permissionsFor("confirmer").sort(), ["confirmations.send", "copilot.use", "data.read"]);
  assert.equal(perms.permissionForCallType("customer_confirmation"), "confirmations.send");
  assert.equal(perms.permissionForCallType("technician_confirmation"), "confirmations.send");
  assert.equal(perms.permissionForCallType("quotation_followup"), "calls.make");
  assert.equal(perms.permissionForCallType(null), "calls.make");
});

test("requirePermission answers 403 with the permission it needed", () => {
  const mw = perms.requirePermission("prompt.edit");
  let status, body, nexted = false;
  const res = { status: (s) => { status = s; return { json: (b) => { body = b; } }; } };
  mw({ user: { role: "developer" } }, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(status, 403);
  assert.deepEqual(body, { error: "You don't have permission to do this", code: "forbidden", required: "prompt.edit" });
  mw({ user: { role: "admin" } }, res, () => { nexted = true; });
  assert.equal(nexted, true);
});

// ── invitations ─────────────────────────────────────────────────────────────

test("an invite emails a link to /accept-invite and holds a seat", async () => {
  const inv = await team.createInvitation({ companyId: 7, actorUserId: 1, email: " New@Acme.test ", role: "confirmer" });
  assert.equal(inv.email, "new@acme.test", "normalised");
  assert.equal(sentMail.length, 1);
  assert.match(sentMail[0].text, /\/accept-invite\?token=tok-1/);
  assert.equal((await team.seatUsage(7)).pending_invitations, 1);
  assert.equal(audits[0].action, "user.invited");
});

test("invites are refused for an existing member, another company's user, an open invite or a bad role", async () => {
  await assert.rejects(team.createInvitation({ companyId: 7, actorUserId: 1, email: "dev@acme.test", role: "developer" }), (e) => e.status === 409 && e.code === "already_member");
  await assert.rejects(team.createInvitation({ companyId: 7, actorUserId: 1, email: "other@elsewhere.test", role: "developer" }), (e) => e.status === 409 && e.code === "email_in_use");
  await team.createInvitation({ companyId: 7, actorUserId: 1, email: "x@acme.test", role: "developer" });
  await assert.rejects(team.createInvitation({ companyId: 7, actorUserId: 1, email: "x@acme.test", role: "developer" }), (e) => e.code === "invite_pending");
  await assert.rejects(team.createInvitation({ companyId: 7, actorUserId: 1, email: "y@acme.test", role: "superuser" }), (e) => e.code === "invalid_role");
});

test("there is no seat limit — any number of members and invites", async () => {
  maxUsers = 1;
  for (let i = 0; i < 6; i++) await team.createInvitation({ companyId: 7, actorUserId: 1, email: `m${i}@acme.test`, role: "confirmer" });
  const seats = await team.seatUsage(7);
  assert.deepEqual(seats, { max_users: null, active_users: 2, pending_invitations: 6 });
});

test("accepting creates the member with the invited role, marks the invite used and signs them in", async () => {
  await team.createInvitation({ companyId: 7, actorUserId: 1, email: "new@acme.test", role: "confirmer", firstName: "Nia" });
  await assert.rejects(team.acceptInvitation({ token: "tok-1", password: "short" }), (e) => e.code === "weak_password");
  const r = await team.acceptInvitation({ token: "tok-1", password: "long-enough-pw", lastName: "Lee" });
  assert.equal(r.user.role, "confirmer");
  assert.equal(r.user.first_name, "Nia");
  assert.deepEqual(r.user.permissions.sort(), ["confirmations.send", "copilot.use", "data.read"]);
  assert.equal(r.token, `access:${r.user.id}:confirmer`);
  assert.equal(invites[0].status, "accepted");
  await assert.rejects(team.acceptInvitation({ token: "tok-1", password: "long-enough-pw" }), (e) => e.status === 410, "single use");
});

test("an expired invitation can't be described or accepted", async () => {
  await team.createInvitation({ companyId: 7, actorUserId: 1, email: "late@acme.test", role: "developer", firstName: "L" });
  invites[0].expires_at = new Date(Date.now() - 1000);
  await assert.rejects(team.describeInvitation("tok-1"), (e) => e.status === 410 && e.code === "invitation_expired");
  await assert.rejects(team.acceptInvitation({ token: "tok-1", password: "long-enough-pw" }), (e) => e.status === 410);
  await assert.rejects(team.describeInvitation("nope"), (e) => e.status === 404);
});

test("re-inviting a REMOVED member revives their row (users.email is globally unique)", async () => {
  await team.createInvitation({ companyId: 7, actorUserId: 1, email: "gone@acme.test", role: "developer", firstName: "Gone" });
  const r = await team.acceptInvitation({ token: "tok-1", password: "long-enough-pw" });
  assert.equal(r.user.id, 3, "same row");
  const u = users.find((x) => x.id === 3);
  assert.equal(u.is_deleted, false);
  assert.equal(u.role, "developer");
  assert.equal(u.token_version, 3, "old tokens stay dead");
});

test("resend is rate-limited, revoke closes the invite", async () => {
  await team.createInvitation({ companyId: 7, actorUserId: 1, email: "r@acme.test", role: "developer" });
  const again = await team.resendInvitation({ companyId: 7, actorUserId: 1, invitationId: 1 });
  assert.equal(again.sent_count, 2);
  await assert.rejects(team.resendInvitation({ companyId: 7, actorUserId: 1, invitationId: 1 }), (e) => e.code === "resend_cooldown");
  await team.revokeInvitation({ companyId: 7, actorUserId: 1, invitationId: 1 });
  await assert.rejects(team.revokeInvitation({ companyId: 7, actorUserId: 1, invitationId: 1 }), (e) => e.status === 404);
});

// ── members ─────────────────────────────────────────────────────────────────

test("a role change bumps token_version and invalidates the cached state", async () => {
  const u = await team.updateMember({ companyId: 7, actorUserId: 1, userId: 2, role: "admin" });
  assert.equal(u.role, "admin");
  assert.equal(users.find((x) => x.id === 2).token_version, 1);
  assert.deepEqual(invalidated, [2]);
});

test("guard rails: no changing your own role, no demoting/deactivating/removing the owner, no removing yourself", async () => {
  users.find((x) => x.id === 2).role = "admin";
  await assert.rejects(team.updateMember({ companyId: 7, actorUserId: 2, userId: 2, role: "developer" }), (e) => e.code === "self_role_change");
  await assert.rejects(team.updateMember({ companyId: 7, actorUserId: 2, userId: 1, role: "developer" }), (e) => e.code === "owner_protected");
  await assert.rejects(team.updateMember({ companyId: 7, actorUserId: 2, userId: 1, active: false }), (e) => e.code === "owner_protected");
  await assert.rejects(team.removeMember({ companyId: 7, actorUserId: 2, userId: 1 }), (e) => e.code === "owner_protected");
  await assert.rejects(team.removeMember({ companyId: 7, actorUserId: 2, userId: 2 }), (e) => e.code === "self_remove");
  await assert.rejects(team.updateMember({ companyId: 7, actorUserId: 1, userId: 4, role: "developer" }), (e) => e.status === 404, "other company's user is invisible");
});

test("ownership: only the owner can transfer, and only to an active admin", async () => {
  await assert.rejects(team.transferOwnership({ companyId: 7, actorUserId: 2, actorIsOwner: false, toUserId: 1 }), (e) => e.code === "owner_only");
  await assert.rejects(team.transferOwnership({ companyId: 7, actorUserId: 1, actorIsOwner: true, toUserId: 2 }), (e) => e.code === "not_admin");
  users.find((x) => x.id === 2).role = "admin";
  await team.transferOwnership({ companyId: 7, actorUserId: 1, actorIsOwner: true, toUserId: 2 });
  assert.equal(users.find((x) => x.id === 1).is_owner, false);
  assert.equal(users.find((x) => x.id === 2).is_owner, true);
});

// ── copilot ─────────────────────────────────────────────────────────────────

test("copilot: write tools are only offered to roles that may use them, and refuse at run time otherwise", async () => {
  const registry = require("../src/copilot/tools/registry");
  assert.equal(registry.toolAllowedForRole("update_call_settings", "confirmer"), false);
  assert.equal(registry.toolAllowedForRole("update_call_settings", "developer"), true);
  assert.equal(registry.toolAllowedForRole("make_call", "confirmer"), true, "offered — the call type decides at run time");
  assert.equal(registry.toolAllowedForRole("run_scheduler", "confirmer"), false);
  assert.equal(registry.toolAllowedForRole("list_jobs", "confirmer"), true);
  assert.equal(registry.TOOL_PERMISSIONS.update_agent_config, "agent.voice");
});
