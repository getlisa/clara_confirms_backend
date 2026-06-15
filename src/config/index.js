require("dotenv").config();

const nodeEnv = process.env.NODE_ENV || "development";
const isProd = nodeEnv === "production";

/**
 * Resolve the Retell webhook base URL for the current environment.
 * Production: RETELL_WEBHOOK_URL_PROD (e.g. https://api.justclara.ai)
 * Development: RETELL_WEBHOOK_URL_DEV (e.g. https://xxx.ngrok-free.dev)
 * Fallback: RETELL_WEBHOOK_URL (legacy single-env config)
 *
 * Stored as the full webhook path (.../retell/webhook). Tool URLs strip the
 * /retell/webhook suffix to derive the base.
 */
function resolveRetellWebhookUrl() {
  const envSpecific = isProd
    ? process.env.RETELL_WEBHOOK_URL_PROD
    : process.env.RETELL_WEBHOOK_URL_DEV;
  return envSpecific || process.env.RETELL_WEBHOOK_URL || "";
}

module.exports = {
  port: parseInt(process.env.PORT || "3000", 10),
  nodeEnv,
  isProd,
  database: {
    url:
      process.env.DATABASE_URL ||
      "postgresql://localhost:5432/postgres",
    poolMin: parseInt(process.env.DATABASE_POOL_MIN || "2", 10),
    poolMax: parseInt(process.env.DATABASE_POOL_MAX || "10", 10),
  },
  jwt: {
    secret: process.env.JWT_SECRET || "your-jwt-secret-change-in-production",
    expiresIn: process.env.JWT_EXPIRES_IN || "1h",
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    jwtSecret: process.env.SUPABASE_JWT_SECRET,
  },
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:8080",
  sendgrid: {
    apiKey: process.env.SENDGRID_API_KEY || "",
    fromEmail: process.env.SENDGRID_FROM_EMAIL || "developer@justclara.ai",
    fromName: process.env.SENDGRID_FROM_NAME || "Clara Confirms",
  },
  servicetrade: {
    baseUrl: (process.env.SERVICETRADE_BASE_URL || "https://api.servicetrade.com/api").replace(/\/$/, ""),
    username: process.env.SERVICETRADE_USERNAME || "",
    password: process.env.SERVICETRADE_PASSWORD || "",
  },
  copilot: {
    // LLM providers — failover order is openai → groq (see src/copilot/graph/model.js)
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    openaiModel:  process.env.COPILOT_OPENAI_MODEL || "gpt-4.1",
    groqApiKey:   process.env.GROQ_API_KEY || "",
    groqModel:    process.env.COPILOT_GROQ_MODEL || "llama-3.3-70b-versatile",
    // LangSmith tracing is enabled purely via env (LANGCHAIN_TRACING_V2, LANGCHAIN_API_KEY,
    // LANGCHAIN_PROJECT) which the LangChain SDK reads directly — no wiring needed here.
  },
  retell: {
    apiKey: process.env.RETELL_API_KEY || "",
    webhookSecret: process.env.RETELL_WEBHOOK_SECRET || "",
    defaultVoiceId: process.env.RETELL_DEFAULT_VOICE_ID || "11labs-Adrian",
    // Environment-aware: picks _PROD or _DEV variant based on NODE_ENV, falls back to legacy single var
    webhookUrl: resolveRetellWebhookUrl(),
    toolSecret: process.env.RETELL_TOOL_SECRET || "",
    // Phone number auto-purchase settings
    phoneAreaCode: process.env.RETELL_PHONE_AREA_CODE
      ? parseInt(process.env.RETELL_PHONE_AREA_CODE, 10)
      : undefined,
    phoneCountryCode: process.env.RETELL_PHONE_COUNTRY_CODE || "US",
  },
};
