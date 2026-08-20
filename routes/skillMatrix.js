const express = require("express");
const { randomUUID: uuidv4 } = require("crypto");
const pool = require("../db");
const { requireAuth } = require("../authMiddleware");
const { scopeForUser } = require("../utils/scope");
const { logAudit } = require("../auditLogger");

const router = express.Router();

// Fallback labels if the proficiency_levels master is somehow empty — matches the same 0-4
// range as before, just relabeled per the Skill Bank spec (Beginner→Expert instead of None→Expert).
const FALLBACK_LABELS = ["Beginner", "Basic", "Intermediate", "Advanced", "Expert"];

async function getProficiencyLabels() {
  try {
    const [rows] = await pool.query(`SELECT level_number, level_name FROM proficiency_levels ORDER BY level_number`);
    if (!rows.length) return FALLBACK_LABELS;
    const map = [];
    rows.forEach((r) => { map[r.level_number] = r.level_name; });
    return map;
  } catch {
    return FALLBACK_LABELS;
  }
}

// Status per the spec's explicit logic. "Critical Gap" is a refinement of GAP for large
// shortfalls (gap of 2+ levels below Minimum), not a separate branch of the underlying logic —
// this matches both the spec's 3-state Status Logic section and its Employee Skill Profile
// example, where a 3-level gap is shown as "Critical Gap".
function computeStatus(current, min, target) {
  if (min == null || target == null) return { status: null, critical: false, gap: null };
  if (current < min) {
    const gap = target - current;
    return { status: "Gap", critical: min - current >= 2, gap };
  }
  if (current < target) return { status: "Meets Minimum", critical: false, gap: target - current };
  return { status: "Target Achieved", critical: false, gap: 0 };
}

// GET /api/skill-matrix — full matrix rows, scoped by role. Optional ?year=2026 filters to
// one assessment cycle; without it, every year on file is returned (the frontend groups by year).
router.get("/", requireAuth, async (req, res) => {
  const scope = await scopeForUser(req.user);
  const labels = await getProficiencyLabels();
  let sql = `SELECT sm.*, e.name AS employee_name, e.department, s.name AS skill_name, s.category
             FROM skill_matrix sm
             JOIN employees e ON e.id = sm.employee_id
             JOIN skills s ON s.id = sm.skill_id`;
  const params = [];
  if (req.query.year) { sql += ` WHERE sm.year = ?`; params.push(Number(req.query.year)); }
  const [rows] = await pool.query(sql, params);
  const filtered = scope ? rows.filter((r) => scope.has(r.employee_id)) : rows;
  res.json(filtered.map((r) => {
    const { status, critical, gap } = computeStatus(r.current_level, r.min_required_level, r.target_level);
    return {
      id: r.id, employeeId: r.employee_id, skillId: r.skill_id, year: r.year,
      required: r.required_level, current: r.current_level, lastAssessed: r.last_assessed,
      employeeName: r.employee_name, department: r.department, skillName: r.skill_name, category: r.category,
      qualificationStatus: r.qualification_status || "Not Started", assessor: r.assessor,
      assessmentDate: r.assessment_date, nextReviewDate: r.next_review_date,
      qualRemarks: r.qual_remarks, evidenceNote: r.evidence_note,
      // Skill Bank: Minimum/Target/Maximum range + derived status
      minRequired: r.min_required_level, targetLevel: r.target_level, maxRequired: r.max_required_level,
      currentLabel: labels[r.current_level], minRequiredLabel: labels[r.min_required_level],
      targetLabel: labels[r.target_level], maxRequiredLabel: labels[r.max_required_level],
      status, critical, gap, assessmentSource: r.assessment_source,
    };
  }));
});

// GET /api/skill-matrix/gap-analysis — derived: only rows below Target, for one year. Sorted by
// gap size (largest first) so the biggest shortfalls surface at the top, same as before.
router.get("/gap-analysis", requireAuth, async (req, res) => {
  const scope = await scopeForUser(req.user);
  const labels = await getProficiencyLabels();
  const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();
  const [rows] = await pool.query(
    `SELECT sm.*, e.name AS employee_name, e.department, s.name AS skill_name, s.category
     FROM skill_matrix sm
     JOIN employees e ON e.id = sm.employee_id
     JOIN skills s ON s.id = sm.skill_id
     WHERE sm.current_level < COALESCE(sm.target_level, sm.required_level) AND sm.year = ?`,
    [year]
  );
  const filtered = (scope ? rows.filter((r) => scope.has(r.employee_id)) : rows)
    .map((r) => {
      const { status, critical, gap } = computeStatus(r.current_level, r.min_required_level, r.target_level);
      return {
        employeeId: r.employee_id, employeeName: r.employee_name, department: r.department,
        skillName: r.skill_name, category: r.category,
        required: labels[r.required_level], current: labels[r.current_level],
        minRequired: labels[r.min_required_level], target: labels[r.target_level],
        gap: gap ?? (r.required_level - r.current_level), status, critical,
        priority: critical ? "High" : gap >= 1 ? "Medium" : "Low",
      };
    })
    .sort((a, b) => b.gap - a.gap);
  res.json(filtered);
});

// GET /api/skill-matrix/team-overview — Manager Dashboard aggregate stats, per the spec's
// section 7. Managers see their own team's scope; Admin/HR see everything for the year.
router.get("/team-overview", requireAuth, async (req, res) => {
  const scope = await scopeForUser(req.user);
  const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();
  const [rows] = await pool.query(`SELECT * FROM skill_matrix WHERE year = ?`, [year]);
  const filtered = scope ? rows.filter((r) => scope.has(r.employee_id)) : rows;

  let meetsOrAbove = 0, gaps = 0, critical = 0;
  const employeesWithGaps = new Set();
  for (const r of filtered) {
    const { status, critical: isCritical } = computeStatus(r.current_level, r.min_required_level, r.target_level);
    if (status === "Gap") { gaps++; employeesWithGaps.add(r.employee_id); if (isCritical) critical++; }
    else if (status) meetsOrAbove++;
  }
  const totalEmployees = new Set(filtered.map((r) => r.employee_id)).size;
  const avgCompetency = filtered.length ? (filtered.reduce((s, r) => s + (r.current_level || 0), 0) / filtered.length).toFixed(1) : null;

  res.json({
    year, totalEmployees, totalAssignedSkills: filtered.length,
    skillsMeetingRequirement: meetsOrAbove, skillsWithGaps: gaps, criticalGaps: critical,
    employeesRequiringTraining: employeesWithGaps.size, averageTeamCompetency: avgCompetency,
  });
});

// PUT /api/skill-matrix  body: { employeeId, skillId, field: "required"|"current", value, year,
// assessmentSource?, comments? }
// "required" is kept for backward compatibility — it only ever touches the legacy required_level
// column. For the new Minimum/Target/Maximum range, use PUT /range below. Setting "current" now
// also writes a row to skill_assessment_history, per the spec's "where was the employee, where
// are they now" requirement.
router.put("/", requireAuth, async (req, res) => {
  const { employeeId, skillId, field, value } = req.body;
  const year = req.body.year || new Date().getFullYear();
  if (!["required", "current"].includes(field)) return res.status(400).json({ error: "Invalid field." });

  if (req.user.role === "User") return res.status(403).json({ error: "View only." });
  if (req.user.role === "Manager") {
    const scope = await scopeForUser(req.user);
    if (!scope.has(employeeId)) return res.status(403).json({ error: "Not your team member." });
  }

  const [nameRows] = await pool.query(
    `SELECT e.name AS employee_name, s.name AS skill_name FROM employees e, skills s WHERE e.id = ? AND s.id = ?`,
    [employeeId, skillId]
  );
  const names = nameRows[0] || { employee_name: employeeId, skill_name: skillId };
  const labels = await getProficiencyLabels();
  const label = (v) => labels[v] ?? v;
  const actorName = req.body.actorName || req.user.role;

  const column = field === "required" ? "required_level" : "current_level";
  const [existing] = await pool.query(`SELECT id, required_level, current_level FROM skill_matrix WHERE employee_id = ? AND skill_id = ? AND year = ?`, [employeeId, skillId, year]);
  let matrixId;
  let oldCurrentValue = null;

  if (existing[0]) {
    matrixId = existing[0].id;
    const oldValue = field === "required" ? existing[0].required_level : existing[0].current_level;
    oldCurrentValue = existing[0].current_level;
    const extra = field === "current" ? `, last_assessed = CURDATE(), assessment_source = ?` : "";
    const params = field === "current" ? [value, req.body.assessmentSource || "Manager Assessment", matrixId] : [value, matrixId];
    await pool.query(`UPDATE skill_matrix SET ${column} = ? ${extra} WHERE id = ?`, params);
    if (oldValue !== value) {
      await logAudit(req, {
        entityType: "skillMatrix", entityId: matrixId, action: "updated",
        summary: `${names.employee_name} — ${names.skill_name} (${year}): ${field === "required" ? "Required" : "Current"} level ${label(oldValue)} → ${label(value)}`,
        changes: { [column]: { from: oldValue, to: value } },
      });
    }
  } else {
    matrixId = uuidv4();
    const requiredVal = field === "required" ? value : 3;
    const currentVal = field === "current" ? value : 0;
    await pool.query(
      `INSERT INTO skill_matrix (id, employee_id, skill_id, year, required_level, current_level, min_required_level, target_level, max_required_level, last_assessed, assessment_source)
       VALUES (?,?,?,?,?,?,?,?,?,CURDATE(),?)`,
      [matrixId, employeeId, skillId, year, requiredVal, currentVal, requiredVal, requiredVal, requiredVal, field === "current" ? (req.body.assessmentSource || "Manager Assessment") : null]
    );
    await logAudit(req, {
      entityType: "skillMatrix", entityId: matrixId, action: "created",
      summary: `${names.employee_name} — ${names.skill_name} (${year}): added to matrix (Required: ${label(requiredVal)}, Current: ${label(currentVal)})`,
    });
  }

  // Skill Assessment History — only when Current actually changes, since that's the "where were
  // they, where are they now" progression the spec is after; Required-level edits aren't an
  // assessment of the person, so they don't belong in this history.
  if (field === "current" && oldCurrentValue !== value) {
    await pool.query(
      `INSERT INTO skill_assessment_history (id, employee_id, skill_id, previous_level, new_level, assessment_source, assessed_by, assessment_date, comments)
       VALUES (?,?,?,?,?,?,?,CURDATE(),?)`,
      [uuidv4(), employeeId, skillId, oldCurrentValue, value, req.body.assessmentSource || "Manager Assessment", actorName, req.body.comments || null]
    );
  }

  res.json({ ok: true, id: matrixId });
});

// PUT /api/skill-matrix/range  body: { employeeId, skillId, year, minRequired, target, maxRequired }
// The primary way to set the Minimum/Target/Maximum range together, per the spec's "Manager
// Assigns Skill" workflow (section 3-4) — a manager defines the whole range in one step, not
// one field at a time. Also keeps the legacy required_level in sync (= target), so anything
// still reading that column sees a sensible value.
router.put("/range", requireAuth, async (req, res) => {
  const { employeeId, skillId, minRequired, target, maxRequired } = req.body;
  const year = req.body.year || new Date().getFullYear();
  if ([minRequired, target, maxRequired].some((v) => v == null)) {
    return res.status(400).json({ error: "minRequired, target, and maxRequired are all required." });
  }
  if (!(minRequired <= target && target <= maxRequired)) {
    return res.status(400).json({ error: "Levels must satisfy Minimum \u2264 Target \u2264 Maximum." });
  }

  if (req.user.role === "User") return res.status(403).json({ error: "View only." });
  if (req.user.role === "Manager") {
    const scope = await scopeForUser(req.user);
    if (!scope.has(employeeId)) return res.status(403).json({ error: "Not your team member." });
  }

  const [nameRows] = await pool.query(
    `SELECT e.name AS employee_name, s.name AS skill_name FROM employees e, skills s WHERE e.id = ? AND s.id = ?`,
    [employeeId, skillId]
  );
  const names = nameRows[0] || { employee_name: employeeId, skill_name: skillId };
  const labels = await getProficiencyLabels();

  const [existing] = await pool.query(`SELECT id, min_required_level, target_level, max_required_level FROM skill_matrix WHERE employee_id = ? AND skill_id = ? AND year = ?`, [employeeId, skillId, year]);
  let matrixId;
  if (existing[0]) {
    matrixId = existing[0].id;
    await pool.query(
      `UPDATE skill_matrix SET min_required_level=?, target_level=?, max_required_level=?, required_level=? WHERE id=?`,
      [minRequired, target, maxRequired, target, matrixId]
    );
  } else {
    matrixId = uuidv4();
    await pool.query(
      `INSERT INTO skill_matrix (id, employee_id, skill_id, year, required_level, current_level, min_required_level, target_level, max_required_level)
       VALUES (?,?,?,?,?,0,?,?,?)`,
      [matrixId, employeeId, skillId, year, target, minRequired, target, maxRequired]
    );
  }

  await logAudit(req, {
    entityType: "skillMatrix", entityId: matrixId, action: existing[0] ? "updated" : "created",
    summary: `${names.employee_name} — ${names.skill_name} (${year}): Required Range set to ${labels[minRequired]}\u2013${labels[maxRequired]} (Target: ${labels[target]})`,
  });
  res.json({ ok: true, id: matrixId });
});

// PUT /api/skill-matrix/qualification  body: { employeeId, skillId, year, qualificationStatus, assessor,
// assessmentDate, nextReviewDate, qualRemarks, evidenceNote }
// Same permission rule as the level-setting endpoint above: Admin/HR any employee, Manager own
// team only. This is the actual Qualification & Evidence workflow — every field-level change
// (status, assessor, dates, remarks, evidence) is logged with a full before/after diff, since
// this is exactly the kind of record a regulatory audit would want a trail for.
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

  const [nameRows] = await pool.query(
    `SELECT e.name AS employee_name, s.name AS skill_name FROM employees e, skills s WHERE e.id = ? AND s.id = ?`,
    [employeeId, skillId]
  );
  const names = nameRows[0] || { employee_name: employeeId, skill_name: skillId };

  const [existing] = await pool.query(`SELECT * FROM skill_matrix WHERE employee_id = ? AND skill_id = ? AND year = ?`, [employeeId, skillId, year]);
  const newVals = { qualificationStatus: qualificationStatus || "Not Started", assessor: assessor || null, assessmentDate: assessmentDate || null, nextReviewDate: nextReviewDate || null, qualRemarks: qualRemarks || null, evidenceNote: evidenceNote || null };
  const fieldMap = { qualificationStatus: "qualification_status", assessor: "assessor", assessmentDate: "assessment_date", nextReviewDate: "next_review_date", qualRemarks: "qual_remarks", evidenceNote: "evidence_note" };

  if (existing[0]) {
    await pool.query(
      `UPDATE skill_matrix SET qualification_status=?, assessor=?, assessment_date=?, next_review_date=?, qual_remarks=?, evidence_note=? WHERE id=?`,
      [newVals.qualificationStatus, newVals.assessor, newVals.assessmentDate, newVals.nextReviewDate, newVals.qualRemarks, newVals.evidenceNote, existing[0].id]
    );
    const changes = {};
    for (const [jsonKey, dbKey] of Object.entries(fieldMap)) {
      const oldStr = existing[0][dbKey] === null || existing[0][dbKey] === undefined ? "" : String(existing[0][dbKey]);
      const newStr = newVals[jsonKey] === null || newVals[jsonKey] === undefined ? "" : String(newVals[jsonKey]);
      if (oldStr !== newStr) changes[jsonKey] = { from: existing[0][dbKey] ?? null, to: newVals[jsonKey] ?? null };
    }
    if (Object.keys(changes).length) {
      const summary = Object.keys(changes).map((k) => `${k}: "${changes[k].from ?? "—"}" → "${changes[k].to ?? "—"}"`).join("; ");
      await logAudit(req, {
        entityType: "skillMatrixQualification", entityId: existing[0].id, action: "updated",
        summary: `${names.employee_name} — ${names.skill_name} (${year}): ${summary}`, changes,
      });
    }
  } else {
    const id = uuidv4();
    await pool.query(
      `INSERT INTO skill_matrix (id, employee_id, skill_id, year, required_level, current_level, qualification_status, assessor, assessment_date, next_review_date, qual_remarks, evidence_note)
       VALUES (?,?,?,?,3,0,?,?,?,?,?,?)`,
      [id, employeeId, skillId, year, newVals.qualificationStatus, newVals.assessor, newVals.assessmentDate, newVals.nextReviewDate, newVals.qualRemarks, newVals.evidenceNote]
    );
    await logAudit(req, {
      entityType: "skillMatrixQualification", entityId: id, action: "created",
      summary: `${names.employee_name} — ${names.skill_name} (${year}): qualification record started (${newVals.qualificationStatus})`,
    });
  }
  res.json({ ok: true });
});

// GET /api/skill-matrix/history?employeeId=&skillId= — Skill Assessment History for one
// employee+skill (or every skill for that employee if skillId is omitted). Scoped the same way
// as everything else — Managers only see their own team.
router.get("/history", requireAuth, async (req, res) => {
  const { employeeId, skillId } = req.query;
  if (!employeeId) return res.status(400).json({ error: "employeeId is required." });
  if (req.user.role === "Manager") {
    const scope = await scopeForUser(req.user);
    if (!scope.has(employeeId)) return res.status(403).json({ error: "Not your team member." });
  }
  let sql = `SELECT h.*, s.name AS skill_name FROM skill_assessment_history h JOIN skills s ON s.id = h.skill_id WHERE h.employee_id = ?`;
  const params = [employeeId];
  if (skillId) { sql += ` AND h.skill_id = ?`; params.push(skillId); }
  sql += ` ORDER BY h.assessment_date DESC, h.created_at DESC`;
  const [rows] = await pool.query(sql, params);
  const labels = await getProficiencyLabels();
  res.json(rows.map((r) => ({
    id: r.id, skillId: r.skill_id, skillName: r.skill_name,
    previousLevel: r.previous_level, newLevel: r.new_level,
    previousLabel: labels[r.previous_level], newLabel: labels[r.new_level],
    assessmentSource: r.assessment_source, assessedBy: r.assessed_by,
    assessmentDate: r.assessment_date, comments: r.comments,
  })));
});

// GET /api/skill-matrix/years — every year that has data, for the year switcher
router.get("/years", requireAuth, async (req, res) => {
  const [rows] = await pool.query(`SELECT DISTINCT year FROM skill_matrix ORDER BY year`);
  res.json(rows.map((r) => r.year));
});

// POST /api/skill-matrix/start-new-year  body: { fromYear, toYear }
// Copies each employee/skill's Required Range into a fresh row for the new year, with
// Current reset to None — ready for reassessment. Skips any pair that already has a row
// for toYear, so this is safe to run more than once. Admin/HR only.
router.post("/start-new-year", requireAuth, async (req, res) => {
  if (!["Admin", "HR"].includes(req.user.role)) return res.status(403).json({ error: "Admin or HR only." });
  const fromYear = Number(req.body.fromYear);
  const toYear = Number(req.body.toYear);
  if (!fromYear || !toYear) return res.status(400).json({ error: "fromYear and toYear are required." });

  const [fromRows] = await pool.query(`SELECT employee_id, skill_id, required_level, min_required_level, target_level, max_required_level FROM skill_matrix WHERE year = ?`, [fromYear]);
  const [existingToRows] = await pool.query(`SELECT employee_id, skill_id FROM skill_matrix WHERE year = ?`, [toYear]);
  const existingSet = new Set(existingToRows.map((r) => `${r.employee_id}|${r.skill_id}`));

  let created = 0;
  for (const r of fromRows) {
    const key = `${r.employee_id}|${r.skill_id}`;
    if (existingSet.has(key)) continue;
    await pool.query(
      `INSERT INTO skill_matrix (id, employee_id, skill_id, year, required_level, current_level, min_required_level, target_level, max_required_level, last_assessed)
       VALUES (?,?,?,?,?,0,?,?,?,NULL)`,
      [uuidv4(), r.employee_id, r.skill_id, toYear, r.required_level, r.min_required_level, r.target_level, r.max_required_level]
    );
    created++;
  }
  await logAudit(req, {
    entityType: "skillMatrix", entityId: `rollover-${fromYear}-${toYear}`, action: "yearRollover",
    summary: `Skill Matrix rolled over from ${fromYear} to ${toYear}: ${created} employee/skill pairs created`,
  });
  res.json({ created });
});

module.exports = router;
