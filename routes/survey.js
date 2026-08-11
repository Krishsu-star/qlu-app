const express = require("express");
const { randomUUID: uuidv4 } = require("crypto");
const pool = require("../db");
const { requireAuth, requireRole } = require("../authMiddleware");

const router = express.Router();
const MIN_REPORTING_GROUP_SIZE = 5;

function rowToSurvey(r) {
  return {
    id: r.id, name: r.name, type: r.type, purpose: r.purpose, startDate: r.start_date, endDate: r.end_date,
    anonymous: !!r.anonymous, targetType: r.target_type, targetDepartments: r.target_departments || [],
    targetGrades: r.target_grades || [], targetEmployeeIds: r.target_employee_ids || [], questions: r.questions || [],
    status: r.status, createdBy: r.created_by, createdDate: r.created_date, approvedBy: r.approved_by,
    approvalDate: r.approval_date, publishedDate: r.published_date, closedDate: r.closed_date,
  };
}

async function logAudit(surveyId, action, user) {
  await pool.query(`INSERT INTO survey_audit_log (id, survey_id, action, user, date) VALUES (?,?,?,?,CURDATE())`, [uuidv4(), surveyId, action, user]);
}

const canManage = requireRole("Admin", "HR", "Manager");

// ---- Surveys ----

router.get("/", requireAuth, async (req, res) => {
  const [rows] = await pool.query(`SELECT * FROM surveys ORDER BY created_date DESC`);
  res.json(rows.map(rowToSurvey));
});

router.post("/", requireAuth, canManage, async (req, res) => {
  const { name, type, purpose, startDate, endDate, anonymous } = req.body;
  const id = uuidv4();
  await pool.query(
    `INSERT INTO surveys (id, name, type, purpose, start_date, end_date, anonymous, target_type, target_departments, target_grades, target_employee_ids, questions, status, created_by, created_date)
     VALUES (?,?,?,?,?,?,?,'All','[]','[]','[]','[]','Draft',?,CURDATE())`,
    [id, name, type, purpose || "", startDate, endDate, anonymous ? 1 : 0, req.user.displayName]
  );
  await logAudit(id, "Survey created", req.user.displayName);
  res.status(201).json({ id });
});

router.put("/:id", requireAuth, canManage, async (req, res) => {
  const { name, purpose, startDate, endDate, anonymous, targetType, targetDepartments, targetGrades, targetEmployeeIds, questions } = req.body;
  const fields = [], params = [];
  if (name !== undefined) { fields.push("name=?"); params.push(name); }
  if (purpose !== undefined) { fields.push("purpose=?"); params.push(purpose); }
  if (startDate !== undefined) { fields.push("start_date=?"); params.push(startDate); }
  if (endDate !== undefined) { fields.push("end_date=?"); params.push(endDate); }
  if (anonymous !== undefined) { fields.push("anonymous=?"); params.push(anonymous ? 1 : 0); }
  if (targetType !== undefined) { fields.push("target_type=?"); params.push(targetType); }
  if (targetDepartments !== undefined) { fields.push("target_departments=?"); params.push(JSON.stringify(targetDepartments)); }
  if (targetGrades !== undefined) { fields.push("target_grades=?"); params.push(JSON.stringify(targetGrades)); }
  if (targetEmployeeIds !== undefined) { fields.push("target_employee_ids=?"); params.push(JSON.stringify(targetEmployeeIds)); }
  if (questions !== undefined) { fields.push("questions=?"); params.push(JSON.stringify(questions)); }
  if (fields.length === 0) return res.json({ ok: true });
  params.push(req.params.id);
  await pool.query(`UPDATE surveys SET ${fields.join(", ")} WHERE id = ?`, params);
  res.json({ ok: true });
});

router.delete("/:id", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  await pool.query(`DELETE FROM surveys WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
});

router.put("/:id/status", requireAuth, canManage, async (req, res) => {
  const { status, extra } = req.body;
  const fields = ["status=?"], params = [status];
  if (extra?.approvedBy !== undefined) { fields.push("approved_by=?"); params.push(extra.approvedBy); }
  if (extra?.approvalDate !== undefined) { fields.push("approval_date=?"); params.push(extra.approvalDate); }
  if (extra?.closedDate !== undefined) { fields.push("closed_date=?"); params.push(extra.closedDate); }
  if (extra?.endDate !== undefined) { fields.push("end_date=?"); params.push(extra.endDate); }
  params.push(req.params.id);
  await pool.query(`UPDATE surveys SET ${fields.join(", ")} WHERE id = ?`, params);
  await logAudit(req.params.id, `Status changed to ${status}`, req.user.displayName);
  res.json({ ok: true });
});

router.put("/:id/publish", requireAuth, canManage, async (req, res) => {
  const [surveyRows] = await pool.query(`SELECT * FROM surveys WHERE id = ?`, [req.params.id]);
  const survey = surveyRows[0];
  if (!survey) return res.status(404).json({ error: "Not found." });

  const [allEmployees] = await pool.query(`SELECT id, department, grade FROM employees`);
  let targetEmployees = allEmployees;
  if (survey.target_type === "Department") targetEmployees = allEmployees.filter((e) => (survey.target_departments || []).includes(e.department));
  else if (survey.target_type === "Grade") targetEmployees = allEmployees.filter((e) => (survey.target_grades || []).includes(e.grade));
  else if (survey.target_type === "Employees") targetEmployees = allEmployees.filter((e) => (survey.target_employee_ids || []).includes(e.id));

  await pool.query(`DELETE FROM survey_assignments WHERE survey_id = ?`, [req.params.id]);
  for (const e of targetEmployees) {
    await pool.query(`INSERT INTO survey_assignments (id, survey_id, employee_id, assigned_date, status) VALUES (?,?,?,CURDATE(),'Not Started')`, [uuidv4(), req.params.id, e.id]);
  }
  await pool.query(`UPDATE surveys SET status='Active', published_date=CURDATE() WHERE id=?`, [req.params.id]);
  await logAudit(req.params.id, `Published to ${targetEmployees.length} employee(s)`, req.user.displayName);
  res.json({ ok: true, count: targetEmployees.length });
});

router.get("/:id/assignments", requireAuth, async (req, res) => {
  let scope = "";
  const params = [req.params.id];
  if (req.user.role === "Manager") {
    const [me] = await pool.query(`SELECT name FROM employees WHERE id = ?`, [req.user.employeeId]);
    const [team] = await pool.query(`SELECT id FROM employees WHERE manager = ?`, [me[0]?.name || ""]);
    const ids = [req.user.employeeId, ...team.map((r) => r.id)];
    scope = "AND employee_id IN (?)"; params.push(ids.length ? ids : [""]);
  } else if (req.user.role === "User") {
    scope = "AND employee_id = ?"; params.push(req.user.employeeId);
  }
  const [rows] = await pool.query(`SELECT * FROM survey_assignments WHERE survey_id = ? ${scope}`, params);
  res.json(rows.map((r) => ({ id: r.id, surveyId: r.survey_id, employeeId: r.employee_id, assignedDate: r.assigned_date, status: r.status, completionDate: r.completion_date })));
});

router.post("/:id/responses", requireAuth, async (req, res) => {
  const [surveyRows] = await pool.query(`SELECT anonymous FROM surveys WHERE id = ?`, [req.params.id]);
  const survey = surveyRows[0];
  if (!survey) return res.status(404).json({ error: "Not found." });

  const isAnon = !!survey.anonymous;
  const [existing] = isAnon
    ? await pool.query(`SELECT id FROM survey_responses WHERE survey_id = ? AND anonymous_token = ?`, [req.params.id, req.user.id])
    : await pool.query(`SELECT id FROM survey_responses WHERE survey_id = ? AND employee_id = ?`, [req.params.id, req.user.employeeId]);
  if (existing[0]) return res.json({ id: existing[0].id });

  const id = uuidv4();
  await pool.query(
    `INSERT INTO survey_responses (id, survey_id, employee_id, anonymous_token, start_datetime, status) VALUES (?,?,?,?,NOW(),'In Progress')`,
    [id, req.params.id, isAnon ? null : req.user.employeeId, isAnon ? req.user.id : null]
  );
  await pool.query(`UPDATE survey_assignments SET status='In Progress' WHERE survey_id=? AND employee_id=? AND status='Not Started'`, [req.params.id, req.user.employeeId]);
  res.status(201).json({ id });
});

router.put("/responses/:responseId/answer", requireAuth, async (req, res) => {
  const { questionId, value } = req.body;
  const [existing] = await pool.query(`SELECT id FROM survey_response_details WHERE response_id = ? AND question_id = ?`, [req.params.responseId, questionId]);
  if (existing[0]) await pool.query(`UPDATE survey_response_details SET value = ? WHERE id = ?`, [JSON.stringify(value), existing[0].id]);
  else await pool.query(`INSERT INTO survey_response_details (id, response_id, question_id, value) VALUES (?,?,?,?)`, [uuidv4(), req.params.responseId, questionId, JSON.stringify(value)]);
  res.json({ ok: true });
});

router.get("/responses/:responseId/answers", requireAuth, async (req, res) => {
  const [rows] = await pool.query(`SELECT * FROM survey_response_details WHERE response_id = ?`, [req.params.responseId]);
  res.json(rows.map((r) => ({ questionId: r.question_id, value: r.value })));
});

router.put("/responses/:responseId/submit", requireAuth, async (req, res) => {
  const [rows] = await pool.query(`SELECT * FROM survey_responses WHERE id = ?`, [req.params.responseId]);
  const response = rows[0];
  if (!response) return res.status(404).json({ error: "Not found." });
  await pool.query(`UPDATE survey_responses SET status='Completed', submit_datetime=NOW() WHERE id=?`, [req.params.responseId]);
  await pool.query(`UPDATE survey_assignments SET status='Completed', completion_date=CURDATE() WHERE survey_id=? AND employee_id=?`, [response.survey_id, req.user.employeeId]);
  res.json({ ok: true });
});

router.get("/:id/dashboard", requireAuth, async (req, res) => {
  const [surveyRows] = await pool.query(`SELECT * FROM surveys WHERE id = ?`, [req.params.id]);
  const survey = surveyRows[0];
  if (!survey) return res.status(404).json({ error: "Not found." });

  const [assignments] = await pool.query(`SELECT sa.*, e.department FROM survey_assignments sa JOIN employees e ON e.id = sa.employee_id WHERE sa.survey_id = ?`, [req.params.id]);
  const [completedResponses] = await pool.query(`SELECT id FROM survey_responses WHERE survey_id = ? AND status='Completed'`, [req.params.id]);
  const responseIds = completedResponses.map((r) => r.id);
  let details = [];
  if (responseIds.length) {
    [details] = await pool.query(`SELECT * FROM survey_response_details WHERE response_id IN (?)`, [responseIds]);
  }

  const LIKERT_SCORES = { "Strongly Agree": 5, Agree: 4, Neutral: 3, Disagree: 2, "Strongly Disagree": 1 };
  const questions = survey.questions || [];
  const scoreFor = (q, value) => {
    if (value === undefined || value === null || value === "") return null;
    let raw = null, max = 5;
    if (q.qType === "likert") raw = LIKERT_SCORES[value] || null;
    else if (q.qType === "rating") { raw = Number(value); max = q.scaleMax || 5; }
    else if (q.qType === "yesno") raw = value === "Yes" ? 5 : 1;
    if (raw === null || isNaN(raw)) return null;
    if (q.reverseScoring) raw = (max + 1) - raw;
    return raw;
  };

  const categoryScores = {};
  const questionScores = {};
  const openComments = [];
  questions.forEach((q) => {
    const answers = details.filter((d) => d.question_id === q.id);
    if (q.qType === "text") {
      answers.forEach((a) => { if (a.value) openComments.push({ question: q.text, answer: a.value }); });
      return;
    }
    const scores = answers.map((a) => scoreFor(q, a.value)).filter((s) => s !== null);
    if (scores.length) {
      questionScores[q.id] = { text: q.text, avg: scores.reduce((a, b) => a + b, 0) / scores.length, count: scores.length };
      if (q.category) {
        (categoryScores[q.category] = categoryScores[q.category] || []).push(...scores);
      }
    }
  });

  const categoryRows = Object.entries(categoryScores).map(([cat, scores]) => ({
    category: cat, pct: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length / 5) * 100), count: scores.length,
  })).sort((a, b) => b.pct - a.pct);

  const deptGroups = {};
  assignments.forEach((a) => {
    if (!deptGroups[a.department]) deptGroups[a.department] = { invited: 0, completed: 0 };
    deptGroups[a.department].invited++;
    if (a.status === "Completed") deptGroups[a.department].completed++;
  });
  const deptRows = Object.entries(deptGroups).map(([department, g]) => ({
    department, invited: g.invited, completed: g.completed, suppressed: survey.anonymous && g.completed < MIN_REPORTING_GROUP_SIZE,
  }));

  const overallScores = Object.values(categoryScores).flat();
  const overallPct = overallScores.length ? Math.round((overallScores.reduce((a, b) => a + b, 0) / overallScores.length / 5) * 100) : null;

  res.json({
    invited: assignments.length, completed: assignments.filter((a) => a.status === "Completed").length,
    responseRate: assignments.length ? Math.round((assignments.filter((a) => a.status === "Completed").length / assignments.length) * 100) : 0,
    overallPct, categoryRows, deptRows, questionScores: Object.values(questionScores), openComments,
  });
});

router.get("/:id/action-plans", requireAuth, async (req, res) => {
  const [rows] = await pool.query(`SELECT * FROM survey_action_plans WHERE survey_id = ?`, [req.params.id]);
  res.json(rows.map((r) => ({ id: r.id, surveyId: r.survey_id, finding: r.finding, action: r.action, owner: r.owner, targetDate: r.target_date, priority: r.priority, status: r.status, remarks: r.remarks })));
});

router.post("/:id/action-plans", requireAuth, canManage, async (req, res) => {
  const { finding, action, owner, targetDate, priority, status, remarks } = req.body;
  const id = uuidv4();
  await pool.query(
    `INSERT INTO survey_action_plans (id, survey_id, finding, action, owner, target_date, priority, status, remarks) VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, req.params.id, finding, action, owner, targetDate || null, priority || "Medium", status || "Open", remarks || ""]
  );
  res.status(201).json({ id });
});

router.put("/action-plans/:id", requireAuth, canManage, async (req, res) => {
  const { finding, action, owner, targetDate, priority, status, remarks } = req.body;
  await pool.query(
    `UPDATE survey_action_plans SET finding=?, action=?, owner=?, target_date=?, priority=?, status=?, remarks=? WHERE id=?`,
    [finding, action, owner, targetDate || null, priority, status, remarks, req.params.id]
  );
  res.json({ ok: true });
});

router.delete("/action-plans/:id", requireAuth, canManage, async (req, res) => {
  await pool.query(`DELETE FROM survey_action_plans WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
});

router.get("/:id/audit-log", requireAuth, async (req, res) => {
  const [rows] = await pool.query(`SELECT * FROM survey_audit_log WHERE survey_id = ? ORDER BY date DESC`, [req.params.id]);
  res.json(rows.map((r) => ({ id: r.id, action: r.action, user: r.user, date: r.date })));
});

module.exports = router;
