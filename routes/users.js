const express = require("express");
const bcrypt = require("bcryptjs");
const { randomUUID: uuidv4 } = require("crypto");
const pool = require("../db");
const { requireAuth, requireRole } = require("../authMiddleware");

const router = express.Router();

function genTempPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let pw = "";
  for (let i = 0; i < 8; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  return pw;
}

// GET /api/users — Admin only (list never includes password hashes)
router.get("/", requireAuth, requireRole("Admin"), async (req, res) => {
  const [rows] = await pool.query(
    `SELECT u.id, u.employee_id, u.username, u.display_name, u.role, u.must_change_password, e.name AS employee_name
     FROM users u LEFT JOIN employees e ON e.id = u.employee_id ORDER BY u.username`
  );
  res.json(rows.map((r) => ({ id: r.id, employeeId: r.employee_id, username: r.username, displayName: r.display_name, role: r.role, mustChangePassword: !!r.must_change_password, employeeName: r.employee_name })));
});

// POST /api/users — Admin only. If no password is given, one is generated and returned once.
router.post("/", requireAuth, requireRole("Admin"), async (req, res) => {
  const { employeeId, username, displayName, role, password } = req.body;
  const tempPassword = password || genTempPassword();
  const hash = await bcrypt.hash(tempPassword, 10);
  const id = uuidv4();
  await pool.query(
    `INSERT INTO users (id, employee_id, username, password_hash, display_name, role, must_change_password) VALUES (?,?,?,?,?,?,1)`,
    [id, employeeId || null, username, hash, displayName, role]
  );
  res.status(201).json({ id, username, tempPassword });
});

// PUT /api/users/:id — update role/display name (not password — use reset-password for that)
router.put("/:id", requireAuth, requireRole("Admin"), async (req, res) => {
  const { displayName, role } = req.body;
  await pool.query(`UPDATE users SET display_name=?, role=? WHERE id=?`, [displayName, role, req.params.id]);
  res.json({ ok: true });
});

// POST /api/users/:id/reset-password — Admin only, generates and returns a new temp password
router.post("/:id/reset-password", requireAuth, requireRole("Admin"), async (req, res) => {
  const tempPassword = genTempPassword();
  const hash = await bcrypt.hash(tempPassword, 10);
  await pool.query(`UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?`, [hash, req.params.id]);
  res.json({ tempPassword });
});

router.delete("/:id", requireAuth, requireRole("Admin"), async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You can't delete the account you're currently logged in as." });
  await pool.query(`DELETE FROM users WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
});

// POST /api/users/bulk-import — Admin only. body: { rows: [{associateCode, role}] }
router.post("/bulk-import", requireAuth, requireRole("Admin"), async (req, res) => {
  const rows = req.body.rows || [];
  let created = 0, updated = 0;
  const credentials = [];
  for (const r of rows) {
    if (!r.associateCode || !r.role) continue;
    const [empRows] = await pool.query(`SELECT id, name FROM employees WHERE associate_code = ?`, [r.associateCode]);
    const emp = empRows[0];
    const [existing] = await pool.query(`SELECT id FROM users WHERE username = ?`, [r.associateCode]);
    if (existing[0]) {
      await pool.query(`UPDATE users SET role = ? WHERE id = ?`, [r.role, existing[0].id]);
      updated++;
    } else {
      const tempPassword = genTempPassword();
      const hash = await bcrypt.hash(tempPassword, 10);
      await pool.query(
        `INSERT INTO users (id, employee_id, username, password_hash, display_name, role, must_change_password) VALUES (?,?,?,?,?,?,1)`,
        [uuidv4(), emp ? emp.id : null, r.associateCode, hash, emp ? emp.name : r.associateCode, r.role]
      );
      created++;
      credentials.push({ name: emp ? emp.name : r.associateCode, username: r.associateCode, password: tempPassword });
    }
  }
  res.json({ created, updated, credentials });
});

module.exports = router;
