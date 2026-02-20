/**
 * Auth Middleware
 * Handles JWT verification (custom and Supabase), tenant context, and authorization helpers.
 */

const jwt = require("jsonwebtoken");
const config = require("../config");
const logger = require("../utils/logger");
const authService = require("./auth.service");

// In-memory cache for Supabase user resolution
const userCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX_SIZE = 500;

/**
 * Cache entry structure: { user, timestamp }
 */

/**
 * Get cached user or null if not found/expired
 * @param {string} supabaseUserId 
 * @returns {Object|null}
 */
function getCachedUser(supabaseUserId) {
  const entry = userCache.get(supabaseUserId);
  if (!entry) return null;
  
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    userCache.delete(supabaseUserId);
    return null;
  }
  
  return entry.user;
}

/**
 * Set user in cache
 * @param {string} supabaseUserId 
 * @param {Object} user 
 */
function setCachedUser(supabaseUserId, user) {
  // Evict oldest entries if cache is full
  if (userCache.size >= CACHE_MAX_SIZE) {
    const oldestKey = userCache.keys().next().value;
    userCache.delete(oldestKey);
  }
  
  userCache.set(supabaseUserId, {
    user,
    timestamp: Date.now(),
  });
}

/**
 * Clear user cache
 * @param {string} [supabaseUserId] - If provided, clears only that user; otherwise clears all
 */
function clearUserCache(supabaseUserId) {
  if (supabaseUserId) {
    userCache.delete(supabaseUserId);
  } else {
    userCache.clear();
  }
}

/**
 * Resolve user from Supabase JWT sub claim
 * First checks cache, then DB by supabase_id, then by email
 * @param {string} supabaseUserId - sub claim from Supabase JWT
 * @param {string} [email] - email claim from Supabase JWT (fallback)
 * @returns {Promise<Object|null>}
 */
async function resolveSupabaseUser(supabaseUserId, email) {
  // Check cache first
  const cached = getCachedUser(supabaseUserId);
  if (cached) {
    return cached;
  }

  // Try to find by supabase_id
  let user = await authService.getUserBySupabaseId(supabaseUserId);
  
  // Fallback: find by email and link supabase_id
  if (!user && email) {
    user = await authService.getUserByEmail(email);
    if (user && !user.supabase_id) {
      await authService.updateSupabaseId(user.id, supabaseUserId);
      user.supabase_id = supabaseUserId;
    }
  }

  if (user) {
    setCachedUser(supabaseUserId, user);
  }

  return user;
}

/**
 * Verify custom JWT token
 * @param {string} token 
 * @returns {Object|null} - Decoded payload or null
 */
function verifyCustomToken(token) {
  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    if (decoded.type === "access" && decoded.userId && decoded.companyId) {
      return decoded;
    }
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Verify Supabase JWT token
 * @param {string} token 
 * @returns {Object|null} - Decoded payload or null
 */
function verifySupabaseToken(token) {
  if (!config.supabase.jwtSecret) {
    return null;
  }
  
  try {
    const decoded = jwt.verify(token, config.supabase.jwtSecret);
    if (decoded.sub) {
      return decoded;
    }
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Authentication middleware
 * Extracts and verifies JWT from Authorization header
 * Populates req.user with { userId, email, companyId, role }
 */
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No authorization token provided" });
  }

  const token = authHeader.substring(7);

  // Try custom JWT first
  const customPayload = verifyCustomToken(token);
  if (customPayload) {
    req.user = {
      userId: customPayload.userId,
      email: customPayload.email,
      companyId: customPayload.companyId,
      role: customPayload.role,
    };
    return next();
  }

  // Try Supabase JWT
  const supabasePayload = verifySupabaseToken(token);
  if (supabasePayload) {
    const user = await resolveSupabaseUser(supabasePayload.sub, supabasePayload.email);
    if (user) {
      req.user = {
        userId: user.id,
        email: user.email,
        companyId: user.company_id,
        role: user.role,
      };
      return next();
    }
    logger.warn("Supabase user not found in DB", { sub: supabasePayload.sub });
  }

  return res.status(401).json({ error: "Invalid or expired token" });
}

/**
 * Optional authentication middleware
 * Like authenticate, but allows request to proceed without token
 * If token is present and valid, populates req.user
 */
async function optionalAuthenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    req.user = null;
    return next();
  }

  const token = authHeader.substring(7);

  // Try custom JWT first
  const customPayload = verifyCustomToken(token);
  if (customPayload) {
    req.user = {
      userId: customPayload.userId,
      email: customPayload.email,
      companyId: customPayload.companyId,
      role: customPayload.role,
    };
    return next();
  }

  // Try Supabase JWT
  const supabasePayload = verifySupabaseToken(token);
  if (supabasePayload) {
    const user = await resolveSupabaseUser(supabasePayload.sub, supabasePayload.email);
    if (user) {
      req.user = {
        userId: user.id,
        email: user.email,
        companyId: user.company_id,
        role: user.role,
      };
      return next();
    }
  }

  req.user = null;
  return next();
}

/**
 * Get company ID from request
 * @param {Object} req - Express request
 * @returns {string|null}
 */
function getCompanyId(req) {
  return req.user?.companyId ?? null;
}

/**
 * Get user ID from request
 * @param {Object} req - Express request
 * @returns {string|null}
 */
function getUserId(req) {
  return req.user?.userId ?? null;
}

/**
 * Middleware factory: require company ID to match
 * Ensures the company ID from a parameter/body/query matches the authenticated user's company
 * @param {string} [paramName='companyId'] - Name of the param/body/query field to check
 * @returns {Function} Express middleware
 */
function requireCompanyMatch(paramName = "companyId") {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const requestedCompanyId =
      req.params[paramName] ||
      req.body?.[paramName] ||
      req.query?.[paramName];

    if (requestedCompanyId && requestedCompanyId !== req.user.companyId) {
      logger.warn("Company ID mismatch", {
        userId: req.user.userId,
        userCompanyId: req.user.companyId,
        requestedCompanyId,
      });
      return res.status(403).json({ error: "Access denied: company mismatch" });
    }

    return next();
  };
}

/**
 * Middleware factory: require specific role(s)
 * @param {string|string[]} roles - Required role(s)
 * @returns {Function} Express middleware
 */
function requireRole(roles) {
  const allowedRoles = Array.isArray(roles) ? roles : [roles];
  
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    return next();
  };
}

module.exports = {
  authenticate,
  optionalAuthenticate,
  getCompanyId,
  getUserId,
  requireCompanyMatch,
  requireRole,
  clearUserCache,
  verifyCustomToken,
  verifySupabaseToken,
};
