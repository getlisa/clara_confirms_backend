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
}

module.exports = { CrmProvider };
