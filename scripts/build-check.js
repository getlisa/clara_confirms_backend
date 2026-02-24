/**
 * Build check: load the app and all dependencies (no DB listen).
 * Fails if any require fails or there are syntax errors.
 * Run with: npm run build
 */
process.env.VERCEL = "1";
require("dotenv").config();
require("../src/server");
console.log("Build OK");
