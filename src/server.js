/**
 * Clara Confirms Backend Server
 * Express application with auth routes and multi-tenancy support
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const config = require("./config");
const logger = require("./utils/logger");
const db = require("./db");
const { authRoutes } = require("./auth");
const companyRoutes = require("./routes/company");
const usersRoutes = require("./routes/users");
const customersRoutes = require("./routes/customers");
const jobsRoutes = require("./routes/jobs");
const locationsRoutes = require("./routes/locations");
const serviceOpportunitiesRoutes = require("./routes/service-opportunities");
const servicetradeRoutes = require("./routes/servicetrade");
const agentSettingsRoutes = require("./routes/agent-settings");
const retellRoutes = require("./routes/retell");
const todosRoutes = require("./routes/todos");
const callsRoutes = require("./routes/calls");
const callSettingsRoutes = require("./routes/call-settings");
const campaignsRoutes = require("./routes/campaigns");
const scheduledCallsRoutes = require("./routes/scheduled-calls");
const testRoutes = require("./routes/test");
const schedulerRoutes = require("./routes/scheduler");
const retellToolsRoutes = require("./routes/retell-tools");
const callAnalysisConfigsRoutes = require("./routes/call-analysis-configs");
const dashboardRoutes = require("./routes/dashboard");
const dynamicVariablesRoutes = require("./routes/dynamic-variables");
const adminRoutes = require("./routes/admin");
const enginesRoutes = require("./routes/engines");
const manualCallsRoutes = require("./routes/manual-calls");
const copilotRoutes = require("./routes/copilot");
const onboardingRoutes = require("./routes/onboarding");

const app = express();

// ============================================================================
// Middleware
// ============================================================================

// CORS — MUST be before body parsers so OPTIONS preflight gets headers (see collection_agent_backend)
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim())
  : [
      "http://localhost:8080",
      "http://localhost:5173",
      "http://127.0.0.1:8080",
      "http://127.0.0.1:5173",
      config.frontendUrl,
    ].filter(Boolean);
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Accept",
    ],
  })
);

// Retell webhook — mounted BEFORE body parsers so it can read the raw stream for signature verification
app.use("/retell", retellRoutes);

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    logger.debug(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// ============================================================================
// Routes
// ============================================================================

// Health check
app.get("/health", async (req, res) => {
  try {
    logger.debug("Health check");
    const dbHealthy = await db.checkConnection();
    if (!dbHealthy) {
      return res.status(503).json({
        status: "unhealthy",
        database: "disconnected",
      });
    }
    return res.json({
      status: "healthy",
      database: "connected",
      timestamp: new Date().toISOString(),
      environment: config.nodeEnv,
    });
  } catch (err) {
    logger.error("Health check failed", { error: err.message });
    return res.status(503).json({
      status: "unhealthy",
      error: err.message,
    });
  }
});

// Auth routes
app.use("/auth", authRoutes);

// Company (tenant) routes - requires auth
app.use("/company", companyRoutes);

// Users routes - requires auth (admin for most operations)
app.use("/users", usersRoutes);

// Customers - requires auth
app.use("/customers", customersRoutes);

// Jobs & Appointments - requires auth
app.use("/jobs", jobsRoutes);

// Locations (ServiceTrade-synced platform data) - requires auth
app.use("/locations", locationsRoutes);

// Service opportunities (unbooked ServiceTrade service requests) - requires auth
app.use("/service-opportunities", serviceOpportunitiesRoutes);

// ServiceTrade integration - requires auth
app.use("/integrations/servicetrade", servicetradeRoutes);

// Agent settings - requires auth
app.use("/agent-settings", agentSettingsRoutes);

// Todos (post-call action items) - requires auth
app.use("/todos", todosRoutes);

// Calls history - requires auth
app.use("/calls", callsRoutes);

// Call settings (office hours, attempts, voicemail) - requires auth
app.use("/call-settings", callSettingsRoutes);

// Campaigns — the single config entity (trigger + agent). Requires auth.
// (Supersedes the former /call-triggers route.)
app.use("/campaigns", campaignsRoutes);
// Onboarding — server-side new-company setup orchestration. Requires auth.
app.use("/onboarding", onboardingRoutes);

// Scheduled calls queue (view + cancel) - requires auth
app.use("/scheduled-calls", scheduledCallsRoutes);

// Test call trigger - requires auth
app.use("/test", testRoutes);

// Scheduler cron endpoints - protected by CRON_SECRET
app.use("/scheduler", schedulerRoutes);

// Retell tool webhooks - called by Retell during live calls, protected by RETELL_TOOL_SECRET
app.use("/retell/tools", retellToolsRoutes);

// Call analysis priority configs - requires auth
app.use("/call-analysis-configs", callAnalysisConfigsRoutes);

// Dashboard stats - requires auth
app.use("/dashboard", dashboardRoutes);

// Dynamic variables catalog - read-only reference, requires auth
app.use("/dynamic-variables", dynamicVariablesRoutes);

// Admin one-off actions - protected by CRON_SECRET (no JWT auth)
app.use("/admin", adminRoutes);

// Workflow-engine runs (CRM sync, scheduler-run, ...) — JWT for control,
// signed query-string token for SSE stream.
app.use("/engines", enginesRoutes);

// Manual call trigger — UI "Call now" button for any call_type.
app.use("/calls/manual", manualCallsRoutes);

// AI Copilot — embedded assistant. JWT for control endpoints, signed
// query-string token for the SSE turn stream.
app.use("/copilot", copilotRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error("Unhandled error", { error: err.message, stack: err.stack });
  res.status(err.status || 500).json({
    error: config.nodeEnv === "production" ? "Internal server error" : err.message,
  });
});

// ============================================================================
// Server Startup
// ============================================================================

async function start() {
  try {
    // Verify database connection
    const dbConnected = await db.checkConnection();
    if (!dbConnected) {
      throw new Error("Database connection failed");
    }
    logger.info("Database connected");
    logger.info("Hi, Welcome!")

    // Start HTTP server
    app.listen(config.port, () => {
      logger.info(`Server started on port ${config.port}`);
      logger.info(`Environment: ${config.nodeEnv}`);
      logger.info(`Frontend URL: ${config.frontendUrl}`);
    });
  } catch (err) {
    logger.error("Failed to start server", { error: err.message });
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on("SIGTERM", async () => {
  logger.info("SIGTERM received, shutting down gracefully");
  await db.close();
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.info("SIGINT received, shutting down gracefully");
  await db.close();
  process.exit(0);
});

if (process.env.VERCEL !== "1") {
  start();
}

module.exports = app;
