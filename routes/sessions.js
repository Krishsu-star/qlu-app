const express = require("express");
const { randomUUID: uuidv4 } = require("crypto");
const pool = require("../db");
const { requireAuth, requireRole } = require("../authMiddleware");

const router = express.Router();

function rowToSession(r) {
  return {
    id: r.id, title: r.title, category: r.category, trainer: r.trainer,
    date: r.session_date, startTime: r.start_time, endTime: r.end_time,
    venue: r.venue, maxSeats: r.max_seats, skillId: r.skill_id, description: r.description,
    evaluationQuestionnaireId: r.evaluation_questionnaire_id,
    effectivenessQuestionnaireId: r.effectiveness_questionnaire_id,
  };
}

// GET /api/sessions — visible to everyone signed in (calendar is company-wide visible)
router.get("/", requireAuth, async (req, res) => {
  const [rows] = await pool.query(`SELECT * FROM sessions ORDER BY session_date`);
  res.json(rows.map(rowToSession));
});

// POST /api/sessions — Admin/HR/Manager can schedule (matches local app's canManage rule)
router.post("/", requireAuth, requireRole("Admin", "HR", "Manager"), async (req, res) => {
  const b = req.body;
  const id = uuidv4();
  await pool.query(
    `INSERT INTO sessions (id, title, category, trainer, session_date, start_time, end_time, venue, max_seats, skill_id, description, evaluation_questionnaire_id, effectiveness_questionnaire_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, b.title, b.category, b.trainer, b.date, b.startTime, b.endTime, b.venue, b.maxSeats || 20, b.skillId || null, b.description, b.evaluationQuestionnaireId || null, b.effectivenessQuestionnaireId || null]
  );
  res.status(201).json({ id });
});

// PUT /api/sessions/:id
router.put("/:id", requireAuth, requireRole("Admin", "HR", "Manager"), async (req, res) => {
  const b = req.body;
  await pool.query(
    `UPDATE sessions SET title=?, category=?, trainer=?, session_date=?, start_time=?, end_time=?, venue=?, max_seats=?, skill_id=?, description=?, evaluation_questionnaire_id=?, effectiveness_questionnaire_id=? WHERE id=?`,
    [b.title, b.category, b.trainer, b.date, b.startTime, b.endTime, b.venue, b.maxSeats || 20, b.skillId || null, b.description, b.evaluationQuestionnaireId || null, b.effectivenessQuestionnaireId || null, req.params.id]
  );
  res.json({ ok: true });
});

// DELETE /api/sessions/:id — cascades to attendance/evaluations/etc. via FK constraints
router.delete("/:id", requireAuth, requireRole("Admin", "HR", "Manager"), async (req, res) => {
  await pool.query(`DELETE FROM sessions WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
});

// ---- Attendance (nested under a session) ----

// GET /api/sessions/attendance/all — full attendance list (used for completion-status export)
router.get("/attendance/all", requireAuth, async (req, res) => {
  const [rows] = await pool.query(`SELECT * FROM attendance`);
  res.json(rows.map((r) => ({ id: r.id, sessionId: r.session_id, employeeId: r.employee_id, status: r.status })));
});

// POST /api/sessions/:id/attendance — nominate an employee
router.post("/:id/attendance", requireAuth, requireRole("Admin", "HR", "Manager"), async (req, res) => {
  const { employeeId } = req.body;
  const id = uuidv4();
  try {
    await pool.query(`INSERT INTO attendance (id, session_id, employee_id, status) VALUES (?,?,?,'Nominated')`, [id, req.params.id, employeeId]);
    res.status(201).json({ id });
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Already nominated." });
    throw e;
  }
});

// PUT /api/sessions/attendance/:attendanceId — update status (Nominated/Attended/Absent/Partial)
router.put("/attendance/:attendanceId", requireAuth, requireRole("Admin", "HR", "Manager"), async (req, res) => {
  await pool.query(`UPDATE attendance SET status = ? WHERE id = ?`, [req.body.status, req.params.attendanceId]);
  res.json({ ok: true });
});

// DELETE /api/sessions/attendance/:attendanceId — remove a nomination
router.delete("/attendance/:attendanceId", requireAuth, requireRole("Admin", "HR", "Manager"), async (req, res) => {
  await pool.query(`DELETE FROM attendance WHERE id = ?`, [req.params.attendanceId]);
  res.json({ ok: true });
});

module.exports = router;
