/**
 * Place a test call via Retell.
 *
 * Usage:
 *   node scripts/test-call.js --to=+14155550100 --company=3 --type=customer_confirmation
 *   node scripts/test-call.js --to=+14155550100   (uses RETELL_TEST_COMPANY_ID env or prompts)
 *
 * All flags are optional if env vars are set:
 *   RETELL_TEST_TO_NUMBER      — destination phone (E.164)
 *   RETELL_TEST_COMPANY_ID     — company ID
 *   RETELL_TEST_CALL_TYPE      — call type slug (default: customer_confirmation)
 */

require("dotenv").config();
const { createCall } = require("../src/services/retell");
const db = require("../src/db");

function arg(name) {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.split("=").slice(1).join("=") : null;
}

async function run() {
  const toNumber  = arg("to")      || process.env.RETELL_TEST_TO_NUMBER;
  const companyId = arg("company") || process.env.RETELL_TEST_COMPANY_ID;
  const callType  = arg("type")    || process.env.RETELL_TEST_CALL_TYPE || "customer_confirmation";

  if (!toNumber) {
    console.error("Error: destination number is required.\n  --to=+14155550100  or  RETELL_TEST_TO_NUMBER=+14155550100");
    process.exit(1);
  }
  if (!companyId) {
    console.error("Error: company ID is required.\n  --company=3  or  RETELL_TEST_COMPANY_ID=3");
    process.exit(1);
  }

  // Verify the call type exists for this company
  const { rows } = await db.query(
    `SELECT c.name AS company_name, c.retell_phone_number, ctc.name AS call_type_name
     FROM companies c
     JOIN call_type_configs ctc ON ctc.company_id = c.id
     WHERE c.id = $1 AND ctc.type = $2`,
    [companyId, callType]
  );

  if (rows.length === 0) {
    console.error(`Error: call_type '${callType}' not found for company ${companyId}`);
    process.exit(1);
  }

  const { company_name, retell_phone_number, call_type_name } = rows[0];

  console.log(`\nPlacing test call`);
  console.log(`  Company   : ${company_name} (id=${companyId})`);
  console.log(`  From      : ${retell_phone_number ?? "(auto)"}`);
  console.log(`  To        : ${toNumber}`);
  console.log(`  Call type : ${call_type_name} (${callType})\n`);

  const call = await createCall({
    toNumber,
    companyId: Number(companyId),
    callType,
    dynamicVariables: {
      customer_name: "Test Customer",
      job_date:      new Date(Date.now() + 86400000).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }),
      job_id:        "TEST-001",
    },
    metadata: { is_test: true },
  });

  console.log("✓ Call initiated");
  console.log(`  Retell call ID : ${call.call_id}`);
  console.log(`  Status         : ${call.call_status}`);
  console.log(`  Agent ID       : ${call.agent_id}`);

  await db.close();
}

run().catch(async (err) => {
  console.error("✗ Call failed:", err.message);
  await db.close();
  process.exit(1);
});
