const express = require("express");
const { randomUUID: uuidv4 } = require("crypto");
const pool = require("../db");
const { requireAuth, requireRole } = require("../authMiddleware");
const { logAudit, diffFields, summarizeChanges } = require("../auditLogger");

const router = express.Router();

// Maps the JSON keys the frontend sends to the DB columns they correspond to — used by
// diffFields() to work out exactly what changed on a PUT /:id (session) or PUT /attendance/:id.
const SESSION_FIELD_MAP = {
  title: "title", category: "category", trainer: "trainer", date: "session_date",
  startTime: "start_time", endTime: "end_time", venue: "venue", maxSeats: "max_seats",
  skillId: "skill_id", description: "description",
  trainingTypeCode: "training_type_code", status: "status",
  coTrainer: "co_trainer", coordinator: "coordinator", targetAudience: "target_audience",
  objective: "objective", relatedSopId: "related_sop_id", sopVersion: "sop_version",
  certificateRequired: "certificate_required", deliveryType: "delivery_type",
};
const ATTENDANCE_FIELD_MAP = { status: "status", checkIn: "check_in", checkOut: "check_out", remarks: "remarks" };

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
    trainerConfirmedBy: r.trainer_confirmed_by, trainerConfirmedAt: r.trainer_confirmed_at,
    closedBy: r.closed_by, closedAt: r.closed_at,
  };
}

// Shared guard for every endpoint that mutates a session's attendance (nominate/update/remove)
// or the session record itself. Once a session is Closed:
//   - non-Admin is blocked outright.
//   - Admin may still proceed, but must supply a non-empty `correctionReason` in the body —
//     which gets logged to session_corrections (the "reason required" gate, unchanged from
//     Stage 3) AND to the general audit_log (as part of the calling route's own logAudit call,
//     with `reason` passed through) so it also shows up in the company-wide trail.
// Returns true if the caller should proceed, having already sent a response (and logged the
// correction) if not.
async function guardClosedSession(sessionId, req, res) {
  const [rows] = await pool.query(`SELECT status FROM sessions WHERE id = ?`, [sessionId]);
  const status = rows[0]?.status;
  if (status !== "Closed") return true;
  if (req.user.role !== "Admin") {
    res.status(403).json({ error: "This training is Closed and locked. Ask an Admin if a correction is needed." });
    return false;
  }
  const reason = (req.body.correctionReason || "").trim();
  if (!reason) {
    res.status(400).json({ error: "A reason is required to edit a Closed training." });
    return false;
  }
  await pool.query(
    `INSERT INTO session_corrections (id, session_id, edited_by, reason) VALUES (?,?,?,?)`,
    [uuidv4(), sessionId, req.body.correctionBy || req.user.role, reason]
  );
  return true;
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
  await logAudit(req, {
    entityType: "session", entityId: id, sessionId: id, action: "created",
    summary: `Training "${b.title}" created (${b.trainingTypeCode || "CLASSROOM"}, ${b.date || "no date"})`,
  });
  res.status(201).json({ id });
});

// PUT /api/sessions/:id — blocked once the session is Closed (locked) unless Admin supplies a
// correction reason (see guardClosedSession). Also: Trainer Confirmed / Closed can only ever be
// reached via the dedicated /confirm and /close endpoints below, never by picking them directly
// in this general edit — so any attempt to set status to either here is ignored (existing value kept).
//
// Every change here — Closed or not — is logged to the audit trail with a field-level diff, per
// the "log everything from day one" requirement. The Closed-only reason (if any) rides along too.
router.put("/:id", requireAuth, requireRole("Admin", "HR", "Manager"), async (req, res) => {
  if (!(await guardClosedSession(req.params.id, req, res))) return;

  const [existingRows] = await pool.query(`SELECT * FROM sessions WHERE id = ?`, [req.params.id]);
  const existing = existingRows[0];
  const existingStatus = existing?.status || "Scheduled";
  const b = req.body;
  const nextStatus = (b.status === "Trainer Confirmed" || b.status === "Closed") ? existingStatus : (b.status || "Scheduled");
  const bForDiff = { ...b, status: nextStatus };

  await pool.query(
    `UPDATE sessions SET title=?, category=?, trainer=?, session_date=?, start_time=?, end_time=?, venue=?, max_seats=?, skill_id=?, description=?, evaluation_questionnaire_id=?, effectiveness_questionnaire_id=?,
       training_type_code=?, status=?, co_trainer=?, coordinator=?, target_audience=?, objective=?, related_sop_id=?, sop_version=?, certificate_required=?, delivery_type=? WHERE id=?`,
    [b.title, b.category, b.trainer, b.date, b.startTime, b.endTime, b.venue, b.maxSeats || 20, b.skillId || null, b.description, b.evaluationQuestionnaireId || null, b.effectivenessQuestionnaireId || null,
     b.trainingTypeCode || "CLASSROOM", nextStatus, b.coTrainer || null, b.coordinator || null, b.targetAudience || null, b.objective || null, b.relatedSopId || null, b.sopVersion || null, b.certificateRequired ? 1 : 0, b.deliveryType || "Internal", req.params.id]
  );

  if (existing) {
    const changes = diffFields(existing, bForDiff, SESSION_FIELD_MAP);
    if (Object.keys(changes).length) {
      await logAudit(req, {
        entityType: "session", entityId: req.params.id, sessionId: req.params.id, action: "updated",
        summary: summarizeChanges(changes), changes,
        reason: existingStatus === "Closed" ? (req.body.correctionReason || "").trim() : null,
      });
    }
  }

  res.json({ ok: true });
});

// PUT /api/sessions/:id/confirm — the "Trainer Confirm" step. Only valid from Completed.
// There's no separate Trainer login in this system, so any of Admin/HR/Manager perform this
// on the trainer's behalf — `confirmedBy` (sent from the frontend) records who actually clicked it.
router.put("/:id/confirm", requireAuth, requireRole("Admin", "HR", "Manager"), async (req, res) => {
  const [rows] = await pool.query(`SELECT status FROM sessions WHERE id = ?`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Session not found." });
  if (rows[0].status !== "Completed") {
    return res.status(409).json({ error: "Only a training marked Completed can be confirmed." });
  }
  const confirmedBy = req.body.confirmedBy || req.user.role;
  await pool.query(
    `UPDATE sessions SET status = 'Trainer Confirmed', trainer_confirmed_by = ?, trainer_confirmed_at = NOW() WHERE id = ?`,
    [confirmedBy, req.params.id]
  );
  await logAudit(req, {
    entityType: "session", entityId: req.params.id, sessionId: req.params.id, action: "confirmed",
    summary: `Marked Trainer Confirmed by ${confirmedBy}`,
    changes: { status: { from: "Completed", to: "Trainer Confirmed" } },
  });
  res.json({ ok: true });
});

// PUT /api/sessions/:id/close — final lock step. Only valid from Trainer Confirmed.
router.put("/:id/close", requireAuth, requireRole("Admin", "HR", "Manager"), async (req, res) => {
  const [rows] = await pool.query(`SELECT status FROM sessions WHERE id = ?`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Session not found." });
  if (rows[0].status !== "Trainer Confirmed") {
    return res.status(409).json({ error: "This training must be Trainer Confirmed before it can be Closed." });
  }
  const closedBy = req.body.closedBy || req.user.role;
  await pool.query(
    `UPDATE sessions SET status = 'Closed', closed_by = ?, closed_at = NOW() WHERE id = ?`,
    [closedBy, req.params.id]
  );
  await logAudit(req, {
    entityType: "session", entityId: req.params.id, sessionId: req.params.id, action: "closed",
    summary: `Closed by ${closedBy}`,
    changes: { status: { from: "Trainer Confirmed", to: "Closed" } },
  });
  res.json({ ok: true });
});

// GET /api/sessions/:id/corrections — history of reasoned edits made to a Closed training.
// (The fuller company-wide trail is GET /api/audit-log — this stays as the focused per-session
// view Stage 4 already built and the user has confirmed working.)
router.get("/:id/corrections", requireAuth, requireRole("Admin", "HR", "Manager"), async (req, res) => {
  const [rows] = await pool.query(`SELECT * FROM session_corrections WHERE session_id = ? ORDER BY edited_at DESC`, [req.params.id]);
  res.json(rows.map((r) => ({ id: r.id, sessionId: r.session_id, editedBy: r.edited_by, reason: r.reason, editedAt: r.edited_at })));
});

// DELETE /api/sessions/:id — cascades to attendance/evaluations/etc. via FK constraints.
// The audit_log entry is written BEFORE deleting (and isn't itself cascade-deleted), so the
// record of "this training existed and was deleted, by whom and when" survives permanently.
router.delete("/:id", requireAuth, requireRole("Admin", "HR", "Manager"), async (req, res) => {
  const [rows] = await pool.query(`SELECT title FROM sessions WHERE id = ?`, [req.params.id]);
  await pool.query(`DELETE FROM sessions WHERE id = ?`, [req.params.id]);
  await logAudit(req, {
    entityType: "session", entityId: req.params.id, sessionId: req.params.id, action: "deleted",
    summary: `Training "${rows[0]?.title || req.params.id}" deleted`,
  });
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
  if (!(await guardClosedSession(req.params.id, req, res))) return;
  const { employeeId } = req.body;
  const id = uuidv4();
  try {
    await pool.query(`INSERT INTO attendance (id, session_id, employee_id, status) VALUES (?,?,?,'Nominated')`, [id, req.params.id, employeeId]);
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Already nominated." });
    throw e;
  }
  const [empRows] = await pool.query(`SELECT name FROM employees WHERE id = ?`, [employeeId]);
  await logAudit(req, {
    entityType: "attendance", entityId: id, sessionId: req.params.id, action: "nominated",
    summary: `Nominated ${empRows[0]?.name || employeeId}`,
    reason: (req.body.correctionReason || "").trim() || null,
  });
  res.status(201).json({ id });
});

// PUT /api/sessions/attendance/:attendanceId — update status (Nominated/Attended/Absent/Partial/Late/Excused),
// and optionally check-in/check-out time + remarks in the same call. Locked/reasoned the same way
// as the session record itself once the parent session is Closed (see guardClosedSession). Every
// change — Closed or not — is logged with a field-level diff.
//
// Stage 2: for an SOP-type session (training_type_code = 'SOP') with a related_sop_id,
// marking an employee Attended also completes their SOP acknowledgment — upserts a matching row
// in sop_assignments (creating one if the employee wasn't already assigned that SOP, otherwise
// just stamping read_date/completed_date on the existing one) so the SOP Bank reflects it too.
router.put("/attendance/:attendanceId", requireAuth, requireRole("Admin", "HR", "Manager"), async (req, res) => {
  const [attRows] = await pool.query(`SELECT * FROM attendance WHERE id = ?`, [req.params.attendanceId]);
  if (!attRows[0]) return res.status(404).json({ error: "Attendance record not found." });
  const existingAtt = attRows[0];
  if (!(await guardClosedSession(existingAtt.session_id, req, res))) return;

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

  const changes = diffFields(existingAtt, req.body, ATTENDANCE_FIELD_MAP);
  if (Object.keys(changes).length) {
    const [empRows] = await pool.query(`SELECT name FROM employees WHERE id = ?`, [existingAtt.employee_id]);
    const [sessRows] = await pool.query(`SELECT status FROM sessions WHERE id = ?`, [existingAtt.session_id]);
    await logAudit(req, {
      entityType: "attendance", entityId: req.params.attendanceId, sessionId: existingAtt.session_id, action: "updated",
      summary: `${empRows[0]?.name || "Employee"}: ${summarizeChanges(changes)}`, changes,
      reason: sessRows[0]?.status === "Closed" ? (req.body.correctionReason || "").trim() : null,
    });
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
  const [attRows] = await pool.query(`SELECT * FROM attendance WHERE id = ?`, [req.params.attendanceId]);
  if (!attRows[0]) return res.status(404).json({ error: "Attendance record not found." });
  const existingAtt = attRows[0];
  if (!(await guardClosedSession(existingAtt.session_id, req, res))) return;

  const [empRows] = await pool.query(`SELECT name FROM employees WHERE id = ?`, [existingAtt.employee_id]);
  await pool.query(`DELETE FROM attendance WHERE id = ?`, [req.params.attendanceId]);
  await logAudit(req, {
    entityType: "attendance", entityId: req.params.attendanceId, sessionId: existingAtt.session_id, action: "removed",
    summary: `Removed ${empRows[0]?.name || existingAtt.employee_id} (was ${existingAtt.status})`,
    reason: (req.body.correctionReason || "").trim() || null,
  });
  res.json({ ok: true });
});

module.exports = router;
