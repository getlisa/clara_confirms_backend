-- Require an explicit customer confirmation of the email before a service
-- link is resolved or sent.
--
-- resolve_service_link_contact doesn't just pick a send target: when no
-- existing contact matches the address, it CREATES one in ServiceTrade. So
-- acting on an address the customer never confirmed writes a junk contact into
-- their CRM and mails a job link to whoever owns it. On a voice call, where
-- the address arrives via transcription, that risk is higher than in chat.
--
-- Both prompts already asked the agent to read the address back, but a prompt
-- is advisory — the model can skip straight to the tool. The handlers now
-- refuse unless email_confirmed is true, and this exposes the parameter so the
-- model can actually set it. Without this the tool would be permanently
-- un-callable on voice.
--
-- Paired with the guards in routes/retell-tools.js and
-- confirmation-agent/tools/handlers/resolve-service-link-contact.js.

UPDATE tool_definitions
   SET parameters = '{
         "type": "object",
         "required": ["email", "email_confirmed"],
         "properties": {
           "email": {
             "type": "string",
             "description": "The email address to send the service link to. Required on every call."
           },
           "email_confirmed": {
             "type": "boolean",
             "description": "Set true ONLY after the customer has explicitly confirmed this exact address out loud — either agreeing to the one you read back to them, or giving you a new one. Never set true for an address you inferred, remembered, or read from context without asking. If it is false the tool will refuse and tell you to ask."
           },
           "first_name": {
             "type": "string",
             "description": "First name — only include on a second call, after a first call returned need_more_info."
           },
           "last_name": {
             "type": "string",
             "description": "Last name — only include on a second call, after a first call returned need_more_info."
           },
           "role": {
             "type": "string",
             "description": "The contact''s role/type as stated by the customer, e.g. management, billing, on-site — only include on a second call, after a first call returned need_more_info."
           }
         }
       }'::jsonb,
       description = 'Resolve who should receive the service link. BEFORE calling this, read the email address back to the customer and get an explicit yes — then call with email_confirmed=true. Calling with email_confirmed=false (or omitting it) returns status "needs_email_confirmation" and does nothing else. Pass only email + email_confirmed on your first call. The tool searches for an existing contact by that email automatically: if found, it is used immediately (you do not need to provide name/role) and the response status is "found". If no existing contact matches, the response status is "need_more_info" — only then ask the customer for their first_name, last_name, and role, and call again including those fields to create a new contact (status "created"). Never call twice with the same information; only call again once you have new fields to add, or a corrected email.'
 WHERE name = 'resolve_service_link_contact';
