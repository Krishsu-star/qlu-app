const express = require("express");
const { randomUUID: uuidv4 } = require("crypto");
const pool = require("../db");
const { requireAuth, requireRole } = require("../authMiddleware");
const { scopeForUser } = require("../utils/scope");

const router = express.Router();

// Only Admin has edit rights here (matches the local app's rule — HR/Manager can view/download only)
function canEdit(role) {
  return role === "Admin";
}

router.get("/", requireAuth, async (req, res) => {
  const scope = await scopeForUser(req.user);
  const [rows] = await pool.query(
    `SELECT t.*, e.name AS employee_name, e.department, s.name AS skill_name
     FROM tni t JOIN employees e ON e.id = t.employee_id LEFT JOIN skills s ON s.id = t.skill_id`
  );
  const filtered = scope ? rows.filter((r) => scope.has(r.employee_id)) : rows;
  res.json(filtered.map((r) => ({
    id: r.id, employeeId: r.employee_id, empName: r.employee_name, empDept: r.department,
    skillId: r.skill_id, skillName: r.skill_name || "General",
    source: r.source, priority: r.priority, status: r.status, remarks: r.remarks,
  })));
});

router.post("/", requireAuth, requireRole("Admin"), async (req, res) => {
  const { employeeId, skillId, source, priority, status, remarks } = req.body;
  const id = uuidv4();
  await pool.query(`INSERT INTO tni (id, employee_id, skill_id, source, priority, status, remarks) VALUES (?,?,?,?,?,?,?)`, [id, employeeId, skillId || null, source, priority, status || "Identified", remarks]);
  res.status(201).json({ id });
});

router.put("/:id", requireAuth, requireRole("Admin"), async (req, res) => {
  const { employeeId, skillId, source, priority, status, remarks } = req.body;
  await pool.query(`UPDATE tni SET employee_id=?, skill_id=?, source=?, priority=?, status=?, remarks=? WHERE id=?`, [employeeId, skillId || null, source, priority, status, remarks, req.params.id]);
  res.json({ ok: true });
});

// PUT /api/tni/:id/status — quick status-only update (used by the status dropdown)
router.put("/:id/status", requireAuth, requireRole("Admin"), async (req, res) => {
  await pool.query(`UPDATE tni SET status = ? WHERE id = ?`, [req.body.status, req.params.id]);
  res.json({ ok: true });
});

router.delete("/:id", requireAuth, requireRole("Admin"), async (req, res) => {
  await pool.query(`DELETE FROM tni WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
