const express = require("express");
const { randomUUID: uuidv4 } = require("crypto");
const pool = require("../db");
const { requireAuth, requireRole } = require("../authMiddleware");

const router = express.Router();

const INTERNAL_CRITERIA = [
  "Educational Qualification", "Functional Knowledge", "Industry Experience", "Job Role & Experience",
  "Training Experience", "Train-the-Trainer Qualification", "Communication Skills", "Presentation Skills",
  "Facilitation Skills", "Training Methodology", "Training Material", "Assessment Skills",
  "Subject Updates", "SOP / Policy Knowledge", "Regulatory Knowledge", "Previous Training Feedback",
  "Trainer Observation", "Overall Competency",
].map((c) => ({ criteria: c, requirement: "", answer: "", remarks: "" }));

const EXTERNAL_CRITERIA = [
  "Trainer Profile / CV", "Educational Qualification", "Subject Expertise", "Industry Experience",
  "Training Experience", "Trainer Certification", "Client / Organization Experience", "References",
  "Training Methodology", "Training Content", "Training Materials", "Assessment Method",
  "Communication Skills", "Participant Engagement", "Industry / Regulatory Knowledge",
  "Pharmaceutical / GxP Knowledge", "Previous Training Feedback",
].map((c) => ({ criteria: c, requirement: "", answer: "", remarks: "" }));

const emptyApproval = { status: "Pending", approverName: "", date: "", remarks: "" };

function rowToAssessment(r) {
  return {
    id: r.id, trainerName: r.trainer_name, trainerType: r.trainer_type, subject: r.subject,
    assessedByName: r.assessed_by, assessmentDate: r.assessment_date, criteria: r.criteria, status: r.status,
    qaApproval: r.qa_approval, siteHeadApproval: r.site_head_approval, hrApproval: r.hr_approval,
  };
}

router.get("/", requireAuth, async (req, res) => {
  const [rows] = await pool.query(`SELECT * FROM trainer_assessments ORDER BY created_at DESC`);
  res.json(rows.map(rowToAssessment));
});

router.post("/", requireAuth, requireRole("Admin", "HR", "QA"), async (req, res) => {
  const { trainerName, trainerType, subject } = req.body;
  const id = uuidv4();
  const criteria = trainerType === "Internal" ? INTERNAL_CRITERIA : EXTERNAL_CRITERIA;
  await pool.query(
    `INSERT INTO trainer_assessments (id, trainer_name, trainer_type, subject, assessed_by, assessment_date, criteria, status, qa_approval, site_head_approval, hr_approval)
     VALUES (?,?,?,?,?,CURDATE(),?,'Draft',?,?,?)`,
    [id, trainerName, trainerType, subject || "", req.user.displayName, JSON.stringify(criteria), JSON.stringify(emptyApproval), JSON.stringify(emptyApproval), JSON.stringify(emptyApproval)]
  );
  res.status(201).json({ id });
});

router.put("/:id/criteria", requireAuth, requireRole("Admin", "HR", "QA"), async (req, res) => {
  const { criteria } = req.body;
  await pool.query(`UPDATE trainer_assessments SET criteria = ? WHERE id = ?`, [JSON.stringify(criteria), req.params.id]);
  res.json({ ok: true });
});

router.put("/:id/submit", requireAuth, requireRole("Admin", "HR", "QA"), async (req, res) => {
  await pool.query(`UPDATE trainer_assessments SET status = 'Pending Approval' WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
});

// PUT /:id/decide/:stage — stage is "qa" | "siteHead" | "hr"; only that role (or Admin) may act
router.put("/:id/decide/:stage", requireAuth, async (req, res) => {
  const { stage } = req.params;
  const { decision, remarks } = req.body;
  const stageRole = { qa: "QA", siteHead: "SiteHead", hr: "HR" }[stage];
  const stageColumn = { qa: "qa_approval", siteHead: "site_head_approval", hr: "hr_approval" }[stage];
  if (!stageColumn) return res.status(400).json({ error: "Invalid stage." });
  if (req.user.role !== "Admin" && req.user.role !== stageRole) {
    return res.status(403).json({ error: `Only ${stageRole} can act on this stage.` });
  }

  const [rows] = await pool.query(`SELECT * FROM trainer_assessments WHERE id = ?`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found." });
  const record = rows[0];
  const stageResult = { status: decision, approverName: req.user.displayName, date: new Date().toISOString().slice(0, 10), remarks: remarks || "" };

  const qa = stage === "qa" ? stageResult : record.qa_approval;
  const siteHead = stage === "siteHead" ? stageResult : record.site_head_approval;
  const hr = stage === "hr" ? stageResult : record.hr_approval;
  const all = [qa, siteHead, hr];
  let overallStatus = "Pending Approval";
  if (all.some((s) => s.status === "Rejected")) overallStatus = "Rejected";
  else if (all.every((s) => s.status === "Approved")) overallStatus = "Approved";

  await pool.query(
    `UPDATE trainer_assessments SET ${stageColumn} = ?, status = ? WHERE id = ?`,
    [JSON.stringify(stageResult), overallStatus, req.params.id]
  );
  res.json({ ok: true, status: overallStatus });
});

module.exports = router;
