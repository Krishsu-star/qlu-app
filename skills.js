const express = require("express");
const { randomUUID: uuidv4 } = require("crypto");
const pool = require("../db");
const { requireAuth, requireRole } = require("../authMiddleware");

const router = express.Router();

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
    `INSERT INTO skills (id, name, category, department, designation, owner_department, criticality, level_guidance, requires_qualification) VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, name, category, department, designation, ownerDepartment, criticality, levelGuidance, requiresQualification]
  );
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

  if (req.user.role === "Manager") {
    const dept = await getManagerDept(req.user.id, req.user.employeeId);
    const [rows] = await pool.query(`SELECT owner_department FROM skills WHERE id = ?`, [req.params.id]);
    if (!rows[0] || rows[0].owner_department !== dept) {
      return res.status(403).json({ error: "You can only edit skills your own department maintains." });
    }
    // A Manager can change WHO this skill is eligible for (department/designation), but not who owns it.
    await pool.query(`UPDATE skills SET name=?, category=?, department=?, designation=?, criticality=?, level_guidance=?, requires_qualification=? WHERE id=?`, [name, category, department, designation, criticality, levelGuidance, requiresQualification, req.params.id]);
    return res.json({ ok: true });
  }

  const ownerDepartment = req.body.ownerDepartment || null;
  await pool.query(`UPDATE skills SET name=?, category=?, department=?, designation=?, owner_department=?, criticality=?, level_guidance=?, requires_qualification=? WHERE id=?`, [name, category, department, designation, ownerDepartment, criticality, levelGuidance, requiresQualification, req.params.id]);
  res.json({ ok: true });
});

// DELETE /api/skills/:id — Admin/HR (any), Manager (only skills they own)
router.delete("/:id", requireAuth, requireRole("Admin", "HR", "Manager"), async (req, res) => {
  if (req.user.role === "Manager") {
    const dept = await getManagerDept(req.user.id, req.user.employeeId);
    const [rows] = await pool.query(`SELECT owner_department FROM skills WHERE id = ?`, [req.params.id]);
    if (!rows[0] || rows[0].owner_department !== dept) {
      return res.status(403).json({ error: "You can only delete skills your own department maintains." });
    }
  }
  await pool.query(`DELETE FROM skills WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
});

// POST /api/skills/bulk-import — Admin/HR only (matches local version's rule)
router.post("/bulk-import", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  const rows = req.body.rows || [];
  let imported = 0;
  for (const r of rows) {
    if (!r.name) continue;
    await pool.query(
      `INSERT INTO skills (id, name, category, department, designation, owner_department, criticality) VALUES (?,?,?,?,?,?,?)`,
      [uuidv4(), r.name, r.category || "Technical", r.department || null, r.designation || null, r.ownerDepartment || null, r.criticality || "Normal"]
    );
    imported++;
  }
  res.json({ imported });
});

module.exports = router;
