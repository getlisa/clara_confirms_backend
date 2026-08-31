-- Click tracking for the chat widget's "Powered by Clara AI" footer link.
-- Not unique on chat_link_token — a customer can click more than once in
-- one session, and each click is a real, separate event worth counting,
-- not session state to overwrite. company_id is denormalized onto the row
-- (same call confirmation_events makes) so a per-company rollup never needs
-- to join back through chat_links.
CREATE TABLE IF NOT EXISTS chat_footer_link_clicks (
  id BIGSERIAL PRIMARY KEY,
  chat_link_token TEXT NOT NULL REFERENCES chat_links(token) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  clicked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_footer_link_clicks_company_time_idx
  ON chat_footer_link_clicks (company_id, clicked_at);
