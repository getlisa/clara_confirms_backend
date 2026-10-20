# Equipment & deficiencies on calls — Frontend Guide

> **For the frontend agent.** ServiceTrade equipment ("assets") now syncs. Each visit knows
> which equipment it services. On calls, Clara now:
> - mentions open deficiencies at the site, worst first, naming only the first few;
> - offers to have the technician repair them;
> - records a "yes" for the office.
>
> Three new company settings control this. There's a new Todo type, and an equipment list
> per location. Builds on `crm-sync-frontend.md` §2a (deficiencies on a job).

Applies to **voice calls and web chat** alike: the same settings, wording rules and `REPAIR_REQUESTED` Todo. The chat widget needs no changes; it just shows the messages.

Base URL: `VITE_API_URL` · Auth: `Authorization: Bearer <token>` · gate on `user.permissions`.

## 0. What to build

| # | Build | Where | Spec |
|---|---|---|---|
| 1 | **"Open deficiencies on calls" settings** (3 controls) | Call settings page | §1 |
| 2 | **Equipment on the visit card**, under Services | visit card / drawer | §2 |
| 3 | **Deficiency rows show equipment, the recommended fix and repair status** | job detail deficiencies, location deficiencies | §3 |
| 4 | **Equipment list** on the location page | location detail | §4 |
| 5 | **"Repair requested" Todo** (new type) | Todos list + detail | §5 |

---

## 1. Settings — Call settings → "Open deficiencies on calls"

Existing endpoints, three new fields. Read with `GET /call-settings` (`data.read`), save with
`PATCH /call-settings` (`settings.edit`):

```json
{ "deficiency_mention_enabled": true, "deficiency_offer_repair": true, "deficiency_mention_limit": 3 }
```

| Field | Control | Default | Rules |
|---|---|---|---|
| `deficiency_mention_enabled` | toggle **"Mention open deficiencies to the customer"** | on | boolean |
| `deficiency_offer_repair` | toggle **"Offer to repair them on the visit"**. Disable it when the toggle above is off. | on | boolean |
| `deficiency_mention_limit` | number **"How many to mention (worst first)"** | 3 | whole number 1–10 |

Helper text: *"Clara always knows every open deficiency at the site. She names the most
serious ones first, up to this number, and tells the customer about the rest only if they ask.
When she offers the repair and the customer agrees, the office gets a 'Repair requested' todo
(and a note on the ServiceTrade job when CRM comments are on)."*

- An invalid value returns `400` with `error`. Show it next to the field.
- Changing **Offer to repair** re-syncs the agent's tools. The PATCH response's existing
  `retell_sync` block reports that, as for other settings.
- The exact wording Clara uses lives in the editable prompt (prompt editor, `prompt.edit`).
  These settings are the defaults it follows.

## 2. Equipment on the visit — `GET /jobs/:id`

Each item in `appointments[].services` may now carry `equipment`:

```json
{
  "kind": "service",
  "service_line": "Alarm Systems",
  "description": "Annual fire alarm inspection",
  "asset_id": 271,
  "equipment": { "type": "alarm", "type_label": "Alarm System", "location_in_site": "Main Electrical Room" }
}
```

- `equipment` is `null` when the service names no specific equipment. That's common: about 70%
  of services don't.
- Under the visit card's **Services** section, show the equipment as a muted line under its
  service: *"Alarm System · Main Electrical Room"*. Use `type_label` and `location_in_site`
  only. **Don't show the asset name.** In ServiceTrade it contains the make and model, and the
  type plus location is the agreed way to describe equipment.
- When no service on the visit has `equipment`, show nothing. Don't invent a placeholder.

## 3. Deficiency rows — job detail and location deficiencies

`job.deficiencies[]`, `appointments[].deficiencies[]` and `GET /locations/:id/deficiencies`
items gain these fields:

```json
{
  "severity": "inoperable",
  "resolution": "out_for_repair",
  "proposed_fix": "Rebuild check valve #2",
  "equipment": { "type": "backflow", "type_label": "Backflow", "location_in_site": "Riser Room" }
}
```

| Field | Show as |
|---|---|
| `equipment` | the row's subtitle: *"Backflow · Riser Room"* |
| `proposed_fix` | *"Recommended fix: Rebuild check valve #2"*. Omit it when `null`. |
| `resolution` | a small tag: `out_for_repair` → **Repair in progress**, `out_for_quote` → **Quote sent**, `notified` → **Customer notified**. No tag for `new` or `null`. |
| `severity` | the existing severity badge (§2a of `crm-sync-frontend.md`) |

All four are `null` for InspectPoint, which carries its detail in `detail.asset_details`.

## 4. Equipment list — `GET /locations/:id/assets` (`data.read`)

```json
{
  "total": 14,
  "assets": [
    { "id": 271, "type": "alarm_device", "type_label": "Alarm Device", "location_in_site": "Corridor West",
      "service_line": "Alarm Systems", "status": "active", "open_deficiencies": 1,
      "name": "Smoke Detector with Sounder Base Corridor West", "properties": { "device_zone/address": "Zone 3" },
      "source": "servicetrade", "external_ref": "2776594149939905" }
  ]
}
```

- **Location page → "Equipment (14)" section.** Group by `service_line`. Each row shows
  `type_label`, `location_in_site`, and a red count badge when `open_deficiencies > 0`.
- Here the full `name` and `properties` may be shown in an expandable row; staff can see make
  and model. Clara never says them on a call.
- Only active, real equipment is returned. The list is empty for InspectPoint and ZenTrades
  for now. Hide the section when `total` is 0.

## 5. Todo — `REPAIR_REQUESTED`

Created when the customer agrees, on a call, to have open deficiencies repaired on the visit.
Default priority **high**.

```json
{
  "type": "REPAIR_REQUESTED",
  "priority": "high",
  "metadata": {
    "job_id": "914846", "job_number": "51430058", "appointment_id": 1254213,
    "customer_name": "Lone Star Smokehouse",
    "items": [
      "Inoperable — alarm device (Roof Access): Smoke detector failed sensitivity test. Recommended fix: Replace smoke detector head.",
      "Deficient — portable fire extinguisher (Rear Exit): Extinguisher due for 6-year maintenance."
    ],
    "notes": "Customer prefers the morning",
    "retell_call_id": "call_…"
  }
}
```

- Label it **"Repair requested"**, with a wrench icon.
- The Todo detail shows `customer_name`, a link to the job (`job_id`), the `items` as a
  bullet list, and `notes`.
- Status changes and assignment work like every other Todo.
- One Todo per job per call. If the customer adds items later in the same call, the same Todo
  is updated.

## 6. Don'ts

- Don't show make or model anywhere Clara's wording is previewed. Do show it in the staff-only
  equipment details.
- Don't treat `REPAIR_REQUESTED` as booked work. It's a request for the office to arrange.
