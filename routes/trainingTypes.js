const express = require("express");
const { randomUUID: uuidv4 } = require("crypto");
const pool = require("../db");
const { requireAuth, requireRole } = require("../authMiddleware");

const router = express.Router();

function rowToType(r) {
  return { id: r.id, name: r.name, code: r.code, attendanceMethod: r.attendance_method, active: !!r.active };
}

// GET /api/training-types — everyone signed in can see the list (needed to schedule/view training)
router.get("/", requireAuth, async (req, res) => {
  const [rows] = await pool.query(`SELECT * FROM training_types ORDER BY name`);
  res.json(rows.map(rowToType));
});

// POST /api/training-types — Admin/HR only
router.post("/", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  const { name, code, attendanceMethod } = req.body;
  if (!name || !code) return res.status(400).json({ error: "Name and code are required." });
  const id = uuidv4();
  try {
    await pool.query(`INSERT INTO training_types (id, name, code, attendance_method, active) VALUES (?,?,?,?,1)`, [id, name, code.toUpperCase(), attendanceMethod || null]);
    res.status(201).json({ id });
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "A training type with that code already exists." });
    throw e;
  }
});

// PUT /api/training-types/:id — Admin/HR only (edit fields, or just flip active/inactive)
router.put("/:id", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  const { name, attendanceMethod, active } = req.body;
  await pool.query(`UPDATE training_types SET name=?, attendance_method=?, active=? WHERE id=?`, [name, attendanceMethod || null, active ? 1 : 0, req.params.id]);
  res.json({ ok: true });
});

// DELETE /api/training-types/:id — Admin only (deactivating is the normal path; this is for genuine mistakes)
router.delete("/:id", requireAuth, requireRole("Admin"), async (req, res) => {
  await pool.query(`DELETE FROM training_types WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
