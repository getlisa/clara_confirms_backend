/**
 * Minimal US/CA phone normalizer — no external dependency.
 * ServiceTrade sends phone numbers in a variety of loose formats
 * ("(321) 555-5623", "530-867-5309", ""); the platform stores E.164.
 */
function toE164(raw, defaultCountry = "US") {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;

  if (digits.length === 10 && (defaultCountry === "US" || defaultCountry === "CA")) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  if (String(raw).trim().startsWith("+")) {
    return `+${digits}`;
  }
  // Unrecognized shape — return null rather than store something invalid as if it were E.164.
  return null;
}

module.exports = { toE164 };
