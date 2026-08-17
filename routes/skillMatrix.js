const express = require("express");
const { randomUUID: uuidv4 } = require("crypto");
const pool = require("../db");
const { requireAuth } = require("../authMiddleware");
const { scopeForUser } = require("../utils/scope");
const { logAudit } = require("../auditLogger");

const router = express.Router();

const PROFICIENCY_LABELS = ["None", "Basic", "Working", "Proficient", "Expert"];

// GET /api/skill-matrix — full matrix rows, scoped by role
router.get("/", requireAuth, async (req, res) => {
  const scope = await scopeForUser(req.user);
  let sql = `SELECT sm.*, e.name AS employee_name, e.department, s.name AS skill_name, s.category
             FROM skill_matrix sm
             JOIN employees e ON e.id = sm.employee_id
             JOIN skills s ON s.id = sm.skill_id`;
  const [rows] = await pool.query(sql);
  const filtered = scope ? rows.filter((r) => scope.has(r.employee_id)) : rows;
  res.json(filtered.map((r) => ({
    id: r.id, employeeId: r.employee_id, skillId: r.skill_id,
    required: r.required_level, current: r.current_level, lastAssessed: r.last_assessed,
    employeeName: r.employee_name, department: r.department, skillName: r.skill_name, category: r.category,
  })));
});

// GET /api/skill-matrix/gap-analysis — derived: only rows where current < required
router.get("/gap-analysis", requireAuth, async (req, res) => {
  const scope = await scopeForUser(req.user);
  const [rows] = await pool.query(
    `SELECT sm.*, e.name AS employee_name, e.department, s.name AS skill_name, s.category
     FROM skill_matrix sm
     JOIN employees e ON e.id = sm.employee_id
     JOIN skills s ON s.id = sm.skill_id
     WHERE sm.current_level < sm.required_level`
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

// PUT /api/skill-matrix  body: { employeeId, skillId, field: "required"|"current", value }
// Managers can only update "current" and only for their own team (enforced here, mirroring the
// local app's rule) — that permission logic is unchanged; every successful change is now also
// logged to the shared audit trail with the before/after proficiency level.
router.put("/", requireAuth, async (req, res) => {
  const { employeeId, skillId, field, value } = req.body;
  if (!["required", "current"].includes(field)) return res.status(400).json({ error: "Invalid field." });

  if (req.user.role === "User") return res.status(403).json({ error: "View only." });
  if (req.user.role === "Manager") {
    if (field === "required") return res.status(403).json({ error: "Managers can update Current proficiency only." });
    const scope = await scopeForUser(req.user);
    if (!scope.has(employeeId)) return res.status(403).json({ error: "Not your team member." });
  }

  const column = field === "required" ? "required_level" : "current_level";
  const [existing] = await pool.query(`SELECT * FROM skill_matrix WHERE employee_id = ? AND skill_id = ?`, [employeeId, skillId]);

  const [nameRows] = await pool.query(
    `SELECT e.name AS employee_name, s.name AS skill_name FROM employees e, skills s WHERE e.id = ? AND s.id = ?`,
    [employeeId, skillId]
  );
  const names = nameRows[0] || { employee_name: employeeId, skill_name: skillId };
  const label = (v) => PROFICIENCY_LABELS[v] ?? v;

  let matrixId;
  if (existing[0]) {
    matrixId = existing[0].id;
    const oldValue = existing[0][column];
    const extra = field === "current" ? ", last_assessed = CURDATE()" : "";
    await pool.query(`UPDATE skill_matrix SET ${column} = ? ${extra} WHERE id = ?`, [value, matrixId]);
    if (oldValue !== value) {
      await logAudit(req, {
        entityType: "skillMatrix", entityId: matrixId, action: "updated",
        summary: `${names.employee_name} — ${names.skill_name}: ${field === "required" ? "Required" : "Current"} level ${label(oldValue)} → ${label(value)}`,
        changes: { [column]: { from: oldValue, to: value } },
      });
    }
  } else {
    matrixId = uuidv4();
    const requiredVal = field === "required" ? value : 3;
    const currentVal = field === "current" ? value : 0;
    await pool.query(
      `INSERT INTO skill_matrix (id, employee_id, skill_id, required_level, current_level, last_assessed) VALUES (?,?,?,?,?,CURDATE())`,
      [matrixId, employeeId, skillId, requiredVal, currentVal]
    );
    await logAudit(req, {
      entityType: "skillMatrix", entityId: matrixId, action: "created",
      summary: `${names.employee_name} — ${names.skill_name}: added to matrix (Required: ${label(requiredVal)}, Current: ${label(currentVal)})`,
    });
  }
  res.json({ ok: true });
});

module.exports = router;
