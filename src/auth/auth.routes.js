/**
 * Auth Routes
 * All authentication endpoints: register, login, refresh, me, change-password,
 * forgot-password, magic-link, reset-password, logout
 */

const express = require("express");
const jwt = require("jsonwebtoken");
const authService = require("./auth.service");
const { authenticate, clearUserCache } = require("./auth.middleware");
const config = require("../config");
const logger = require("../utils/logger");
const { sendMail, buildEmailTemplate } = require("../utils/email");

const router = express.Router();

const EMAIL_LINK_EXPIRES_IN = "15m";
const PASSWORD_RESET_EXPIRES_IN = "1h";

/**
 * POST /auth/register
 * Create a new company and user
 * Body: { email, password, name, companyName }
 */
router.post("/register", async (req, res) => {
  try {
    const { email, password, name, companyName } = req.body;

    if (!email || !password || !name || !companyName) {
      return res.status(400).json({
        error: "Email, password, name, and company name are required",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: "Password must be at least 6 characters",
      });
    }

    const result = await authService.register({ email, password, name, companyName });

    return res.status(201).json({
      message: "Registration successful",
      user: result.user,
      token: result.token,
      refreshToken: result.refreshToken,
    });
  } catch (err) {
    logger.error("Registration failed", { error: err.message });
    return res.status(err.status || 500).json({
      error: err.message || "Registration failed",
    });
  }
});

/**
 * POST /auth/login
 * Login with email and password
 * Body: { email, password }
 */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password are required",
      });
    }

    const result = await authService.login(email, password);

    return res.json({
      message: "Login successful",
      user: result.user,
      token: result.token,
      refreshToken: result.refreshToken,
    });
  } catch (err) {
    logger.warn("Login failed", { email: req.body.email?.substring(0, 3) + "***", error: err.message });
    return res.status(err.status || 500).json({
      error: err.message || "Login failed",
    });
  }
});

/**
 * POST /auth/refresh
 * Refresh access token using refresh token
 * Body: { refreshToken }
 */
router.post("/refresh", async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({
        error: "Refresh token is required",
      });
    }

    const result = await authService.refresh(refreshToken);

    return res.json({
      token: result.token,
      refreshToken: result.refreshToken,
      user: result.user,
    });
  } catch (err) {
    logger.warn("Token refresh failed", { error: err.message });
    return res.status(err.status || 500).json({
      error: err.message || "Token refresh failed",
    });
  }
});

/**
 * GET /auth/me
 * Get current user info
 * Requires: Authorization header
 */
router.get("/me", authenticate, async (req, res) => {
  try {
    const user = await authService.getUserById(req.user.userId);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.json({ user });
  } catch (err) {
    logger.error("Failed to get user", { userId: req.user.userId, error: err.message });
    return res.status(500).json({ error: "Failed to get user" });
  }
});

/**
 * PATCH /auth/profile
 * Update current user profile (first_name, last_name, email)
 * Requires: Authorization header
 * Body: { first_name?, last_name?, email? }
 */
router.patch("/profile", authenticate, async (req, res) => {
  try {
    const { first_name, last_name, email } = req.body;
    const user = await authService.updateProfile(req.user.userId, { first_name, last_name, email });
    return res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
        company_id: user.company_id,
        company_name: user.company_name,
      },
    });
  } catch (err) {
    logger.warn("Profile update failed", { userId: req.user.userId, error: err.message });
    return res.status(err.status || 500).json({
      error: err.message || "Profile update failed",
    });
  }
});

/**
 * POST /auth/change-password
 * Change current user's password
 * Requires: Authorization header
 * Body: { currentPassword, newPassword }
 */
router.post("/change-password", authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        error: "Current password and new password are required",
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        error: "New password must be at least 6 characters",
      });
    }

    await authService.changePassword(req.user.userId, currentPassword, newPassword);

    return res.json({ message: "Password changed successfully" });
  } catch (err) {
    logger.warn("Password change failed", { userId: req.user.userId, error: err.message });
    return res.status(err.status || 500).json({
      error: err.message || "Password change failed",
    });
  }
});

/**
 * POST /auth/forgot-password
 * Send password reset email via SendGrid (from: Clara Confirms <developer@justclara.ai>)
 * Body: { email }
 */
router.post("/forgot-password", async (req, res) => {
  const successMessage = "If an account exists with this email, you will receive a password reset link.";

  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const normalized = String(email).trim().toLowerCase();
    const user = await authService.getUserByEmail(normalized);

    if (!user) {
      logger.debug("Forgot password for non-existent email", { email: normalized.substring(0, 3) + "***" });
      return res.json({ message: successMessage });
    }

    const token = jwt.sign(
      { email: normalized, type: "password_reset" },
      config.jwt.secret,
      { expiresIn: PASSWORD_RESET_EXPIRES_IN }
    );
    const link = `${config.frontendUrl}/reset-password?token=${encodeURIComponent(token)}`;

    const userName = user.first_name || (user.name && user.name.split(/\s+/)[0]) || null;
    const html = buildEmailTemplate({
      userName,
      companyName: user.company_name || "Clara Confirms",
      title: "You requested a password reset.",
      bodyHtml: "<p>Click the button below to set a new password. This link expires in 1 hour.</p>",
      buttonText: "Reset password",
      buttonUrl: link,
      footerText: "If you didn't request this, you can safely ignore this email.",
    });

    await sendMail({
      to: normalized,
      subject: "Reset your password – Clara Confirms",
      text: `Hey${userName ? ` ${userName}` : ""}! You requested a password reset. Use this link to set a new password: ${link}\n\nThe link expires in 1 hour.`,
      html,
    });

    logger.info("Forgot password email sent", { email: normalized.substring(0, 3) + "***" });
    return res.json({ message: successMessage });
  } catch (err) {
    logger.error("Forgot password failed", { error: err.message });
    return res.json({ message: successMessage });
  }
});

/**
 * POST /auth/magic-link
 * Send sign-in email link via SendGrid (from: Clara Confirms <developer@justclara.ai>)
 * Body: { email }
 */
router.post("/magic-link", async (req, res) => {
  const successMessage = "If an account exists with this email, you will receive a sign-in link.";

  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const normalized = String(email).trim().toLowerCase();
    const user = await authService.getUserByEmail(normalized);

    if (!user) {
      logger.debug("Magic link for non-existent email", { email: normalized.substring(0, 3) + "***" });
      return res.json({ message: successMessage });
    }

    const token = jwt.sign(
      { email: normalized, type: "email_link" },
      config.jwt.secret,
      { expiresIn: EMAIL_LINK_EXPIRES_IN }
    );
    const link = `${config.frontendUrl}/auth/link-login?token=${encodeURIComponent(token)}`;

    const userName = user.first_name || (user.name && user.name.split(/\s+/)[0]) || null;
    const html = buildEmailTemplate({
      userName,
      companyName: user.company_name || "Clara Confirms",
      title: "You requested a sign-in link.",
      bodyHtml: "<p>Click the button below to sign in to your account. This link expires in 15 minutes.</p>",
      buttonText: "Sign in to Clara Confirms",
      buttonUrl: link,
      footerText: "If you didn't request this, you can safely ignore this email.",
    });

    await sendMail({
      to: normalized,
      subject: "Sign in to Clara Confirms",
      text: `Hey${userName ? ` ${userName}` : ""}! Sign in by opening this link: ${link}\n\nThe link expires in 15 minutes.`,
      html,
    });

    logger.info("Magic link sent", { email: normalized.substring(0, 3) + "***" });
    return res.json({ message: successMessage });
  } catch (err) {
    logger.error("Magic link failed", { error: err.message });
    return res.json({ message: successMessage });
  }
});

/**
 * POST /auth/verify-email-link
 * Exchange email link token for access + refresh tokens
 * Body: { token }
 */
router.post("/verify-email-link", async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: "Token is required" });
    }

    const decoded = jwt.verify(token, config.jwt.secret);
    if (decoded.type !== "email_link" || !decoded.email) {
      return res.status(400).json({ error: "Invalid or expired link" });
    }

    const user = await authService.getUserByEmail(decoded.email);
    if (!user || !user.active) {
      return res.status(400).json({ error: "Invalid or expired link" });
    }

    const tokenPayload = {
      userId: user.id,
      email: user.email,
      companyId: user.company_id,
      role: user.role,
    };
    const accessToken = authService.generateAccessToken(tokenPayload);
    const refreshToken = authService.generateRefreshToken(tokenPayload);

    return res.json({
      message: "Sign-in successful",
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
        company_id: user.company_id,
        company_name: user.company_name,
      },
      token: accessToken,
      refreshToken,
    });
  } catch (err) {
    if (err.name === "TokenExpiredError" || err.name === "JsonWebTokenError") {
      return res.status(400).json({ error: "Invalid or expired link" });
    }
    logger.error("Verify email link failed", { error: err.message });
    return res.status(500).json({ error: "Verification failed" });
  }
});

/**
 * POST /auth/reset-password
 * Reset password using token from email (SendGrid link)
 * Body: { token } or { access_token }, and { new_password }
 */
router.post("/reset-password", async (req, res) => {
  try {
    const token = req.body.token || req.body.access_token;
    const newPassword = req.body.new_password || req.body.newPassword;

    if (!token || !newPassword) {
      return res.status(400).json({
        error: "Token and new password are required",
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        error: "Password must be at least 6 characters",
      });
    }

    let email;
    try {
      const decoded = jwt.verify(token, config.jwt.secret);
      if (decoded.type !== "password_reset" || !decoded.email) {
        throw new Error("Invalid token type");
      }
      email = decoded.email;
    } catch (e) {
      return res.status(400).json({ error: "Invalid or expired reset token" });
    }

    const user = await authService.getUserByEmail(email);
    if (!user) {
      return res.status(400).json({ error: "Invalid or expired reset token" });
    }

    await authService.updatePasswordByEmail(email, newPassword);
    clearUserCache(user.id);

    logger.info("Password reset successful", { email: email.substring(0, 3) + "***" });
    return res.json({ message: "Password reset successful" });
  } catch (err) {
    logger.error("Password reset failed", { error: err.message });
    return res.status(err.status || 500).json({
      error: err.message || "Password reset failed",
    });
  }
});

/**
 * POST /auth/logout
 * Logout (client-side token removal)
 * Requires: Authorization header
 */
router.post("/logout", authenticate, (req, res) => {
  logger.info("User logged out", { userId: req.user.userId });
  return res.json({ message: "Logout successful" });
});

// ============================================================================
// Supabase API Helpers
// ============================================================================

/**
 * Create a user in Supabase Auth
 * @param {string} email 
 * @returns {Promise<Object|null>} Created user or null
 */
async function createSupabaseUser(email) {
  if (!config.supabase.url || !config.supabase.serviceRoleKey) {
    logger.warn("Supabase not configured, skipping user creation");
    return null;
  }

  try {
    const response = await fetch(`${config.supabase.url}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": config.supabase.serviceRoleKey,
        "Authorization": `Bearer ${config.supabase.serviceRoleKey}`,
      },
      body: JSON.stringify({
        email,
        email_confirm: true,
        password: generateRandomPassword(),
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      logger.warn("Failed to create Supabase user", { email: email.substring(0, 3) + "***", error: err });
      return null;
    }

    return await response.json();
  } catch (err) {
    logger.error("Supabase user creation error", { error: err.message });
    return null;
  }
}

/**
 * Send password recovery email via Supabase
 * @param {string} email 
 * @param {string} redirectTo 
 */
async function sendSupabaseRecovery(email, redirectTo) {
  if (!config.supabase.url || !config.supabase.serviceRoleKey) {
    logger.warn("Supabase not configured, skipping recovery email");
    return;
  }

  const response = await fetch(`${config.supabase.url}/auth/v1/recover`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": config.supabase.serviceRoleKey,
    },
    body: JSON.stringify({
      email,
      redirect_to: redirectTo,
    }),
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.message || "Failed to send recovery email");
  }
}

/**
 * Send magic link email via Supabase
 * @param {string} email 
 * @param {string} redirectTo 
 */
async function sendSupabaseMagicLink(email, redirectTo) {
  if (!config.supabase.url || !config.supabase.serviceRoleKey) {
    logger.warn("Supabase not configured, skipping magic link");
    return;
  }

  const response = await fetch(`${config.supabase.url}/auth/v1/magiclink`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": config.supabase.serviceRoleKey,
    },
    body: JSON.stringify({
      email,
      redirect_to: redirectTo,
    }),
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.message || "Failed to send magic link");
  }
}

/**
 * Update user password in Supabase using their access token
 * @param {string} accessToken - Supabase access token from reset link
 * @param {string} newPassword 
 * @returns {Promise<Object>} User data { id, email }
 */
async function updateSupabasePassword(accessToken, newPassword) {
  if (!config.supabase.url) {
    throw new Error("Supabase not configured");
  }

  const apiKey = config.supabase.anonKey || config.supabase.serviceRoleKey;
  if (!apiKey) {
    throw new Error("Supabase API key not configured");
  }

  const response = await fetch(`${config.supabase.url}/auth/v1/user`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "apikey": apiKey,
      "Authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      password: newPassword,
    }),
  });

  if (!response.ok) {
    const err = await response.json();
    const error = new Error(err.error_description || err.message || "Failed to reset password");
    error.status = response.status;
    throw error;
  }

  return await response.json();
}

/**
 * Generate a random password for Supabase user creation
 * @returns {string}
 */
function generateRandomPassword() {
  return require("crypto").randomBytes(32).toString("hex");
}

module.exports = router;
