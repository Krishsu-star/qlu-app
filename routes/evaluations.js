const express = require("express");
const { randomUUID: uuidv4 } = require("crypto");
const pool = require("../db");
const { requireAuth } = require("../authMiddleware");
const { scopeForUser } = require("../utils/scope");
const { computeTestScore } = require("../utils/scoring");

const router = express.Router();

// Evaluation edit rights: Admin/HR can edit for everyone; Manager/User are view-only
// (matches the local app's rule — Manager can view/download evaluation but not edit it)
function canEditEvaluation(role) {
  return role === "Admin" || role === "HR";
}

// ---- Legacy fixed-field evaluation (used when a session has no questionnaire linked) ----

router.get("/legacy", requireAuth, async (req, res) => {
  const scope = await scopeForUser(req.user);
  const [rows] = await pool.query(`SELECT * FROM evaluations`);
  const filtered = scope ? rows.filter((r) => scope.has(r.employee_id)) : rows;
  res.json(filtered.map((r) => ({ id: r.id, sessionId: r.session_id, employeeId: r.employee_id, preScore: r.pre_score, postScore: r.post_score, feedbackRating: r.feedback_rating })));
});

router.put("/legacy", requireAuth, async (req, res) => {
  if (!canEditEvaluation(req.user.role)) return res.status(403).json({ error: "View only." });
  const { sessionId, employeeId, field, value } = req.body;
  const column = { preScore: "pre_score", postScore: "post_score", feedbackRating: "feedback_rating" }[field];
  if (!column) return res.status(400).json({ error: "Invalid field." });

  const [existing] = await pool.query(`SELECT id FROM evaluations WHERE session_id = ? AND employee_id = ?`, [sessionId, employeeId]);
  if (existing[0]) {
    await pool.query(`UPDATE evaluations SET ${column} = ? WHERE id = ?`, [value, existing[0].id]);
  } else {
    await pool.query(`INSERT INTO evaluations (id, session_id, employee_id, ${column}) VALUES (?,?,?,?)`, [uuidv4(), sessionId, employeeId, value]);
  }
  res.json({ ok: true });
});

// ---- Questionnaire-based responses ----

router.get("/responses", requireAuth, async (req, res) => {
  const [rows] = await pool.query(`SELECT * FROM eval_responses`);
  res.json(rows.map((r) => ({ id: r.id, sessionId: r.session_id, employeeId: r.employee_id, questionId: r.question_id, value: r.value })));
});

router.put("/responses", requireAuth, async (req, res) => {
  if (!canEditEvaluation(req.user.role)) return res.status(403).json({ error: "View only." });
  const { sessionId, employeeId, questionId, value } = req.body;
  const [existing] = await pool.query(`SELECT id FROM eval_responses WHERE session_id=? AND employee_id=? AND question_id=?`, [sessionId, employeeId, questionId]);
  if (existing[0]) {
    await pool.query(`UPDATE eval_responses SET value = ? WHERE id = ?`, [value, existing[0].id]);
  } else {
    await pool.query(`INSERT INTO eval_responses (id, session_id, employee_id, question_id, value) VALUES (?,?,?,?,?)`, [uuidv4(), sessionId, employeeId, questionId, value]);
  }
  res.json({ ok: true });
});

// ---- Scored test submission: auto-grade, record attempt, auto-retake on failure ----

router.get("/test-attempts", requireAuth, async (req, res) => {
  const [rows] = await pool.query(`SELECT * FROM test_attempts`);
  res.json(rows.map((r) => ({ id: r.id, sessionId: r.session_id, employeeId: r.employee_id, questionnaireId: r.questionnaire_id, attemptNumber: r.attempt_number, score: r.score, passed: !!r.passed, date: r.attempt_date })));
});

router.post("/submit-test", requireAuth, async (req, res) => {
  if (!canEditEvaluation(req.user.role)) return res.status(403).json({ error: "View only." });
  const { sessionId, employeeId, questionnaireId } = req.body;

  const [qRows] = await pool.query(`SELECT * FROM questionnaires WHERE id = ?`, [questionnaireId]);
  const questionnaire = qRows[0];
  if (!questionnaire) return res.status(404).json({ error: "Questionnaire not found." });

  const [questions] = await pool.query(`SELECT * FROM questions WHERE questionnaire_id = ?`, [questionnaireId]);
  const [responseRows] = await pool.query(`SELECT * FROM eval_responses WHERE session_id = ? AND employee_id = ?`, [sessionId, employeeId]);
  const answers = {};
  responseRows.forEach((r) => { answers[r.question_id] = r.value; });

  const score = computeTestScore(questions, answers);
  if (score === null) return res.status(400).json({ error: "This questionnaire has no scored questions to grade." });

  const [priorAttempts] = await pool.query(`SELECT COUNT(*) AS c FROM test_attempts WHERE session_id=? AND employee_id=? AND questionnaire_id=?`, [sessionId, employeeId, questionnaireId]);
  const attemptNumber = priorAttempts[0].c + 1;
  const passed = score >= questionnaire.pass_score;

  await pool.query(
    `INSERT INTO test_attempts (id, session_id, employee_id, questionnaire_id, attempt_number, score, passed, attempt_date) VALUES (?,?,?,?,?,?,?,CURDATE())`,
    [uuidv4(), sessionId, employeeId, questionnaireId, attemptNumber, score, passed ? 1 : 0]
  );

  if (!passed) {
    const questionIds = questions.map((q) => q.id);
    if (questionIds.length) {
      await pool.query(`DELETE FROM eval_responses WHERE session_id = ? AND employee_id = ? AND question_id IN (${questionIds.map(() => "?").join(",")})`, [sessionId, employeeId, ...questionIds]);
    }
  }

  res.json({ score, passed, attemptNumber, passScore: questionnaire.pass_score });
});

module.exports = router;
