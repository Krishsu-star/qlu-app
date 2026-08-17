const { randomUUID: uuidv4 } = require("crypto");
const pool = require("./db");

// Shared, reusable audit-trail writer. Any route file can `require("../auditLogger")` and call
// logAudit() to record a change to the company-wide trail — session_id is optional and only
// meaningful for entities that belong to a training session (e.g. attendance); everything else
// can leave it null.
//
// IMPORTANT: audit_log rows are never updated or deleted, and the table is NOT foreign-keyed to
// anything else with ON DELETE CASCADE — so the trail survives even if the record it describes
// is later deleted. That's the whole point of an audit trail in a regulated environment: it must
// outlive the thing it's describing.
//
// `req.body.actorName` is auto-injected by the frontend's api.js on every mutating request (see
// api.js's request() function), so this generally "just works" without each route needing to
// thread a name through manually — but falls back to the authenticated role if it's ever missing.
async function logAudit(req, { entityType, entityId, sessionId = null, action, summary, changes = null, reason = null }) {
  const performedBy = (req.body && req.body.actorName) || (req.user && req.user.role) || "System";
  const performedRole = (req.user && req.user.role) || null;
  await pool.query(
    `INSERT INTO audit_log (id, entity_type, entity_id, session_id, action, summary, changes, performed_by, performed_role, reason)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [uuidv4(), entityType, entityId, sessionId, action, summary,
     changes && Object.keys(changes).length ? JSON.stringify(changes) : null,
     performedBy, performedRole, reason || null]
  );
}

// Compares an existing DB row (snake_case keys, as returned by SELECT *) against new incoming
// values (camelCase keys, as sent by the frontend) for a given field map, returning only the
// fields that actually changed, as { field: { from, to } }. Values are compared as strings so
// e.g. a boolean 0/1 vs false/true or a Date vs a date string don't register as false changes.
function diffFields(oldRow, newValues, fieldMap) {
  const changes = {};
  for (const [jsonKey, dbKey] of Object.entries(fieldMap)) {
    const oldVal = oldRow[dbKey];
    const newVal = newValues[jsonKey];
    const oldStr = oldVal === null || oldVal === undefined ? "" : String(oldVal);
    const newStr = newVal === null || newVal === undefined ? "" : String(newVal);
    if (oldStr !== newStr) changes[jsonKey] = { from: oldVal ?? null, to: newVal ?? null };
  }
  return changes;
}

// Turns a diffFields() result into a short human-readable line for the summary column, e.g.
// `status: "Completed" → "Trainer Confirmed"; venue: "—" → "Hall A"`.
function summarizeChanges(changes) {
  const keys = Object.keys(changes);
  if (!keys.length) return "No fields changed";
  return keys.map((k) => `${k}: "${changes[k].from ?? "—"}" → "${changes[k].to ?? "—"}"`).join("; ");
}

module.exports = { logAudit, diffFields, summarizeChanges };
