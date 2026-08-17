const express = require("express");
const { randomUUID: uuidv4 } = require("crypto");
const pool = require("../db");
const { requireAuth, requireRole } = require("../authMiddleware");
const { logAudit, diffFields, summarizeChanges } = require("../auditLogger");

const router = express.Router();

const FIELD_MAP = {
  title: "title", provider: "provider", academyCategory: "academy_category", subCategory: "sub_category",
  description: "description", learningLevel: "learning_level", estimatedDuration: "estimated_duration",
  language: "language", costType: "cost_type", externalUrl: "external_url",
  gmpRelated: "gmp_related", certificateAvailable: "certificate_available", active: "active", displayOrder: "display_order",
};

function rowToResource(r) {
  return {
    id: r.id, title: r.title, provider: r.provider, academyCategory: r.academy_category, subCategory: r.sub_category,
    description: r.description, learningLevel: r.learning_level, estimatedDuration: r.estimated_duration,
    language: r.language, costType: r.cost_type, externalUrl: r.external_url,
    recommendedAudience: r.recommended_audience ? (typeof r.recommended_audience === "string" ? JSON.parse(r.recommended_audience) : r.recommended_audience) : [],
    gmpRelated: !!r.gmp_related, certificateAvailable: !!r.certificate_available, active: !!r.active, displayOrder: r.display_order,
    createdBy: r.created_by, createdAt: r.created_at, modifiedBy: r.modified_by, modifiedAt: r.modified_at,
  };
}

// Only http(s) URLs are ever accepted — no javascript:, data:, file:, or other schemes, and HTTPS
// is required (not just permitted) per the spec's security section.
function isSafeHttpsUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

// GET /api/external-learning — employee-facing list. Active resources only, ordered for display.
router.get("/", requireAuth, async (req, res) => {
  const [rows] = await pool.query(`SELECT * FROM external_learning_resources WHERE active = 1 ORDER BY display_order, title`);
  res.json(rows.map(rowToResource));
});

// GET /api/external-learning/all — Admin/HR only: includes inactive resources, for the management screen.
router.get("/all", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  const [rows] = await pool.query(`SELECT * FROM external_learning_resources ORDER BY display_order, title`);
  res.json(rows.map(rowToResource));
});

// POST /api/external-learning — Admin/HR create a resource.
router.post("/", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  const b = req.body;
  if (!isSafeHttpsUrl(b.externalUrl)) {
    return res.status(400).json({ error: "External URL must be a valid HTTPS link." });
  }
  const id = uuidv4();
  const createdBy = req.body.actorName || req.user.role;
  await pool.query(
    `INSERT INTO external_learning_resources
      (id, title, provider, academy_category, sub_category, description, learning_level, estimated_duration, language, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, b.title, b.provider, b.academyCategory, b.subCategory || null, b.description || null, b.learningLevel || "All Levels",
     b.estimatedDuration || null, b.language || "English", b.costType || "Free", b.externalUrl,
     JSON.stringify(b.recommendedAudience || []), b.gmpRelated ? 1 : 0, b.certificateAvailable ? 1 : 0,
     b.active === false ? 0 : 1, b.displayOrder || 0, createdBy]
  );
  await logAudit(req, {
    entityType: "externalLearningResource", entityId: id, action: "created",
    summary: `External learning resource "${b.title}" (${b.provider}) created`,
  });
  res.status(201).json({ id });
});

// PUT /api/external-learning/:id — Admin/HR edit any field, including activate/deactivate and
// display order. Every change is logged with a field-level diff via the shared audit trail.
router.put("/:id", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  const b = req.body;
  if (!isSafeHttpsUrl(b.externalUrl)) {
    return res.status(400).json({ error: "External URL must be a valid HTTPS link." });
  }
  const [existingRows] = await pool.query(`SELECT * FROM external_learning_resources WHERE id = ?`, [req.params.id]);
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: "Resource not found." });
  const modifiedBy = req.body.actorName || req.user.role;

  await pool.query(
    `UPDATE external_learning_resources SET
      title=?, provider=?, academy_category=?, sub_category=?, description=?, learning_level=?, estimated_duration=?,
      language=?, cost_type=?, external_url=?, recommended_audience=?, gmp_related=?, certificate_available=?,
      active=?, display_order=?, modified_by=?, modified_at=NOW()
     WHERE id=?`,
    [b.title, b.provider, b.academyCategory, b.subCategory || null, b.description || null, b.learningLevel || "All Levels",
     b.estimatedDuration || null, b.language || "English", b.costType || "Free", b.externalUrl,
     JSON.stringify(b.recommendedAudience || []), b.gmpRelated ? 1 : 0, b.certificateAvailable ? 1 : 0,
     b.active === false ? 0 : 1, b.displayOrder || 0, modifiedBy, req.params.id]
  );

  const changes = diffFields(existing, b, FIELD_MAP);
  if (Object.keys(changes).length) {
    await logAudit(req, {
      entityType: "externalLearningResource", entityId: req.params.id, action: "updated",
      summary: summarizeChanges(changes), changes,
    });
  }
  res.json({ ok: true });
});

// DELETE /api/external-learning/:id — genuine removal (mistaken entries). The normal way to
// retire a resource from circulation is deactivating it via PUT (active: false), which keeps
// its history intact — this endpoint is for entries that should never have existed at all.
router.delete("/:id", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  const [rows] = await pool.query(`SELECT title FROM external_learning_resources WHERE id = ?`, [req.params.id]);
  await pool.query(`DELETE FROM external_learning_resources WHERE id = ?`, [req.params.id]);
  await logAudit(req, {
    entityType: "externalLearningResource", entityId: req.params.id, action: "deleted",
    summary: `External learning resource "${rows[0]?.title || req.params.id}" deleted`,
  });
  res.json({ ok: true });
});

module.exports = router;
