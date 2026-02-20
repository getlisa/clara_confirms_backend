/**
 * Auth module index
 * Re-exports middleware helpers, routes, and service for easy importing
 */

const authRoutes = require("./auth.routes");
const authService = require("./auth.service");
const {
  authenticate,
  optionalAuthenticate,
  getCompanyId,
  getUserId,
  requireCompanyMatch,
  requireRole,
  clearUserCache,
} = require("./auth.middleware");

module.exports = {
  // Routes
  authRoutes,
  
  // Service
  authService,
  
  // Middleware
  authenticate,
  optionalAuthenticate,
  
  // Helpers
  getCompanyId,
  getUserId,
  requireCompanyMatch,
  requireRole,
  clearUserCache,
};
