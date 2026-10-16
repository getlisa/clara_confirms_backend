/**
 * Role-based access control: what each role may do.
 *
 * Three fixed roles (migration 115). Endpoints check a PERMISSION, never a role
 * name, so moving an ability between roles is a one-line change here and no
 * route changes. This map is the single source of truth; GET /auth/me returns
 * the caller's list so the frontend can hide what they can't use, but the
 * backend enforces it regardless.
 *
 *   admin      everything
 *   developer  operations: calls, syncs, CSV import, settings, agent voice/name
 *   confirmer  read everything + send confirmations (incl. confirmation calls)
 */

const PERMISSIONS = Object.freeze({
  DATA_READ:            "data.read",            // every GET
  COPILOT_USE:          "copilot.use",          // chat with the copilot (its write tools are gated individually)
  CONFIRMATIONS_SEND:   "confirmations.send",   // chat links, email/SMS links, bulk send, CONFIRMATION calls
  CALLS_MAKE:           "calls.make",           // any other outbound call, scheduling and running calls
  JOBS_EDIT:            "jobs.edit",            // create/update/reschedule jobs, appointments, customers
  SETTINGS_EDIT:        "settings.edit",        // call settings, triggers, analysis, notifications, reports, call-type enable/name
  SYNC_RUN:             "sync.run",             // CRM sync, custom-range sync, CSV import
  AGENT_VOICE:          "agent.voice",          // agent voice + representative name, Retell flow re-sync
  TODOS_MANAGE:         "todos.manage",         // todo status + assignment
  PROMPT_EDIT:          "prompt.edit",          // agent prompt editor
  AGENT_MANAGE:         "agent.manage",         // create/delete call types
  INTEGRATIONS_MANAGE:  "integrations.manage",  // connect/disconnect a CRM, credentials, webhooks
  USERS_MANAGE:         "users.manage",         // invite, change role, deactivate, remove
  COMPANY_MANAGE:       "company.manage",       // company profile, phone number
});

const ALL = Object.values(PERMISSIONS);
const P = PERMISSIONS;

const ROLE_PERMISSIONS = Object.freeze({
  admin: ALL,
  developer: [
    P.DATA_READ, P.COPILOT_USE, P.CONFIRMATIONS_SEND, P.CALLS_MAKE, P.JOBS_EDIT,
    P.SETTINGS_EDIT, P.SYNC_RUN, P.AGENT_VOICE, P.TODOS_MANAGE,
  ],
  confirmer: [P.DATA_READ, P.COPILOT_USE, P.CONFIRMATIONS_SEND],
});

const ROLES = Object.freeze(Object.keys(ROLE_PERMISSIONS));

// Call types that are confirmations: a Confirmer may place these. Any other
// call type (quotation / service-opportunity follow-ups, custom types) needs
// calls.make.
const CONFIRMATION_CALL_TYPES = new Set(["customer_confirmation", "technician_confirmation"]);

function isValidRole(role) {
  return ROLES.includes(role);
}

function permissionsFor(role) {
  return [...(ROLE_PERMISSIONS[role] || [])];
}

function hasPermission(role, permission) {
  return (ROLE_PERMISSIONS[role] || []).includes(permission);
}

/** Permission needed to place/schedule/cancel a call of this call type. */
function permissionForCallType(callType) {
  return CONFIRMATION_CALL_TYPES.has(callType) ? P.CONFIRMATIONS_SEND : P.CALLS_MAKE;
}

function forbidden(res, permission) {
  return res.status(403).json({
    error: "You don't have permission to do this",
    code: "forbidden",
    required: permission,
  });
}

/**
 * Express middleware: the caller's role (loaded fresh from the DB by
 * authenticate, not trusted from the token) must grant `permission`.
 * The permission is also attached to the function so a test can verify that
 * every write route declares one.
 */
function requirePermission(permission) {
  if (!ALL.includes(permission)) throw new Error(`Unknown permission: ${permission}`);
  const mw = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Authentication required" });
    if (!hasPermission(req.user.role, permission)) return forbidden(res, permission);
    return next();
  };
  mw.permission = permission;
  return mw;
}

/**
 * Middleware whose permission depends on the request (e.g. a confirmation call
 * vs any other call). `resolve(req)` returns a permission (or a Promise of
 * one); returning null means "let the handler validate the input first".
 */
function requireDynamicPermission(resolve, describe) {
  const mw = async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Authentication required" });
    try {
      const permission = await resolve(req);
      if (permission && !hasPermission(req.user.role, permission)) return forbidden(res, permission);
      return next();
    } catch (err) {
      return next(err);
    }
  };
  mw.permission = describe || "dynamic";
  return mw;
}

module.exports = {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLES,
  CONFIRMATION_CALL_TYPES,
  isValidRole,
  permissionsFor,
  hasPermission,
  permissionForCallType,
  requirePermission,
  requireDynamicPermission,
  forbidden,
};
