const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();

// POST /api/auth/login  { username, password }
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username and password are required." });

    const [rows] = await pool.query(
      `SELECT u.*, e.name AS employee_name FROM users u
       LEFT JOIN employees e ON e.id = u.employee_id
       WHERE u.username = ? LIMIT 1`,
      [username]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: "Incorrect username or password." });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Incorrect username or password." });

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, employeeId: user.employee_id },
      process.env.JWT_SECRET,
      { expiresIn: "12h" }
    );

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        employeeId: user.employee_id,
        mustChangePassword: !!user.must_change_password,
      },
    });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(503).json({ error: "The database is temporarily unavailable. Please wait a moment and try again." });
  }
});

// POST /api/auth/change-password  { newPassword }  (requires being signed in)
router.post("/change-password", requireAuth, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query(`UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?`, [hash, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Change password error:", err.message);
    res.status(503).json({ error: "The database is temporarily unavailable. Please wait a moment and try again." });
  }
});

module.exports = router;
