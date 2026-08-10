const express = require("express");
const { randomUUID: uuidv4 } = require("crypto");
const pool = require("../db");
const { requireAuth, requireRole } = require("../authMiddleware");

const router = express.Router();

// GET /api/questionnaires — everyone signed in can read (needed to link/display in sessions)
router.get("/", requireAuth, async (req, res) => {
  const [qRows] = await pool.query(`SELECT * FROM questionnaires ORDER BY created_at`);
  const [qsRows] = await pool.query(`SELECT * FROM questions ORDER BY sort_order`);
  const questionnaires = qRows.map((q) => ({
    id: q.id, name: q.name, category: q.category, isTest: !!q.is_test, passScore: q.pass_score,
    questions: qsRows.filter((x) => x.questionnaire_id === q.id).map((x) => ({
      id: x.id, text: x.text, qType: x.q_type,
      options: x.options_json ? JSON.parse(x.options_json) : undefined,
      correctAnswer: x.correct_answer || undefined,
    })),
  }));
  res.json(questionnaires);
});

// POST /api/questionnaires — Admin/HR only
router.post("/", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  const { name, category, isTest, passScore } = req.body;
  const id = uuidv4();
  await pool.query(`INSERT INTO questionnaires (id, name, category, is_test, pass_score) VALUES (?,?,?,?,?)`, [id, name, category, isTest ? 1 : 0, passScore || 70]);
  res.status(201).json({ id });
});

// DELETE /api/questionnaires/:id — Admin/HR only; sessions referencing it fall back to legacy fields
router.delete("/:id", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  await pool.query(`UPDATE sessions SET evaluation_questionnaire_id = NULL WHERE evaluation_questionnaire_id = ?`, [req.params.id]);
  await pool.query(`UPDATE sessions SET effectiveness_questionnaire_id = NULL WHERE effectiveness_questionnaire_id = ?`, [req.params.id]);
  await pool.query(`DELETE FROM questionnaires WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
});

// POST /api/questionnaires/:id/questions — add one question
router.post("/:id/questions", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  const { text, qType, options, correctAnswer } = req.body;
  const id = uuidv4();
  await pool.query(
    `INSERT INTO questions (id, questionnaire_id, text, q_type, options_json, correct_answer, sort_order)
     VALUES (?,?,?,?,?,?, (SELECT COUNT(*) FROM (SELECT 1 FROM questions WHERE questionnaire_id = ?) t))`,
    [id, req.params.id, text, qType, options ? JSON.stringify(options) : null, correctAnswer || null, req.params.id]
  );
  res.status(201).json({ id });
});

// POST /api/questionnaires/:id/questions/bulk-import — body: { rows: [{text, qType, options, correctAnswer}] }
router.post("/:id/questions/bulk-import", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  const rows = req.body.rows || [];
  let count = 0;
  for (const r of rows) {
    if (!r.text) continue;
    await pool.query(
      `INSERT INTO questions (id, questionnaire_id, text, q_type, options_json, correct_answer, sort_order)
       VALUES (?,?,?,?,?,?, (SELECT COUNT(*) FROM (SELECT 1 FROM questions WHERE questionnaire_id = ?) t))`,
      [uuidv4(), req.params.id, r.text, r.qType || "text", r.options ? JSON.stringify(r.options) : null, r.correctAnswer || null, req.params.id]
    );
    count++;
  }
  res.json({ imported: count });
});

// DELETE /api/questionnaires/questions/:questionId
router.delete("/questions/:questionId", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  await pool.query(`DELETE FROM questions WHERE id = ?`, [req.params.questionId]);
  res.json({ ok: true });
});

module.exports = router;
