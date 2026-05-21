/**
 * One-time script to provision Retell conversation flows for all existing companies.
 *
 * Run:
 *   node scripts/provision-retell-flows.js
 *
 * What it does per company:
 *   1. Seeds missing built-in call_type_configs rows (idempotent)
 *   2. Calls syncFlowForCompany — creates ConversationFlow + Agent in Retell
 *   3. Links retell_phone_number to agent if one is set on the company
 */

require("dotenv").config();
const db = require("../src/db");
const { seedBuiltins } = require("../src/db/call-type-configs");
const { syncFlowForCompany } = require("../src/services/retell-flow");
const logger = require("../src/utils/logger");

async function run() {
  const result = await db.query(
    `SELECT id, name, retell_conversation_flow_id FROM companies ORDER BY id`
  );
  const companies = result.rows;
  console.log(`\nFound ${companies.length} companies\n`);

  for (const company of companies) {
    console.log(`── Company ${company.id}: "${company.name}"`);

    if (company.retell_conversation_flow_id) {
      console.log(`   ✓ Flow already provisioned (${company.retell_conversation_flow_id}) — re-syncing to ensure up to date`);
    }

    // Step 1: Ensure built-in call types exist
    try {
      await seedBuiltins(company.id);
      console.log(`   ✓ Built-in call types seeded`);
    } catch (err) {
      console.error(`   ✗ Seed failed: ${err.message}`);
      continue;
    }

    // Step 2: Sync flow
    try {
      const res = await syncFlowForCompany(company.id);
      if (!res) {
        console.log(`   ⚠ No enabled call types — skipped (enable at least one call type first)`);
      } else {
        console.log(`   ✓ Flow: ${res.flowId}`);
        console.log(`   ✓ Agent: ${res.agentId}`);
        if (res.phoneNumber) {
          console.log(`   ✓ Phone linked: ${res.phoneNumber}`);
        } else {
          console.log(`   ⚠ No phone number set — set via PATCH /company/phone-number`);
        }
      }
    } catch (err) {
      console.error(`   ✗ Flow sync failed: ${err.message}`);
    }

    console.log("");
  }

  await db.close();
  console.log("Done.");
}

run().catch((err) => {
  console.error("Script failed:", err.message);
  process.exit(1);
});
