const express = require("express");
const { randomUUID: uuidv4 } = require("crypto");
const pool = require("../db");
const { requireAuth } = require("../authMiddleware");
const { scopeForUser } = require("../utils/scope");

const router = express.Router();

const PROFICIENCY_LABELS = ["None", "Basic", "Working", "Proficient", "Expert"];

// GET /api/skill-matrix — full matrix rows, scoped by role. Optional ?year=2026 filters to
// one assessment cycle; without it, every year on file is returned (the frontend groups by year).
router.get("/", requireAuth, async (req, res) => {
  const scope = await scopeForUser(req.user);
  let sql = `SELECT sm.*, e.name AS employee_name, e.department, s.name AS skill_name, s.category
             FROM skill_matrix sm
             JOIN employees e ON e.id = sm.employee_id
             JOIN skills s ON s.id = sm.skill_id`;
  const params = [];
  if (req.query.year) { sql += ` WHERE sm.year = ?`; params.push(Number(req.query.year)); }
  const [rows] = await pool.query(sql, params);
  const filtered = scope ? rows.filter((r) => scope.has(r.employee_id)) : rows;
  res.json(filtered.map((r) => ({
    id: r.id, employeeId: r.employee_id, skillId: r.skill_id, year: r.year,
    required: r.required_level, current: r.current_level, lastAssessed: r.last_assessed,
    employeeName: r.employee_name, department: r.department, skillName: r.skill_name, category: r.category,
    qualificationStatus: r.qualification_status || "Not Started", assessor: r.assessor,
    assessmentDate: r.assessment_date, nextReviewDate: r.next_review_date,
    qualRemarks: r.qual_remarks, evidenceNote: r.evidence_note,
  })));
});

// GET /api/skill-matrix/gap-analysis — derived: only rows where current < required, for one year
router.get("/gap-analysis", requireAuth, async (req, res) => {
  const scope = await scopeForUser(req.user);
  const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();
  const [rows] = await pool.query(
    `SELECT sm.*, e.name AS employee_name, e.department, s.name AS skill_name, s.category
     FROM skill_matrix sm
     JOIN employees e ON e.id = sm.employee_id
     JOIN skills s ON s.id = sm.skill_id
     WHERE sm.current_level < sm.required_level AND sm.year = ?`,
    [year]
  );
  const filtered = (scope ? rows.filter((r) => scope.has(r.employee_id)) : rows)
    .map((r) => ({
      employeeId: r.employee_id, employeeName: r.employee_name, department: r.department,
      skillName: r.skill_name, category: r.category,
      required: PROFICIENCY_LABELS[r.required_level], current: PROFICIENCY_LABELS[r.current_level],
      gap: r.required_level - r.current_level,
    }))
    .sort((a, b) => b.gap - a.gap);
  res.json(filtered);
});

// PUT /api/skill-matrix  body: { employeeId, skillId, field: "required"|"current", value, year }
// Managers and Admin/HR can both set Required and Current — Managers are restricted to their own team.
router.put("/", requireAuth, async (req, res) => {
  const { employeeId, skillId, field, value } = req.body;
  const year = req.body.year || new Date().getFullYear();
  if (!["required", "current"].includes(field)) return res.status(400).json({ error: "Invalid field." });

  if (req.user.role === "User") return res.status(403).json({ error: "View only." });
  if (req.user.role === "Manager") {
    const scope = await scopeForUser(req.user);
    if (!scope.has(employeeId)) return res.status(403).json({ error: "Not your team member." });
  }

  const column = field === "required" ? "required_level" : "current_level";
  const [existing] = await pool.query(`SELECT id FROM skill_matrix WHERE employee_id = ? AND skill_id = ? AND year = ?`, [employeeId, skillId, year]);
  if (existing[0]) {
    const extra = field === "current" ? ", last_assessed = CURDATE()" : "";
    await pool.query(`UPDATE skill_matrix SET ${column} = ? ${extra} WHERE id = ?`, [value, existing[0].id]);
  } else {
    const id = uuidv4();
    const requiredVal = field === "required" ? value : 3;
    const currentVal = field === "current" ? value : 0;
    await pool.query(
      `INSERT INTO skill_matrix (id, employee_id, skill_id, year, required_level, current_level, last_assessed) VALUES (?,?,?,?,?,?,CURDATE())`,
      [id, employeeId, skillId, year, requiredVal, currentVal]
    );
  }
  res.json({ ok: true });
});

// PUT /api/skill-matrix/qualification  body: { employeeId, skillId, year, qualificationStatus, assessor,
// assessmentDate, nextReviewDate, qualRemarks, evidenceNote }
// Same permission rule as the level-setting endpoint above: Admin/HR any employee, Manager own team only.
router.put("/qualification", requireAuth, async (req, res) => {
  const { employeeId, skillId, qualificationStatus, assessor, assessmentDate, nextReviewDate, qualRemarks, evidenceNote } = req.body;
  const year = req.body.year || new Date().getFullYear();
  const validStatuses = ["Not Started", "Trained", "Assessed", "Qualified", "Authorized"];
  if (qualificationStatus && !validStatuses.includes(qualificationStatus)) return res.status(400).json({ error: "Invalid qualification status." });

  if (req.user.role === "User") return res.status(403).json({ error: "View only." });
  if (req.user.role === "Manager") {
    const scope = await scopeForUser(req.user);
    if (!scope.has(employeeId)) return res.status(403).json({ error: "Not your team member." });
  }

  const [existing] = await pool.query(`SELECT id FROM skill_matrix WHERE employee_id = ? AND skill_id = ? AND year = ?`, [employeeId, skillId, year]);
  if (existing[0]) {
    await pool.query(
      `UPDATE skill_matrix SET qualification_status=?, assessor=?, assessment_date=?, next_review_date=?, qual_remarks=?, evidence_note=? WHERE id=?`,
      [qualificationStatus || "Not Started", assessor || null, assessmentDate || null, nextReviewDate || null, qualRemarks || null, evidenceNote || null, existing[0].id]
    );
  } else {
    await pool.query(
      `INSERT INTO skill_matrix (id, employee_id, skill_id, year, required_level, current_level, qualification_status, assessor, assessment_date, next_review_date, qual_remarks, evidence_note)
       VALUES (?,?,?,?,3,0,?,?,?,?,?,?)`,
      [uuidv4(), employeeId, skillId, year, qualificationStatus || "Not Started", assessor || null, assessmentDate || null, nextReviewDate || null, qualRemarks || null, evidenceNote || null]
    );
  }
  res.json({ ok: true });
});

// GET /api/skill-matrix/years — every year that has data, for the year switcher
router.get("/years", requireAuth, async (req, res) => {
  const [rows] = await pool.query(`SELECT DISTINCT year FROM skill_matrix ORDER BY year`);
  res.json(rows.map((r) => r.year));
});

// POST /api/skill-matrix/start-new-year  body: { fromYear, toYear }
// Copies each employee/skill's Required level into a fresh row for the new year, with
// Current reset to None — ready for reassessment. Skips any pair that already has a row
// for toYear, so this is safe to run more than once. Admin/HR only.
router.post("/start-new-year", requireAuth, async (req, res) => {
  if (!["Admin", "HR"].includes(req.user.role)) return res.status(403).json({ error: "Admin or HR only." });
  const fromYear = Number(req.body.fromYear);
  const toYear = Number(req.body.toYear);
  if (!fromYear || !toYear) return res.status(400).json({ error: "fromYear and toYear are required." });

  const [fromRows] = await pool.query(`SELECT employee_id, skill_id, required_level FROM skill_matrix WHERE year = ?`, [fromYear]);
  const [existingToRows] = await pool.query(`SELECT employee_id, skill_id FROM skill_matrix WHERE year = ?`, [toYear]);
  const existingSet = new Set(existingToRows.map((r) => `${r.employee_id}|${r.skill_id}`));

  let created = 0;
  for (const r of fromRows) {
    const key = `${r.employee_id}|${r.skill_id}`;
    if (existingSet.has(key)) continue;
    await pool.query(
      `INSERT INTO skill_matrix (id, employee_id, skill_id, year, required_level, current_level, last_assessed) VALUES (?,?,?,?,?,0,NULL)`,
      [uuidv4(), r.employee_id, r.skill_id, toYear, r.required_level]
    );
    created++;
  }
  res.json({ created });
});

module.exports = router;
