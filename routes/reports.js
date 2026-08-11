const express = require("express");
const pool = require("../db");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();

async function scopeEmployeeIds(user) {
  if (user.role === "Admin" || user.role === "HR") return null;
  if (user.role === "Manager") {
    const [me] = await pool.query(`SELECT name FROM employees WHERE id = ?`, [user.employeeId]);
    const [team] = await pool.query(`SELECT id FROM employees WHERE manager = ?`, [me[0]?.name || ""]);
    return new Set([user.employeeId, ...team.map((r) => r.id)]);
  }
  return new Set([user.employeeId]);
}

// GET /api/reports/employee-training?from=&to=&department=
// One row per employee x completed session — the core "who attended what" report.
router.get("/employee-training", requireAuth, async (req, res) => {
  const { from, to, department } = req.query;
  const scope = await scopeEmployeeIds(req.user);
  let where = "1=1", params = [];
  if (from) { where += " AND s.session_date >= ?"; params.push(from); }
  if (to) { where += " AND s.session_date <= ?"; params.push(to); }
  if (department) { where += " AND e.department = ?"; params.push(department); }
  if (scope) {
    if (scope.size === 0) return res.json([]);
    where += " AND e.id IN (?)"; params.push(Array.from(scope));
  }
  const [rows] = await pool.query(
    `SELECT e.name AS employee, e.department, s.title AS session, s.session_date AS date, s.trainer, a.status,
       TIMESTAMPDIFF(MINUTE, s.start_time, s.end_time) / 60 AS manHours
     FROM attendance a
     JOIN employees e ON e.id = a.employee_id
     JOIN sessions s ON s.id = a.session_id
     WHERE ${where}
     ORDER BY s.session_date DESC`,
    params
  );
  res.json(rows.map((r) => ({ ...r, manHours: r.manHours ? Math.round(r.manHours * 10) / 10 : 0 })));
});

// GET /api/reports/skill-matrix — current matrix + gap, scoped
router.get("/skill-matrix", requireAuth, async (req, res) => {
  const scope = await scopeEmployeeIds(req.user);
  let where = "1=1", params = [];
  if (scope) {
    if (scope.size === 0) return res.json([]);
    where += " AND e.id IN (?)"; params.push(Array.from(scope));
  }
  const [rows] = await pool.query(
    `SELECT e.name AS employee, e.department, sk.name AS skill, sk.category, m.required, m.current, (m.required - m.current) AS gap, m.last_assessed
     FROM skill_matrix m JOIN employees e ON e.id = m.employee_id JOIN skills sk ON sk.id = m.skill_id
     WHERE ${where} ORDER BY e.name`,
    params
  );
  res.json(rows);
});

// GET /api/reports/induction-completion
router.get("/induction-completion", requireAuth, async (req, res) => {
  const scope = await scopeEmployeeIds(req.user);
  let where = "1=1", params = [];
  if (scope) {
    if (scope.size === 0) return res.json([]);
    where += " AND e.id IN (?)"; params.push(Array.from(scope));
  }
  const [rows] = await pool.query(
    `SELECT e.name AS employee, e.department, ir.topic, ir.trainer, ir.session_date AS date, ir.score,
       CASE WHEN ir.trainer IS NOT NULL AND ir.session_date IS NOT NULL THEN 'Completed' ELSE 'Pending' END AS status
     FROM induction_records ir JOIN employees e ON e.id = ir.employee_id
     WHERE ${where} ORDER BY e.name, ir.topic`,
    params
  );
  res.json(rows);
});

// GET /api/reports/sop-training — QA/Admin/HR/Manager (Manager scoped to own dept via employee scope)
router.get("/sop-training", requireAuth, async (req, res) => {
  const scope = await scopeEmployeeIds(req.user);
  let where = "1=1", params = [];
  if (scope) {
    if (scope.size === 0) return res.json([]);
    where += " AND e.id IN (?)"; params.push(Array.from(scope));
  }
  const [rows] = await pool.query(
    `SELECT e.name AS employee, e.department, sd.title AS sop, sa.assignment_type, sa.assigned_date, sa.read_date, sa.test_score, sa.completed_date
     FROM sop_assignments sa JOIN employees e ON e.id = sa.employee_id JOIN sop_documents sd ON sd.id = sa.sop_id
     WHERE ${where} ORDER BY e.name`,
    params
  );
  res.json(rows);
});

// GET /api/reports/annual-manhours
router.get("/annual-manhours", requireAuth, async (req, res) => {
  const year = req.query.year || new Date().getFullYear();
  const scope = await scopeEmployeeIds(req.user);
  let where = "1=1", params = [`${year}-01-01`, `${year}-12-31`];
  if (scope) {
    if (scope.size === 0) return res.json([]);
    where += " AND e.id IN (?)"; params.push(Array.from(scope));
  }
  const [rows] = await pool.query(
    `SELECT e.name AS employee, e.department,
       COALESCE(SUM(TIMESTAMPDIFF(MINUTE, s.start_time, s.end_time)) / 60, 0) AS manHours
     FROM employees e
     LEFT JOIN attendance a ON a.employee_id = e.id AND a.status = 'Attended'
     LEFT JOIN sessions s ON s.id = a.session_id AND s.session_date BETWEEN ? AND ?
     WHERE ${where}
     GROUP BY e.id, e.name, e.department ORDER BY e.name`,
    params
  );
  res.json(rows.map((r) => ({ ...r, manHours: Math.round(r.manHours * 10) / 10 })));
});

// GET /api/reports/pending-training — Training Needs not yet Completed
router.get("/pending-training", requireAuth, async (req, res) => {
  const scope = await scopeEmployeeIds(req.user);
  let where = "t.status != 'Completed'", params = [];
  if (scope) {
    if (scope.size === 0) return res.json([]);
    where += " AND e.id IN (?)"; params.push(Array.from(scope));
  }
  const [rows] = await pool.query(
    `SELECT e.name AS employee, e.department, sk.name AS skill, t.source, t.priority, t.status, t.remarks
     FROM tni t JOIN employees e ON e.id = t.employee_id LEFT JOIN skills sk ON sk.id = t.skill_id
     WHERE ${where} ORDER BY t.priority`,
    params
  );
  res.json(rows);
});

module.exports = router;
