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
// 200MB cap per file — adjust in .env-driven config later if training videos need to be larger
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

function canEdit(role) {
  return role === "Admin" || role === "HR";
}

router.get("/", requireAuth, async (req, res) => {
  const [rows] = await pool.query(`SELECT * FROM content_bank ORDER BY date_added DESC`);
  res.json(rows.map((r) => ({
    id: r.id, title: r.title, type: r.type, skillId: r.skill_id,
    link: r.link, filePath: r.file_path ? `/uploads/${path.basename(r.file_path)}` : null,
    description: r.description, dateAdded: r.date_added,
  })));
});

// POST /api/content-bank — link-based entry (video URL, Drive link, etc.)
router.post("/", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  const { title, type, skillId, link, description } = req.body;
  const id = uuidv4();
  await pool.query(`INSERT INTO content_bank (id, title, type, skill_id, link, description, date_added) VALUES (?,?,?,?,?,?,CURDATE())`, [id, title, type, skillId || null, link || null, description]);
  res.status(201).json({ id });
});

// POST /api/content-bank/upload — real file upload (multipart/form-data), stored on the NAS
router.post("/upload", requireAuth, requireRole("Admin", "HR"), upload.single("file"), async (req, res) => {
  const { title, type, skillId, description } = req.body;
  if (!req.file) return res.status(400).json({ error: "No file received." });
  const id = uuidv4();
  await pool.query(
    `INSERT INTO content_bank (id, title, type, skill_id, file_path, description, date_added) VALUES (?,?,?,?,?,?,CURDATE())`,
    [id, title, type, skillId || null, req.file.path, description]
  );
  res.status(201).json({ id, filePath: `/uploads/${req.file.filename}` });
});

router.put("/:id", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  const { title, type, skillId, link, description } = req.body;
  await pool.query(`UPDATE content_bank SET title=?, type=?, skill_id=?, link=?, description=? WHERE id=?`, [title, type, skillId || null, link || null, description, req.params.id]);
  res.json({ ok: true });
});

router.delete("/:id", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  const [rows] = await pool.query(`SELECT file_path FROM content_bank WHERE id = ?`, [req.params.id]);
  if (rows[0] && rows[0].file_path && fs.existsSync(rows[0].file_path)) {
    fs.unlink(rows[0].file_path, () => {}); // best-effort cleanup, don't block the response on it
  }
  await pool.query(`DELETE FROM content_bank WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
