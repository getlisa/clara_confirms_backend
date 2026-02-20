require("dotenv").config();

module.exports = {
  port: parseInt(process.env.PORT || "3000", 10),
  nodeEnv: process.env.NODE_ENV || "development",
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
};
