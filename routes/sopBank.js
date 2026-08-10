const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { randomUUID: uuidv4 } = require("crypto");
const pool = require("../db");
const { requireAuth, requireRole } = require("../authMiddleware");

const router = express.Router();

const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9_.-]/g, "_")}`),
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// Uploading/maintaining SOPs: Admin/HR for now — a dedicated QA login role isn't in the live
// database yet (it exists in the laptop version only), so QA-specific rights aren't split out
// here until that role is added to the server too.
function canManage(role) { return role === "Admin" || role === "HR"; }

async function scopeEmployeeIds(user) {
  if (user.role === "Admin" || user.role === "HR") return null; // no restriction
  if (user.role === "Manager") {
    const [me] = await pool.query(`SELECT name FROM employees WHERE id = ?`, [user.employeeId]);
    const [team] = await pool.query(`SELECT id FROM employees WHERE manager = ?`, [me[0]?.name || ""]);
    return new Set([user.employeeId, ...team.map((r) => r.id)]);
  }
  return new Set([user.employeeId]);
}

// GET /api/sop-bank — every SOP document
router.get("/", requireAuth, async (req, res) => {
  const [rows] = await pool.query(`SELECT * FROM sop_documents ORDER BY date_added DESC`);
  res.json(rows.map((r) => ({
    id: r.id, title: r.title, department: r.department, link: r.link,
    filePath: r.file_path ? `/uploads/${path.basename(r.file_path)}` : null,
    questionnaireId: r.questionnaire_id, uploadedBy: r.uploaded_by, dateAdded: r.date_added,
  })));
});

router.post("/", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  const { title, department, link, questionnaireId } = req.body;
  const id = uuidv4();
  await pool.query(
    `INSERT INTO sop_documents (id, title, department, link, questionnaire_id, uploaded_by, date_added) VALUES (?,?,?,?,?,?,CURDATE())`,
    [id, title, department || null, link || null, questionnaireId || null, req.user.displayName]
  );
  res.status(201).json({ id });
});

router.post("/upload", requireAuth, requireRole("Admin", "HR"), upload.single("file"), async (req, res) => {
  const { title, department, questionnaireId } = req.body;
  if (!req.file) return res.status(400).json({ error: "No file received." });
  const id = uuidv4();
  await pool.query(
    `INSERT INTO sop_documents (id, title, department, file_path, questionnaire_id, uploaded_by, date_added) VALUES (?,?,?,?,?,?,CURDATE())`,
    [id, title, department || null, req.file.path, questionnaireId || null, req.user.displayName]
  );
  res.status(201).json({ id, filePath: `/uploads/${req.file.filename}` });
});

router.delete("/:id", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  const [rows] = await pool.query(`SELECT file_path FROM sop_documents WHERE id = ?`, [req.params.id]);
  if (rows[0]?.file_path && fs.existsSync(rows[0].file_path)) fs.unlink(rows[0].file_path, () => {});
  await pool.query(`DELETE FROM sop_documents WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
});

// ---- Assignments ----

// GET /api/sop-bank/assignments — scoped: Admin/HR see all, Manager sees own team, User sees self
router.get("/assignments", requireAuth, async (req, res) => {
  const scope = await scopeEmployeeIds(req.user);
  let rows;
  if (!scope) {
    [rows] = await pool.query(`SELECT * FROM sop_assignments`);
  } else if (scope.size === 0) {
    rows = [];
  } else {
    [rows] = await pool.query(`SELECT * FROM sop_assignments WHERE employee_id IN (?)`, [Array.from(scope)]);
  }
  res.json(rows.map((r) => ({
    id: r.id, sopId: r.sop_id, employeeId: r.employee_id, assignedBy: r.assigned_by,
    assignmentType: r.assignment_type, assignedDate: r.assigned_date, readDate: r.read_date,
    testScore: r.test_score, completedDate: r.completed_date,
  })));
});

// POST /api/sop-bank/assignments — Admin/HR/Manager can assign
router.post("/assignments", requireAuth, requireRole("Admin", "HR", "Manager"), async (req, res) => {
  const { sopId, employeeId, assignmentType } = req.body;
  const id = uuidv4();
  await pool.query(
    `INSERT INTO sop_assignments (id, sop_id, employee_id, assigned_by, assignment_type, assigned_date) VALUES (?,?,?,?,?,CURDATE())`,
    [id, sopId, employeeId, req.user.displayName, assignmentType || "Induction"]
  );
  res.status(201).json({ id });
});

// PUT /api/sop-bank/assignments/:id/read — the assigned employee marks it read
router.put("/assignments/:id/read", requireAuth, async (req, res) => {
  const [rows] = await pool.query(`SELECT employee_id FROM sop_assignments WHERE id = ?`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found." });
  if (rows[0].employee_id !== req.user.employeeId && !["Admin", "HR"].includes(req.user.role)) {
    return res.status(403).json({ error: "You can only mark your own assignments as read." });
  }
  await pool.query(`UPDATE sop_assignments SET read_date = CURDATE() WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
});

// PUT /api/sop-bank/assignments/:id/complete — records a test score and marks it complete
router.put("/assignments/:id/complete", requireAuth, async (req, res) => {
  const { score } = req.body;
  const [rows] = await pool.query(`SELECT employee_id FROM sop_assignments WHERE id = ?`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found." });
  if (rows[0].employee_id !== req.user.employeeId && !["Admin", "HR"].includes(req.user.role)) {
    return res.status(403).json({ error: "You can only complete your own assignments." });
  }
  await pool.query(`UPDATE sop_assignments SET test_score = ?, completed_date = CURDATE() WHERE id = ?`, [score ?? null, req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
