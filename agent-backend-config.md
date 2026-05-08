# Agent Settings — Backend Implementation Guide

## Overview

Two new API endpoints are required to support the Agent Settings configuration page.
All settings are **company-scoped** — each company has its own agent configuration.

---

## Endpoints

### `GET /agent-settings`

Returns the agent configuration for the authenticated company.

**Auth:** `Authorization: Bearer <token>`

**Response `200 OK`:**
```json
{
  "agent_settings": {
    "representative_name": "Clara",
    "begin_message": "Hi, this is Clara calling from {{company_name}}. I'm reaching out to confirm your upcoming service appointment. Is now a good time to talk?",
    "general_prompt": "You are Clara, a friendly and professional scheduling assistant...",
    "days_before_confirmation": 2
  }
}
```

**Response `401 Unauthorized`:**
```json
{ "error": "Unauthorized" }
```

---

### `PATCH /agent-settings`

Updates one or more agent config fields for the authenticated company.
All fields are optional — only provided fields should be updated (partial update).

**Auth:** `Authorization: Bearer <token>`

**Request body:**
```json
{
  "representative_name": "Clara",
  "begin_message": "Hi, this is Clara calling from {{company_name}}...",
  "general_prompt": "You are Clara, a friendly and professional...",
  "days_before_confirmation": 3
}
```

**Response `200 OK`:**
```json
{
  "agent_settings": {
    "representative_name": "Clara",
    "begin_message": "Hi, this is Clara calling from {{company_name}}...",
    "general_prompt": "You are Clara, a friendly and professional...",
    "days_before_confirmation": 3
  }
}
```

**Response `400 Bad Request`:**
```json
{ "error": "days_before_confirmation must be an integer >= 1" }
```

**Response `401 Unauthorized`:**
```json
{ "error": "Unauthorized" }
```

---

## Data Model

### Option A — Separate `agent_settings` table (recommended)

```sql
CREATE TABLE agent_settings (
  id                       SERIAL PRIMARY KEY,
  company_id               INTEGER NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  representative_name      VARCHAR,
  begin_message            TEXT,
  general_prompt           TEXT,
  days_before_confirmation INTEGER NOT NULL DEFAULT 2,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Option B — Columns on existing `companies` table

```sql
ALTER TABLE companies
  ADD COLUMN representative_name      VARCHAR,
  ADD COLUMN begin_message            TEXT,
  ADD COLUMN general_prompt           TEXT,
  ADD COLUMN days_before_confirmation INTEGER NOT NULL DEFAULT 2;
```

---

## Field Reference

| Field | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `representative_name` | `varchar` | yes | `null` | Name the agent uses when introducing itself on calls |
| `begin_message` | `text` | yes | `null` | Opening message spoken when customer picks up. Supports placeholders (see below) |
| `general_prompt` | `text` | yes | `null` | Full system prompt that drives the agent's behavior and conversation flow |
| `days_before_confirmation` | `integer` | no | `2` | How many days before the scheduled appointment the agent should place the confirmation call |

---

## Placeholder Support

The `begin_message` field supports the following placeholders that should be substituted at call time:

| Placeholder | Replaced with |
|---|---|
| `{{company_name}}` | The company's name |
| `{{customer_name}}` | The customer's name |
| `{{representative_name}}` | The value of `representative_name` from agent settings |

---

## Validation Rules

| Field | Rule |
|---|---|
| `days_before_confirmation` | Integer, minimum `1` |
| `representative_name` | String, no special format required |
| `begin_message` | Free-form text, no length restriction |
| `general_prompt` | Free-form text, no length restriction |

---

## Notes

- If no `agent_settings` row exists for a company yet, `GET /agent-settings` should return `200` with all fields as `null` (and `days_before_confirmation` as `2`), not `404`.
- `PATCH` should upsert — create the row if it doesn't exist, update if it does.
- `updated_at` should be refreshed on every `PATCH`.
