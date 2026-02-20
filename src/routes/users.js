/**
 * Users Routes
 * Handles user management within a company (list, invite, update, delete).
 * All routes require authentication and are scoped to the user's company.
 */

const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");
const config = require("../config");
const logger = require("../utils/logger");
const { authenticate, requireRole } = require("../auth/auth.middleware");
const { sendMail, buildEmailTemplate } = require("../utils/email");

const router = express.Router();

/**
 * GET /users
 * List all users in the authenticated user's company
 */
router.get("/", authenticate, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, email, first_name, last_name, role, active, created_at, last_login
       FROM users
       WHERE company_id = $1
       ORDER BY created_at ASC`,
      [req.user.companyId]
    );

    const users = result.rows.map((row) => ({
      id: row.id,
      email: row.email,
      first_name: row.first_name,
      last_name: row.last_name,
      name: [row.first_name, row.last_name].filter(Boolean).join(" ").trim(),
      role: row.role,
      active: row.active,
      created_at: row.created_at,
      last_login: row.last_login,
    }));

    return res.json({ users });
  } catch (err) {
    logger.error("Failed to list users", { error: err.message });
    return res.status(500).json({ error: "Failed to list users" });
  }
});

/**
 * POST /users/invite
 * Invite a new user to the company
 * Body: { email, first_name, last_name, role }
 * Admin only
 */
router.post("/invite", authenticate, requireRole("admin"), async (req, res) => {
  try {
    const { email, first_name, last_name, role } = req.body;

    if (!email || !first_name) {
      return res.status(400).json({ error: "Email and first name are required" });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const userRole = role === "admin" ? "admin" : "user";

    // Check if email already exists in any company
    const existing = await db.query(
      "SELECT id FROM users WHERE email = $1",
      [normalizedEmail]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "Email is already registered" });
    }

    // Get company name for the email
    const companyResult = await db.query(
      "SELECT name FROM companies WHERE id = $1",
      [req.user.companyId]
    );
    const companyName = companyResult.rows[0]?.name || "Clara Confirms";

    // Insert user without password (invited, pending setup)
    const insertResult = await db.query(
      `INSERT INTO users (company_id, email, first_name, last_name, role, active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id, email, first_name, last_name, role, active, created_at`,
      [req.user.companyId, normalizedEmail, first_name.trim(), (last_name || "").trim(), userRole]
    );
    const newUser = insertResult.rows[0];

    // Generate invite token (7-day expiry, type: invite)
    const inviteToken = jwt.sign(
      {
        email: normalizedEmail,
        companyId: req.user.companyId,
        type: "invite",
      },
      config.jwt.secret,
      { expiresIn: "7d" }
    );

    // Build invite URL (uses reset-password page with invite flag)
    const inviteUrl = `${config.frontendUrl}/reset-password?token=${encodeURIComponent(inviteToken)}&invite=true`;

    // Send invite email
    const html = buildEmailTemplate({
      userName: first_name.trim(),
      companyName,
      title: "You've been invited to join " + companyName,
      bodyHtml: `
        <p>You've been invited to join <strong>${companyName}</strong> on Clara Confirms.</p>
        <p>Click the button below to set up your password and access your account.</p>
      `,
      buttonText: "Set Up Your Account",
      buttonUrl: inviteUrl,
      footerText: "This invitation link expires in 7 days.",
    });

    await sendMail({
      to: normalizedEmail,
      subject: `You're invited to ${companyName}`,
      html,
    });

    logger.info("User invited", {
      invitedUserId: newUser.id,
      invitedBy: req.user.userId,
      companyId: req.user.companyId,
    });

    return res.status(201).json({
      message: "Invitation sent",
      user: {
        id: newUser.id,
        email: newUser.email,
        first_name: newUser.first_name,
        last_name: newUser.last_name,
        name: [newUser.first_name, newUser.last_name].filter(Boolean).join(" ").trim(),
        role: newUser.role,
        active: newUser.active,
        created_at: newUser.created_at,
      },
    });
  } catch (err) {
    logger.error("Failed to invite user", { error: err.message });
    return res.status(500).json({ error: "Failed to invite user" });
  }
});

/**
 * PATCH /users/:id
 * Update a user's role or active status
 * Body: { role?, active? }
 * Admin only
 */
router.patch("/:id", authenticate, requireRole("admin"), async (req, res) => {
  try {
    const userId = req.params.id;
    const { role, active } = req.body;

    // Verify user belongs to the same company
    const userResult = await db.query(
      "SELECT id, company_id, email, first_name, last_name, role, active FROM users WHERE id = $1",
      [userId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const targetUser = userResult.rows[0];
    if (String(targetUser.company_id) !== String(req.user.companyId)) {
      return res.status(403).json({ error: "Access denied" });
    }

    // Prevent admin from deactivating or demoting themselves
    if (String(targetUser.id) === String(req.user.userId)) {
      if (active === false) {
        return res.status(400).json({ error: "You cannot deactivate yourself" });
      }
      if (role && role !== "admin") {
        return res.status(400).json({ error: "You cannot remove your own admin role" });
      }
    }

    // Build update query
    const updates = [];
    const values = [];
    let i = 1;

    if (role !== undefined) {
      const newRole = role === "admin" ? "admin" : "user";
      updates.push(`role = $${i++}`);
      values.push(newRole);
    }
    if (active !== undefined) {
      updates.push(`active = $${i++}`);
      values.push(Boolean(active));
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No updates provided" });
    }

    values.push(userId);
    await db.query(
      `UPDATE users SET ${updates.join(", ")}, updated_at = NOW() WHERE id = $${i}`,
      values
    );

    // Fetch updated user
    const updatedResult = await db.query(
      "SELECT id, email, first_name, last_name, role, active, created_at, last_login FROM users WHERE id = $1",
      [userId]
    );
    const updatedUser = updatedResult.rows[0];

    logger.info("User updated", {
      targetUserId: userId,
      updatedBy: req.user.userId,
      updates: { role, active },
    });

    return res.json({
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        first_name: updatedUser.first_name,
        last_name: updatedUser.last_name,
        name: [updatedUser.first_name, updatedUser.last_name].filter(Boolean).join(" ").trim(),
        role: updatedUser.role,
        active: updatedUser.active,
        created_at: updatedUser.created_at,
        last_login: updatedUser.last_login,
      },
    });
  } catch (err) {
    logger.error("Failed to update user", { error: err.message });
    return res.status(500).json({ error: "Failed to update user" });
  }
});

/**
 * DELETE /users/:id
 * Delete a user from the company
 * Admin only
 */
router.delete("/:id", authenticate, requireRole("admin"), async (req, res) => {
  try {
    const userId = req.params.id;

    // Verify user belongs to the same company
    const userResult = await db.query(
      "SELECT id, company_id, email FROM users WHERE id = $1",
      [userId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const targetUser = userResult.rows[0];
    if (String(targetUser.company_id) !== String(req.user.companyId)) {
      return res.status(403).json({ error: "Access denied" });
    }

    // Prevent admin from deleting themselves
    if (String(targetUser.id) === String(req.user.userId)) {
      return res.status(400).json({ error: "You cannot delete yourself" });
    }

    // Delete user
    await db.query("DELETE FROM users WHERE id = $1", [userId]);

    logger.info("User deleted", {
      deletedUserId: userId,
      deletedBy: req.user.userId,
      companyId: req.user.companyId,
    });

    return res.json({ message: "User deleted" });
  } catch (err) {
    logger.error("Failed to delete user", { error: err.message });
    return res.status(500).json({ error: "Failed to delete user" });
  }
});

module.exports = router;
