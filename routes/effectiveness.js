const express = require("express");
const { randomUUID: uuidv4 } = require("crypto");
const pool = require("../db");
const { requireAuth } = require("../authMiddleware");
const { scopeForUser } = require("../utils/scope");

const router = express.Router();

// Effectiveness edit rights: Admin/HR/Manager can edit (Manager scoped to their team); User is view-only
// (this is the one module where Manager DOES get edit rights, unlike Evaluation)
function canEditEffectiveness(role) {
  return role === "Admin" || role === "HR" || role === "Manager";
}

router.get("/legacy", requireAuth, async (req, res) => {
  const scope = await scopeForUser(req.user);
  const [rows] = await pool.query(`SELECT * FROM effectiveness`);
  const filtered = scope ? rows.filter((r) => scope.has(r.employee_id)) : rows;
  res.json(filtered.map((r) => ({ id: r.id, sessionId: r.session_id, employeeId: r.employee_id, status: r.status, remarks: r.remarks, evaluatedDate: r.evaluated_date })));
});

router.put("/legacy", requireAuth, async (req, res) => {
  if (!canEditEffectiveness(req.user.role)) return res.status(403).json({ error: "View only." });
  if (req.user.role === "Manager") {
    const scope = await scopeForUser(req.user);
    if (!scope.has(req.body.employeeId)) return res.status(403).json({ error: "Not your team member." });
  }
  const { sessionId, employeeId, field, value } = req.body;
  const column = { status: "status", remarks: "remarks", evaluatedDate: "evaluated_date" }[field];
  if (!column) return res.status(400).json({ error: "Invalid field." });

  const [existing] = await pool.query(`SELECT id FROM effectiveness WHERE session_id = ? AND employee_id = ?`, [sessionId, employeeId]);
  if (existing[0]) {
    await pool.query(`UPDATE effectiveness SET ${column} = ? WHERE id = ?`, [value, existing[0].id]);
  } else {
    await pool.query(`INSERT INTO effectiveness (id, session_id, employee_id, ${column}) VALUES (?,?,?,?)`, [uuidv4(), sessionId, employeeId, value]);
  }
  res.json({ ok: true });
});

router.get("/responses", requireAuth, async (req, res) => {
  const [rows] = await pool.query(`SELECT * FROM eff_responses`);
  res.json(rows.map((r) => ({ id: r.id, sessionId: r.session_id, employeeId: r.employee_id, questionId: r.question_id, value: r.value })));
});

router.put("/responses", requireAuth, async (req, res) => {
  if (!canEditEffectiveness(req.user.role)) return res.status(403).json({ error: "View only." });
  if (req.user.role === "Manager") {
    const scope = await scopeForUser(req.user);
    if (!scope.has(req.body.employeeId)) return res.status(403).json({ error: "Not your team member." });
  }
  const { sessionId, employeeId, questionId, value } = req.body;
  const [existing] = await pool.query(`SELECT id FROM eff_responses WHERE session_id=? AND employee_id=? AND question_id=?`, [sessionId, employeeId, questionId]);
  if (existing[0]) {
    await pool.query(`UPDATE eff_responses SET value = ? WHERE id = ?`, [value, existing[0].id]);
  } else {
    await pool.query(`INSERT INTO eff_responses (id, session_id, employee_id, question_id, value) VALUES (?,?,?,?,?)`, [uuidv4(), sessionId, employeeId, questionId, value]);
  }
  res.json({ ok: true });
});

module.exports = router;
