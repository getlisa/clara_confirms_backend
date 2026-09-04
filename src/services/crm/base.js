/**
 * Base class for CRM providers. Lives in a separate file so concrete
 * providers can import it without creating a circular dependency with
 * the registry in index.js.
 */

class CrmProvider {
  get slug() { throw new Error("CrmProvider subclass must define get slug()"); }
  get supportedEntities() { return []; }

  async authenticate(_companyId, _credentials) {
    throw new Error(`${this.slug}: authenticate() not implemented`);
  }

  async request(_companyId, _method, _path, _opts) {
    throw new Error(`${this.slug}: request() not implemented`);
  }

  async syncAll(_companyId) {
    throw new Error(`${this.slug}: syncAll() not implemented`);
  }

  async syncEntity(_companyId, _entityType) {
    throw new Error(`${this.slug}: syncEntity() not implemented`);
  }

  normalizeUser(_rawRow)           { return null; }
  normalizeCompany(_rawRow)        { return null; }
  normalizeServiceRequest(_rawRow) { return null; }
  normalizeContact(_rawRow)        { return null; }
  normalizeQuote(_rawRow)          { return null; }

  // ── CRM write-back mirrors ──────────────────────────────────────────────
  //
  // Called by BOTH the chat agent (confirmation-agent/actions.js) and the
  // voice agent (routes/retell-tools.js, routes/retell.js), which resolve the
  // provider from a job/appointment's own `source` column via
  // crm/index.js's getProviderForSource() rather than importing a concrete
  // CRM module directly. Default no-op: a provider that doesn't implement one
  // (or a row with no CRM source at all) is simply not mirrored — the
  // platform is always the system of record regardless.
  async mirrorRescheduleAppointment(_companyId, _appointment, _opts) { return { skipped: "not_supported" }; }
  async mirrorCreateAppointment(_companyId, _appointment, _platformJobId, _opts) { return { skipped: "not_supported" }; }
  async mirrorRescheduleJob(_companyId, _job, _opts) { return { skipped: "not_supported" }; }
  async mirrorCancelAppointment(_companyId, _appointment, _opts) { return { skipped: "not_supported" }; }
  async mirrorCancelJob(_companyId, _job, _opts) { return { skipped: "not_supported" }; }
  async mirrorPostChatComment(_companyId, _params) { return { skipped: "not_supported" }; }
  async mirrorPostCallComment(_companyId, _params) { return { skipped: "not_supported" }; }
}

module.exports = { CrmProvider };
