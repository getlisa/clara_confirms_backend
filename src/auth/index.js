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
  invalidateUserState,
} = require("./auth.middleware");
const permissions = require("./permissions");

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
  invalidateUserState,

  // Role-based permissions (src/auth/permissions.js)
  PERMISSIONS: permissions.PERMISSIONS,
  requirePermission: permissions.requirePermission,
  requireDynamicPermission: permissions.requireDynamicPermission,
  hasPermission: permissions.hasPermission,
  permissionsFor: permissions.permissionsFor,
};
