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
const companySettings = require("../db/company-settings");
const { inviteUser } = require("../services/user-invite");

const router = express.Router();

/**
 * GET /users
 * List all users in the authenticated user's company
 */
router.get("/", authenticate, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, email, first_name, last_name, role, is_active, created_at, last_login
       FROM users
       WHERE company_id = $1 AND is_deleted = FALSE
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
      active: row.is_active,
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
    const newUser = await inviteUser(
      req.user.companyId,
      { email, first_name, last_name, role },
      req.user.userId
    );

    return res.status(201).json({
      message: "Invitation sent",
      user: {
        id: newUser.id,
        email: newUser.email,
        first_name: newUser.first_name,
        last_name: newUser.last_name,
        name: [newUser.first_name, newUser.last_name].filter(Boolean).join(" ").trim(),
        role: newUser.role,
        active: newUser.is_active,
        created_at: newUser.created_at,
      },
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        error: err.message,
        ...(err.max_users ? { max_users: err.max_users } : {}),
      });
    }
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

    // Verify user belongs to the same company and is not soft-deleted
    const userResult = await db.query(
      "SELECT id, company_id, email, first_name, last_name, role, is_active FROM users WHERE id = $1 AND is_deleted = FALSE",
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
      updates.push(`is_active = $${i++}`);
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
      "SELECT id, email, first_name, last_name, role, is_active, created_at, last_login FROM users WHERE id = $1",
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
        active: updatedUser.is_active,
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
 * Soft-delete a user: set is_deleted = TRUE, is_active = FALSE (row kept).
 * Admin only.
 */
router.delete("/:id", authenticate, requireRole("admin"), async (req, res) => {
  try {
    const userId = req.params.id;

    // Verify user belongs to the same company and is not already soft-deleted
    const userResult = await db.query(
      "SELECT id, company_id, email FROM users WHERE id = $1 AND is_deleted = FALSE",
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

    // Soft delete: set is_deleted and is_active
    await db.query(
      "UPDATE users SET is_deleted = TRUE, is_active = FALSE, updated_at = NOW() WHERE id = $1",
      [userId]
    );

    logger.info("User soft-deleted", {
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
