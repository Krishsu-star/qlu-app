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
  return { id: r.id, name: r.name, category: r.category, department: r.department, criticality: r.criticality || "Normal", levelGuidance };
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

// POST /api/skills — Admin/HR (any department), or Manager (own department only)
router.post("/", requireAuth, requireRole("Admin", "HR", "Manager"), async (req, res) => {
  const { name, category } = req.body;
  const criticality = req.body.criticality || "Normal";
  const levelGuidance = req.body.levelGuidance ? JSON.stringify(req.body.levelGuidance) : null;
  let department = req.body.department || null;

  if (req.user.role === "Manager") {
    const dept = await getManagerDept(req.user.id, req.user.employeeId);
    department = dept; // Managers can only create skills scoped to their own department
  }

  const id = uuidv4();
  await pool.query(`INSERT INTO skills (id, name, category, department, criticality, level_guidance) VALUES (?,?,?,?,?,?)`, [id, name, category, department, criticality, levelGuidance]);
  res.status(201).json({ id });
});

// PUT /api/skills/:id — Admin/HR (any), Manager (only if it's their department's skill)
router.put("/:id", requireAuth, requireRole("Admin", "HR", "Manager"), async (req, res) => {
  const { name, category } = req.body;
  const criticality = req.body.criticality || "Normal";
  const levelGuidance = req.body.levelGuidance ? JSON.stringify(req.body.levelGuidance) : null;

  if (req.user.role === "Manager") {
    const dept = await getManagerDept(req.user.id, req.user.employeeId);
    const [rows] = await pool.query(`SELECT department FROM skills WHERE id = ?`, [req.params.id]);
    if (!rows[0] || rows[0].department !== dept) {
      return res.status(403).json({ error: "You can only edit skills belonging to your own department." });
    }
    await pool.query(`UPDATE skills SET name=?, category=?, criticality=?, level_guidance=? WHERE id=?`, [name, category, criticality, levelGuidance, req.params.id]);
    return res.json({ ok: true });
  }

  const department = req.body.department;
  await pool.query(`UPDATE skills SET name=?, category=?, department=?, criticality=?, level_guidance=? WHERE id=?`, [name, category, department || null, criticality, levelGuidance, req.params.id]);
  res.json({ ok: true });
});

// DELETE /api/skills/:id
router.delete("/:id", requireAuth, requireRole("Admin", "HR", "Manager"), async (req, res) => {
  if (req.user.role === "Manager") {
    const dept = await getManagerDept(req.user.id, req.user.employeeId);
    const [rows] = await pool.query(`SELECT department FROM skills WHERE id = ?`, [req.params.id]);
    if (!rows[0] || rows[0].department !== dept) {
      return res.status(403).json({ error: "You can only delete skills belonging to your own department." });
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
    await pool.query(`INSERT INTO skills (id, name, category, department, criticality) VALUES (?,?,?,?,?)`, [uuidv4(), r.name, r.category || "Technical", r.department || null, r.criticality || "Normal"]);
    imported++;
  }
  res.json({ imported });
});

module.exports = router;
