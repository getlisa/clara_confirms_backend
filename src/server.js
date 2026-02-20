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

start();

module.exports = app;
