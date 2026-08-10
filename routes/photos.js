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
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

router.get("/", requireAuth, async (req, res) => {
  const [rows] = await pool.query(`SELECT * FROM photos ORDER BY date_added DESC`);
  res.json(rows.map((r) => ({
    id: r.id, sessionId: r.session_id, caption: r.caption,
    filePath: `/uploads/${path.basename(r.file_path)}`, uploadedBy: r.uploaded_by, dateAdded: r.date_added,
  })));
});

router.post("/", requireAuth, requireRole("Admin", "HR", "Manager"), upload.single("file"), async (req, res) => {
  const { sessionId, caption } = req.body;
  if (!req.file) return res.status(400).json({ error: "No file received." });
  const id = uuidv4();
  await pool.query(
    `INSERT INTO photos (id, session_id, caption, file_path, uploaded_by, date_added) VALUES (?,?,?,?,?,CURDATE())`,
    [id, sessionId || null, caption || "", req.file.path, req.user.displayName]
  );
  res.status(201).json({ id, filePath: `/uploads/${req.file.filename}` });
});

router.delete("/:id", requireAuth, requireRole("Admin", "HR", "Manager"), async (req, res) => {
  const [rows] = await pool.query(`SELECT file_path FROM photos WHERE id = ?`, [req.params.id]);
  if (rows[0]?.file_path && fs.existsSync(rows[0].file_path)) fs.unlink(rows[0].file_path, () => {});
  await pool.query(`DELETE FROM photos WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
