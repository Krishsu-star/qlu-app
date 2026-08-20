const express = require("express");
const { randomUUID: uuidv4 } = require("crypto");
const pool = require("../db");
const { requireAuth, requireRole } = require("../authMiddleware");
const { logAudit, diffFields, summarizeChanges } = require("../auditLogger");

const router = express.Router();

const SKILL_FIELD_MAP = {
  name: "name", category: "category", subCategory: "sub_category", description: "description",
  skillType: "skill_type", department: "department", designation: "designation",
  ownerDepartment: "owner_department", criticality: "criticality", status: "status",
  requiresQualification: "requires_qualification",
};

function rowToSkill(r) {
  let levelGuidance = null;
  if (r.level_guidance) {
    try { levelGuidance = JSON.parse(r.level_guidance); } catch { levelGuidance = null; }
  }
  return {
    id: r.id, name: r.name, category: r.category,
    department: r.department, designation: r.designation, // eligibility scope — who this skill can be assigned to
    ownerDepartment: r.owner_department, // ownership — who maintains this skill's definition (may differ from eligibility)
    criticality: r.criticality || "Normal", levelGuidance,
    requiresQualification: !!r.requires_qualification,
    // Skill Bank fields
    subCategory: r.sub_category, description: r.description,
    skillType: r.skill_type || "Functional", status: r.status || "Active",
    version: r.version || 1, remarks: r.remarks,
    createdBy: r.created_by, createdDate: r.created_date,
    modifiedBy: r.modified_by, modifiedDate: r.modified_date,
  };
}

async function getManagerDept(userId, employeeId) {
  if (!employeeId) return null;
  const [rows] = await pool.query(`SELECT department FROM employees WHERE id = ?`, [employeeId]);
  return rows[0] ? rows[0].department : null;
}

// GET /api/skills — everyone with access can view (User role has this tab hidden client-side,
// but the API itself doesn't need to block reads since skills carry no personal data)
router.get("/", requireAuth, async (req, res) => {
  const [rows] = await pool.query(`SELECT * FROM skills ORDER BY name`);
  res.json(rows.map(rowToSkill));
});

// POST /api/skills — Admin/HR (any department), or Manager (own department only, and always the owner)
router.post("/", requireAuth, requireRole("Admin", "HR", "Manager"), async (req, res) => {
  const { name, category } = req.body;
  const criticality = req.body.criticality || "Normal";
  const levelGuidance = req.body.levelGuidance ? JSON.stringify(req.body.levelGuidance) : null;
  const designation = req.body.designation || null;
  const requiresQualification = req.body.requiresQualification ? 1 : 0;
  const subCategory = req.body.subCategory || null;
  const description = req.body.description || null;
  const skillType = req.body.skillType || "Functional";
  const status = req.body.status === "Inactive" ? "Inactive" : "Active";
  const remarks = req.body.remarks || null;
  const createdBy = req.body.actorName || req.user.role;
  let department = req.body.department || null; // eligibility — who this can be assigned to
  let ownerDepartment = req.body.ownerDepartment || null; // ownership — who maintains it

  if (req.user.role === "Manager") {
    const dept = await getManagerDept(req.user.id, req.user.employeeId);
    ownerDepartment = dept; // a Manager always owns what they create — this isn't client-editable
    // Eligibility (department) is left as whatever the Manager chose — including blank, so a
    // Manager can create a skill their own department maintains but that's assignable everywhere.
  }

  const id = uuidv4();
  await pool.query(
    `INSERT INTO skills (id, name, category, department, designation, owner_department, criticality, level_guidance, requires_qualification, sub_category, description, skill_type, status, remarks, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, name, category, department, designation, ownerDepartment, criticality, levelGuidance, requiresQualification, subCategory, description, skillType, status, remarks, createdBy]
  );
  await logAudit(req, { entityType: "skill", entityId: id, action: "created", summary: `Skill "${name}" (${category}) created` });
  res.status(201).json({ id });
});

// PUT /api/skills/:id — Admin/HR (any), Manager (only skills THEY OWN — regardless of eligibility scope)
router.put("/:id", requireAuth, requireRole("Admin", "HR", "Manager"), async (req, res) => {
  const { name, category } = req.body;
  const criticality = req.body.criticality || "Normal";
  const levelGuidance = req.body.levelGuidance ? JSON.stringify(req.body.levelGuidance) : null;
  const designation = req.body.designation || null;
  const requiresQualification = req.body.requiresQualification ? 1 : 0;
  const department = req.body.department || null;
  const subCategory = req.body.subCategory || null;
  const description = req.body.description || null;
  const skillType = req.body.skillType || "Functional";
  const status = req.body.status === "Inactive" ? "Inactive" : "Active";
  const remarks = req.body.remarks || null;
  const modifiedBy = req.body.actorName || req.user.role;

  const [existingRows] = await pool.query(`SELECT * FROM skills WHERE id = ?`, [req.params.id]);
  const existing = existingRows[0];

  if (req.user.role === "Manager") {
    const dept = await getManagerDept(req.user.id, req.user.employeeId);
    if (!existing || existing.owner_department !== dept) {
      return res.status(403).json({ error: "You can only edit skills your own department maintains." });
    }
    // A Manager can change WHO this skill is eligible for (department/designation), but not who owns it.
    await pool.query(
      `UPDATE skills SET name=?, category=?, department=?, designation=?, criticality=?, level_guidance=?, requires_qualification=?,
       sub_category=?, description=?, skill_type=?, status=?, remarks=?, version=version+1, modified_by=?, modified_date=NOW() WHERE id=?`,
      [name, category, department, designation, criticality, levelGuidance, requiresQualification, subCategory, description, skillType, status, remarks, modifiedBy, req.params.id]
    );
  } else {
    const ownerDepartment = req.body.ownerDepartment || null;
    await pool.query(
      `UPDATE skills SET name=?, category=?, department=?, designation=?, owner_department=?, criticality=?, level_guidance=?, requires_qualification=?,
       sub_category=?, description=?, skill_type=?, status=?, remarks=?, version=version+1, modified_by=?, modified_date=NOW() WHERE id=?`,
      [name, category, department, designation, ownerDepartment, criticality, levelGuidance, requiresQualification, subCategory, description, skillType, status, remarks, modifiedBy, req.params.id]
    );
  }

  if (existing) {
    const changes = diffFields(existing, req.body, SKILL_FIELD_MAP);
    if (Object.keys(changes).length) {
      await logAudit(req, { entityType: "skill", entityId: req.params.id, action: "updated", summary: summarizeChanges(changes), changes });
    }
  }
  res.json({ ok: true });
});

// DELETE /api/skills/:id — Admin/HR (any), Manager (only skills they own)
router.delete("/:id", requireAuth, requireRole("Admin", "HR", "Manager"), async (req, res) => {
  const [rows0] = await pool.query(`SELECT name, owner_department FROM skills WHERE id = ?`, [req.params.id]);
  if (req.user.role === "Manager") {
    const dept = await getManagerDept(req.user.id, req.user.employeeId);
    if (!rows0[0] || rows0[0].owner_department !== dept) {
      return res.status(403).json({ error: "You can only delete skills your own department maintains." });
    }
  }
  await pool.query(`DELETE FROM skills WHERE id = ?`, [req.params.id]);
  await logAudit(req, { entityType: "skill", entityId: req.params.id, action: "deleted", summary: `Skill "${rows0[0]?.name || req.params.id}" deleted` });
  res.json({ ok: true });
});

// POST /api/skills/bulk-import — Admin/HR only (matches local version's rule)
router.post("/bulk-import", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  const rows = req.body.rows || [];
  const createdBy = req.body.actorName || req.user.role;
  let imported = 0;
  for (const r of rows) {
    if (!r.name) continue;
    const id = uuidv4();
    await pool.query(
      `INSERT INTO skills (id, name, category, department, designation, owner_department, criticality, sub_category, description, skill_type, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, r.name, r.category || "Technical", r.department || null, r.designation || null, r.ownerDepartment || null, r.criticality || "Normal",
       r.subCategory || null, r.description || null, r.skillType || "Functional", r.status === "Inactive" ? "Inactive" : "Active", r.remarks || null, createdBy]
    );
    imported++;
  }
  await logAudit(req, { entityType: "skill", entityId: `bulk-${Date.now()}`, action: "bulkImported", summary: `${imported} skills imported via bulk import` });
  res.json({ imported });
});

// ---- Proficiency Level Master — configurable per the spec's explicit recommendation, rather
// than hard-coded. Kept on the existing 0-4 numeric range your skill_matrix data already uses;
// only the labels/descriptions are configurable, never the underlying stored number. ----

// GET /api/skills/proficiency-levels — everyone can view (needed to render level names anywhere
// a proficiency is shown)
router.get("/proficiency-levels", requireAuth, async (req, res) => {
  const [rows] = await pool.query(`SELECT * FROM proficiency_levels ORDER BY display_order`);
  res.json(rows.map((r) => ({
    id: r.id, levelNumber: r.level_number, levelName: r.level_name,
    levelDescription: r.level_description, status: r.status, displayOrder: r.display_order,
  })));
});

// PUT /api/skills/proficiency-levels/:id — Admin/HR only: rename/redescribe/activate a level.
// The level_number itself is intentionally not editable here — it's the stable numeric anchor
// every stored proficiency value in skill_matrix refers to; only the label can change.
router.put("/proficiency-levels/:id", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  const { levelName, levelDescription, status } = req.body;
  await pool.query(
    `UPDATE proficiency_levels SET level_name=?, level_description=?, status=? WHERE id=?`,
    [levelName, levelDescription || null, status === "Inactive" ? "Inactive" : "Active", req.params.id]
  );
  await logAudit(req, { entityType: "proficiencyLevel", entityId: req.params.id, action: "updated", summary: `Proficiency level renamed to "${levelName}"` });
  res.json({ ok: true });
});

module.exports = router;
