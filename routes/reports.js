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
    trainingTypeCode: r.training_type_code, status: r.status,
    coTrainer: r.co_trainer, coordinator: r.coordinator, targetAudience: r.target_audience,
    objective: r.objective, relatedSopId: r.related_sop_id, sopVersion: r.sop_version,
    certificateRequired: !!r.certificate_required, deliveryType: r.delivery_type,
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
    `INSERT INTO sessions (id, title, category, trainer, session_date, start_time, end_time, venue, max_seats, skill_id, description, evaluation_questionnaire_id, effectiveness_questionnaire_id,
       training_type_code, status, co_trainer, coordinator, target_audience, objective, related_sop_id, sop_version, certificate_required, delivery_type)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, b.title, b.category, b.trainer, b.date, b.startTime, b.endTime, b.venue, b.maxSeats || 20, b.skillId || null, b.description, b.evaluationQuestionnaireId || null, b.effectivenessQuestionnaireId || null,
     b.trainingTypeCode || "CLASSROOM", b.status || "Scheduled", b.coTrainer || null, b.coordinator || null, b.targetAudience || null, b.objective || null, b.relatedSopId || null, b.sopVersion || null, b.certificateRequired ? 1 : 0, b.deliveryType || "Internal"]
  );
  res.status(201).json({ id });
});

// PUT /api/sessions/:id — blocked once the session is Closed (locked), except for Admin who can still
// make corrections if genuinely needed. This is a light first version of the lock rule from the spec —
// the full amendment/approval workflow comes in a later stage.
router.put("/:id", requireAuth, requireRole("Admin", "HR", "Manager"), async (req, res) => {
  if (req.user.role !== "Admin") {
    const [existing] = await pool.query(`SELECT status FROM sessions WHERE id = ?`, [req.params.id]);
    if (existing[0] && existing[0].status === "Closed") {
      return res.status(403).json({ error: "This training is Closed and locked. Ask an Admin if a correction is needed." });
    }
  }
  const b = req.body;
  await pool.query(
    `UPDATE sessions SET title=?, category=?, trainer=?, session_date=?, start_time=?, end_time=?, venue=?, max_seats=?, skill_id=?, description=?, evaluation_questionnaire_id=?, effectiveness_questionnaire_id=?,
       training_type_code=?, status=?, co_trainer=?, coordinator=?, target_audience=?, objective=?, related_sop_id=?, sop_version=?, certificate_required=?, delivery_type=? WHERE id=?`,
    [b.title, b.category, b.trainer, b.date, b.startTime, b.endTime, b.venue, b.maxSeats || 20, b.skillId || null, b.description, b.evaluationQuestionnaireId || null, b.effectivenessQuestionnaireId || null,
     b.trainingTypeCode || "CLASSROOM", b.status || "Scheduled", b.coTrainer || null, b.coordinator || null, b.targetAudience || null, b.objective || null, b.relatedSopId || null, b.sopVersion || null, b.certificateRequired ? 1 : 0, b.deliveryType || "Internal", req.params.id]
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
  res.json(rows.map((r) => ({ id: r.id, sessionId: r.session_id, employeeId: r.employee_id, status: r.status, checkIn: r.check_in, checkOut: r.check_out, remarks: r.remarks })));
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

// PUT /api/sessions/attendance/:attendanceId — update status (Nominated/Attended/Absent/Partial/Late/Excused),
// and optionally check-in/check-out time + remarks in the same call.
//
// Stage 2 addition: for an SOP-type session (training_type_code = 'SOP') with a related_sop_id,
// marking an employee Attended also completes their SOP acknowledgment — upserts a matching row
// in sop_assignments (creating one if the employee wasn't already assigned that SOP, otherwise
// just stamping read_date/completed_date on the existing one) so the SOP Bank reflects it too.
router.put("/attendance/:attendanceId", requireAuth, requireRole("Admin", "HR", "Manager"), async (req, res) => {
  const { status, checkIn, checkOut, remarks } = req.body;
  const sets = [];
  const params = [];
  if (status !== undefined) { sets.push("status = ?"); params.push(status); }
  if (checkIn !== undefined) { sets.push("check_in = ?"); params.push(checkIn || null); }
  if (checkOut !== undefined) { sets.push("check_out = ?"); params.push(checkOut || null); }
  if (remarks !== undefined) { sets.push("remarks = ?"); params.push(remarks || null); }
  if (sets.length) {
    params.push(req.params.attendanceId);
    await pool.query(`UPDATE attendance SET ${sets.join(", ")} WHERE id = ?`, params);
  }

  if (status === "Attended") {
    const [info] = await pool.query(
      `SELECT a.employee_id, s.training_type_code, s.related_sop_id, s.session_date, s.trainer
         FROM attendance a JOIN sessions s ON s.id = a.session_id WHERE a.id = ?`,
      [req.params.attendanceId]
    );
    const row = info[0];
    if (row && row.training_type_code === "SOP" && row.related_sop_id) {
      const [existing] = await pool.query(
        `SELECT id FROM sop_assignments WHERE sop_id = ? AND employee_id = ?`,
        [row.related_sop_id, row.employee_id]
      );
      if (existing[0]) {
        await pool.query(
          `UPDATE sop_assignments SET read_date = ?, completed_date = ? WHERE id = ?`,
          [row.session_date, row.session_date, existing[0].id]
        );
      } else {
        await pool.query(
          `INSERT INTO sop_assignments (id, sop_id, employee_id, assigned_by, assignment_type, assigned_date, read_date, completed_date)
           VALUES (?,?,?,?,?,?,?,?)`,
          [uuidv4(), row.related_sop_id, row.employee_id, row.trainer || "Training Session", "Induction", row.session_date, row.session_date, row.session_date]
        );
      }
    }
  }

  res.json({ ok: true });
});

// DELETE /api/sessions/attendance/:attendanceId — remove a nomination
router.delete("/attendance/:attendanceId", requireAuth, requireRole("Admin", "HR", "Manager"), async (req, res) => {
  await pool.query(`DELETE FROM attendance WHERE id = ?`, [req.params.attendanceId]);
  res.json({ ok: true });
});

module.exports = router;
