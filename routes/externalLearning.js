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
     b.estimatedDuration || null, b.language || "English", b.costType || "Free Learning", b.externalUrl,
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
     b.estimatedDuration || null, b.language || "English", b.costType || "Free Learning", b.externalUrl,
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

function rowToProgress(r) {
  return {
    id: r.id, employeeId: r.employee_id, resourceId: r.resource_id, status: r.status,
    startedDate: r.started_date, completedDate: r.completed_date,
    certificateNumber: r.certificate_number, certificateCompletionDate: r.certificate_completion_date,
    certificateExpiryDate: r.certificate_expiry_date, certificateFilePath: r.certificate_file_path,
    certificateRemarks: r.certificate_remarks,
    verifiedBy: r.verified_by, verifiedDate: r.verified_date, verificationRemarks: r.verification_remarks,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// GET /api/external-learning/progress/mine — the signed-in employee's own progress records,
// across every resource they've started. Used to show status/actions on each resource card and
// to build their personal "My External Learning" history.
router.get("/progress/mine", requireAuth, async (req, res) => {
  if (!req.user.employeeId) return res.json([]);
  const [rows] = await pool.query(`SELECT * FROM external_learning_progress WHERE employee_id = ?`, [req.user.employeeId]);
  res.json(rows.map(rowToProgress));
});

// GET /api/external-learning/progress/all — Admin/HR/QA: everyone's progress, for oversight and
// to build the certificate verification queue.
router.get("/progress/all", requireAuth, requireRole("Admin", "HR", "QA"), async (req, res) => {
  const [rows] = await pool.query(`SELECT * FROM external_learning_progress ORDER BY updated_at DESC`);
  res.json(rows.map(rowToProgress));
});

// POST /api/external-learning/:resourceId/progress — the employee updates their OWN status for a
// resource: Not Started -> In Progress -> Completed -> Certificate Submitted (text-based
// certificate details for now; file attachment is Phase 2b). Upserts one row per employee+resource.
// Deliberately self-service and un-gated by role — this is the employee's own learning record,
// not an admin action; Verified/Rejected are excluded here and can only be set via /verify below.
router.post("/:resourceId/progress", requireAuth, async (req, res) => {
  if (!req.user.employeeId) return res.status(400).json({ error: "This account isn't linked to an employee record, so progress can't be tracked." });
  const { status, certificateNumber, certificateCompletionDate, certificateExpiryDate, certificateRemarks } = req.body;
  const selfServiceStatuses = ["Not Started", "In Progress", "Completed", "Certificate Submitted"];
  if (!selfServiceStatuses.includes(status)) return res.status(400).json({ error: "Invalid status." });

  const [existingRows] = await pool.query(`SELECT * FROM external_learning_progress WHERE employee_id = ? AND resource_id = ?`, [req.user.employeeId, req.params.resourceId]);
  const existing = existingRows[0];
  const today = new Date().toISOString().slice(0, 10);

  if (existing) {
    const sets = ["status = ?"];
    const params = [status];
    if (status === "In Progress" && !existing.started_date) { sets.push("started_date = ?"); params.push(today); }
    if (status === "Completed" && !existing.completed_date) { sets.push("completed_date = ?"); params.push(today); }
    if (status === "Certificate Submitted") {
      sets.push("certificate_number = ?", "certificate_completion_date = ?", "certificate_expiry_date = ?", "certificate_remarks = ?");
      params.push(certificateNumber || null, certificateCompletionDate || null, certificateExpiryDate || null, certificateRemarks || null);
    }
    params.push(existing.id);
    await pool.query(`UPDATE external_learning_progress SET ${sets.join(", ")} WHERE id = ?`, params);
    if (existing.status !== status) {
      await logAudit(req, {
        entityType: "externalLearningProgress", entityId: existing.id, action: "updated",
        summary: `Progress status: ${existing.status} → ${status}`, changes: { status: { from: existing.status, to: status } },
      });
    }
  } else {
    const id = uuidv4();
    await pool.query(
      `INSERT INTO external_learning_progress (id, employee_id, resource_id, status, started_date) VALUES (?,?,?,?,?)`,
      [id, req.user.employeeId, req.params.resourceId, status, status !== "Not Started" ? today : null]
    );
    await logAudit(req, { entityType: "externalLearningProgress", entityId: id, action: "created", summary: `Progress started: ${status}` });
  }
  res.json({ ok: true });
});

// PUT /api/external-learning/progress/:id/verify — Admin/HR/QA only. Moves a "Certificate
// Submitted" record to Verified or Rejected — this is the T&D/QA gate the spec requires before a
// submitted certificate counts as confirmed, and it's the only way to reach either status.
router.put("/progress/:id/verify", requireAuth, requireRole("Admin", "HR", "QA"), async (req, res) => {
  const { decision, remarks } = req.body;
  if (!["Verified", "Rejected"].includes(decision)) return res.status(400).json({ error: "Decision must be Verified or Rejected." });
  const [existingRows] = await pool.query(`SELECT * FROM external_learning_progress WHERE id = ?`, [req.params.id]);
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: "Progress record not found." });
  const verifiedBy = req.body.actorName || req.user.role;
  const today = new Date().toISOString().slice(0, 10);
  await pool.query(
    `UPDATE external_learning_progress SET status = ?, verified_by = ?, verified_date = ?, verification_remarks = ? WHERE id = ?`,
    [decision, verifiedBy, today, remarks || null, req.params.id]
  );
  await logAudit(req, {
    entityType: "externalLearningProgress", entityId: req.params.id, action: decision === "Verified" ? "verified" : "rejected",
    summary: `Certificate ${decision.toLowerCase()} by ${verifiedBy}${remarks ? `: ${remarks}` : ""}`,
    changes: { status: { from: existing.status, to: decision } }, reason: remarks || null,
  });
  res.json({ ok: true });
});

module.exports = router;
