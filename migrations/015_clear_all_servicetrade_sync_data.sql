-- Clear all synced ServiceTrade data and sync state.
-- Keeps credentials/integration connection intact.

TRUNCATE TABLE
  servicetrade_contact_locations,
  servicetrade_contact_companies,
  servicetrade_assets,
  servicetrade_contacts,
  servicetrade_service_requests,
  servicetrade_locations,
  servicetrade_companies,
  servicetrade_sync_state
RESTART IDENTITY;
