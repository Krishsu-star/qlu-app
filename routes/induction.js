const express = require("express");
const { randomUUID: uuidv4 } = require("crypto");
const pool = require("../db");
const { requireAuth, requireRole } = require("../authMiddleware");

const router = express.Router();

const INDUCTION_TOPICS = [
  "Opening Session", "Training Overview", "Security", "Safety",
  "HR Policies", "Leave & Compensation", "GMP/ISO/Quality", "POSH",
];

async function scopeEmployeeIds(user) {
  if (user.role === "Admin" || user.role === "HR") return null;
  if (user.role === "Manager") {
    const [me] = await pool.query(`SELECT name FROM employees WHERE id = ?`, [user.employeeId]);
    const [team] = await pool.query(`SELECT id FROM employees WHERE manager = ?`, [me[0]?.name || ""]);
    return new Set([user.employeeId, ...team.map((r) => r.id)]);
  }
  return new Set([user.employeeId]);
}

router.get("/topics", requireAuth, (req, res) => res.json(INDUCTION_TOPICS));

// GET /api/induction — scoped, one row per (employee, topic)
router.get("/", requireAuth, async (req, res) => {
  const scope = await scopeEmployeeIds(req.user);
  let rows;
  if (!scope) [rows] = await pool.query(`SELECT * FROM induction_records`);
  else if (scope.size === 0) rows = [];
  else [rows] = await pool.query(`SELECT * FROM induction_records WHERE employee_id IN (?)`, [Array.from(scope)]);

  res.json(rows.map((r) => ({
    id: r.id, employeeId: r.employee_id, topic: r.topic, trainer: r.trainer,
    date: r.session_date, fromTime: r.from_time, toTime: r.to_time,
    questionnaireId: r.questionnaire_id, score: r.score,
    completed: !!(r.trainer && r.session_date),
  })));
});

// POST /api/induction/map — HR/Admin creates all 8 topic rows for a new joiner
router.post("/map", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  const { employeeId } = req.body;
  const [existing] = await pool.query(`SELECT id FROM induction_records WHERE employee_id = ?`, [employeeId]);
  if (existing.length > 0) return res.status(400).json({ error: "This employee is already mapped." });
  const ids = [];
  for (const topic of INDUCTION_TOPICS) {
    const id = uuidv4();
    ids.push(id);
    await pool.query(`INSERT INTO induction_records (id, employee_id, topic) VALUES (?,?,?)`, [id, employeeId, topic]);
  }
  res.status(201).json({ ids });
});

// PUT /api/induction/:id — Admin/HR/Manager updates trainer/date/time for one topic
router.put("/:id", requireAuth, requireRole("Admin", "HR", "Manager"), async (req, res) => {
  const { trainer, date, fromTime, toTime, questionnaireId } = req.body;
  await pool.query(
    `UPDATE induction_records SET trainer=?, session_date=?, from_time=?, to_time=?, questionnaire_id=? WHERE id=?`,
    [trainer || null, date || null, fromTime || null, toTime || null, questionnaireId || null, req.params.id]
  );
  res.json({ ok: true });
});

// PUT /api/induction/:id/score — records a topic test score
router.put("/:id/score", requireAuth, async (req, res) => {
  const { score } = req.body;
  const [rows] = await pool.query(`SELECT employee_id FROM induction_records WHERE id = ?`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found." });
  if (rows[0].employee_id !== req.user.employeeId && !["Admin", "HR"].includes(req.user.role)) {
    return res.status(403).json({ error: "You can only submit your own scores." });
  }
  await pool.query(`UPDATE induction_records SET score = ? WHERE id = ?`, [score, req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
