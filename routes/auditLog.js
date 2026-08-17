const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../authMiddleware");

const router = express.Router();

function rowToEntry(r) {
  return {
    id: r.id, entityType: r.entity_type, entityId: r.entity_id, sessionId: r.session_id,
    action: r.action, summary: r.summary,
    changes: r.changes ? (typeof r.changes === "string" ? JSON.parse(r.changes) : r.changes) : null,
    performedBy: r.performed_by, performedRole: r.performed_role, reason: r.reason,
    createdAt: r.created_at,
  };
}

// GET /api/audit-log — company-wide audit trail, filterable. Restricted to Admin/HR/QA:
// this is sensitive, company-wide change history, and QA is included specifically because
// they're the role that fields regulatory/customer audits in this system.
//
// Defaults to the last 90 days if no date range is given, and caps at 1000 rows per request
// to stay responsive as the log grows — narrow with filters (date range, module, person,
// search text) to go further back or drill into specifics.
//
// Query params (all optional): entityType, sessionId, performedBy, from (YYYY-MM-DD),
// to (YYYY-MM-DD), search (matches summary or reason).
router.get("/", requireAuth, requireRole("Admin", "HR", "QA"), async (req, res) => {
  const { entityType, sessionId, performedBy, from, to, search } = req.query;
  const where = [];
  const params = [];
  if (entityType) { where.push("entity_type = ?"); params.push(entityType); }
  if (sessionId) { where.push("(session_id = ? OR entity_id = ?)"); params.push(sessionId, sessionId); }
  if (performedBy) { where.push("performed_by LIKE ?"); params.push(`%${performedBy}%`); }
  if (from) { where.push("created_at >= ?"); params.push(from); }
  if (to) { where.push("created_at <= ?"); params.push(`${to} 23:59:59`); }
  if (search) { where.push("(summary LIKE ? OR reason LIKE ?)"); params.push(`%${search}%`, `%${search}%`); }
  if (!from && !to) { where.push("created_at >= (NOW() - INTERVAL 90 DAY)"); }

  const sql = `SELECT * FROM audit_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT 1000`;
  const [rows] = await pool.query(sql, params);
  res.json(rows.map(rowToEntry));
});

// GET /api/audit-log/entity-types — distinct entity_type values currently in the log, so the
// frontend filter dropdown only ever shows options that actually have data (grows automatically
// as more modules get wired in, no frontend change needed).
router.get("/entity-types", requireAuth, requireRole("Admin", "HR", "QA"), async (req, res) => {
  const [rows] = await pool.query(`SELECT DISTINCT entity_type FROM audit_log ORDER BY entity_type`);
  res.json(rows.map((r) => r.entity_type));
});

module.exports = router;
