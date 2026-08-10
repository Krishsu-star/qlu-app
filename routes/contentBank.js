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
const sigUpload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

function rowToContent(r) {
  return {
    id: r.id, title: r.title, type: r.type, skillId: r.skill_id, academy: r.academy, questionnaireId: r.questionnaire_id,
    link: r.link, filePath: r.file_path ? `/uploads/${path.basename(r.file_path)}` : null,
    description: r.description, dateAdded: r.date_added,
  };
}

// ---- Courses (Learning Academy) ----

router.get("/", requireAuth, async (req, res) => {
  const [rows] = await pool.query(`SELECT * FROM content_bank ORDER BY date_added DESC`);
  res.json(rows.map(rowToContent));
});

router.post("/", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  const { title, type, skillId, academy, questionnaireId, link, description } = req.body;
  const id = uuidv4();
  await pool.query(
    `INSERT INTO content_bank (id, title, type, skill_id, academy, questionnaire_id, link, description, date_added) VALUES (?,?,?,?,?,?,?,?,CURDATE())`,
    [id, title, type, skillId || null, academy || null, questionnaireId || null, link || null, description]
  );
  res.status(201).json({ id });
});

router.post("/upload", requireAuth, requireRole("Admin", "HR"), upload.single("file"), async (req, res) => {
  const { title, type, skillId, academy, questionnaireId, description } = req.body;
  if (!req.file) return res.status(400).json({ error: "No file received." });
  const id = uuidv4();
  await pool.query(
    `INSERT INTO content_bank (id, title, type, skill_id, academy, questionnaire_id, file_path, description, date_added) VALUES (?,?,?,?,?,?,?,?,CURDATE())`,
    [id, title, type, skillId || null, academy || null, questionnaireId || null, req.file.path, description]
  );
  res.status(201).json({ id, filePath: `/uploads/${req.file.filename}` });
});

router.put("/:id", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  const { title, type, skillId, academy, questionnaireId, link, description } = req.body;
  await pool.query(
    `UPDATE content_bank SET title=?, type=?, skill_id=?, academy=?, questionnaire_id=?, link=?, description=? WHERE id=?`,
    [title, type, skillId || null, academy || null, questionnaireId || null, link || null, description, req.params.id]
  );
  res.json({ ok: true });
});

router.delete("/:id", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  const [rows] = await pool.query(`SELECT file_path FROM content_bank WHERE id = ?`, [req.params.id]);
  if (rows[0]?.file_path && fs.existsSync(rows[0].file_path)) fs.unlink(rows[0].file_path, () => {});
  await pool.query(`DELETE FROM content_bank WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
});

// ---- Completions & Certificates ----

router.get("/completions", requireAuth, async (req, res) => {
  const scope = req.user.role === "Admin" || req.user.role === "HR" ? null : req.user.employeeId;
  const [rows] = scope
    ? await pool.query(`SELECT * FROM course_completions WHERE employee_id = ?`, [scope])
    : await pool.query(`SELECT * FROM course_completions`);
  res.json(rows.map((r) => ({ id: r.id, employeeId: r.employee_id, contentId: r.content_id, completedDate: r.completed_date, score: r.score })));
});

router.post("/completions", requireAuth, async (req, res) => {
  const { contentId, score } = req.body;
  const [existing] = await pool.query(`SELECT id FROM course_completions WHERE employee_id = ? AND content_id = ?`, [req.user.employeeId, contentId]);
  if (existing.length > 0) return res.json({ ok: true, alreadyCompleted: true });
  const id = uuidv4();
  await pool.query(`INSERT INTO course_completions (id, employee_id, content_id, completed_date, score) VALUES (?,?,?,CURDATE(),?)`, [id, req.user.employeeId, contentId, score ?? null]);
  res.status(201).json({ id });
});

router.get("/certificate-settings", requireAuth, async (req, res) => {
  const [rows] = await pool.query(`SELECT * FROM certificate_settings LIMIT 1`);
  const r = rows[0];
  res.json(r ? {
    siteHeadName: r.site_head_name, siteHeadSig: r.site_head_sig ? `/uploads/${path.basename(r.site_head_sig)}` : null,
    hrName: r.hr_name, hrSig: r.hr_sig ? `/uploads/${path.basename(r.hr_sig)}` : null, appreciationText: r.appreciation_text,
  } : { siteHeadName: "", siteHeadSig: null, hrName: "", hrSig: null, appreciationText: "In recognition of successfully completing this course with dedication and commitment to continuous learning." });
});

router.put("/certificate-settings", requireAuth, requireRole("Admin", "HR"), sigUpload.fields([{ name: "siteHeadSig", maxCount: 1 }, { name: "hrSig", maxCount: 1 }]), async (req, res) => {
  const { siteHeadName, hrName, appreciationText } = req.body;
  const [existing] = await pool.query(`SELECT * FROM certificate_settings LIMIT 1`);
  const siteHeadSigPath = req.files?.siteHeadSig?.[0]?.path || existing[0]?.site_head_sig || null;
  const hrSigPath = req.files?.hrSig?.[0]?.path || existing[0]?.hr_sig || null;
  if (existing.length > 0) {
    await pool.query(`UPDATE certificate_settings SET site_head_name=?, site_head_sig=?, hr_name=?, hr_sig=?, appreciation_text=? WHERE id=?`, [siteHeadName, siteHeadSigPath, hrName, hrSigPath, appreciationText, existing[0].id]);
  } else {
    await pool.query(`INSERT INTO certificate_settings (id, site_head_name, site_head_sig, hr_name, hr_sig, appreciation_text) VALUES ('singleton',?,?,?,?,?)`, [siteHeadName, siteHeadSigPath, hrName, hrSigPath, appreciationText]);
  }
  res.json({ ok: true });
});

module.exports = router;
