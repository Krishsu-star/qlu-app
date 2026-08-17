const express = require("express");
const { randomUUID: uuidv4 } = require("crypto");
const bcrypt = require("bcryptjs");
const pool = require("../db");
const { requireAuth, requireRole } = require("../authMiddleware");
const { logAudit, diffFields, summarizeChanges } = require("../auditLogger");

const router = express.Router();

// Maps the JSON keys the frontend sends to the DB columns they correspond to — used by
// diffFields() to work out exactly what changed on a PUT /:id.
const EMPLOYEE_FIELD_MAP = {
  name: "name", associateCode: "associate_code", department: "department", role: "role_title",
  designation: "designation", grade: "grade", payGroup: "pay_group", orgName: "org_name",
  doj: "doj", dob: "dob", manager: "manager", hod: "hod", email: "email", mobile: "mobile",
  qualification: "qualification",
};

function rowToEmployee(r) {
  return {
    id: r.id,
    name: r.name,
    associateCode: r.associate_code,
    department: r.department,
    role: r.role_title,
    designation: r.designation,
    grade: r.grade,
    payGroup: r.pay_group,
    orgName: r.org_name,
    doj: r.doj,
    dob: r.dob,
    manager: r.manager,
    hod: r.hod,
    email: r.email,
    mobile: r.mobile,
    qualification: r.qualification,
  };
}

// GET /api/employees — scoped by role (Admin/HR: all, Manager: self+team, User: self)
router.get("/", requireAuth, async (req, res) => {
  const [rows] = await pool.query(`SELECT * FROM employees ORDER BY name`);
  let employees = rows.map(rowToEmployee);

  if (req.user.role === "User") {
    employees = employees.filter((e) => e.id === req.user.employeeId);
  } else if (req.user.role === "Manager") {
    const me = employees.find((e) => e.id === req.user.employeeId);
    if (me) {
      employees = employees.filter((e) => e.id === me.id || (e.manager && e.manager.trim().toLowerCase() === me.name.trim().toLowerCase()));
    } else {
      employees = [];
    }
  }
  res.json(employees);
});

// POST /api/employees  (Admin/HR only) — body: employee fields + optional accessRole
router.post("/", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  const b = req.body;
  const id = uuidv4();
  await pool.query(
    `INSERT INTO employees (id, name, associate_code, department, role_title, designation, grade, pay_group, org_name, doj, dob, manager, hod, email, mobile, qualification)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, b.name, b.associateCode || null, b.department, b.role, b.designation, b.grade, b.payGroup, b.orgName, b.doj || null, b.dob || null, b.manager, b.hod, b.email, b.mobile, b.qualification]
  );
  await logAudit(req, {
    entityType: "employee", entityId: id, action: "created",
    summary: `Employee "${b.name}" created (${b.department || "—"}, ${b.designation || "—"})`,
  });

  // Optional: create a login at the same time (Admin only), mirroring the local version's flow
  if (req.user.role === "Admin" && b.accessRole && b.associateCode) {
    const tempPassword = Math.random().toString(36).slice(-8) + "A1";
    const hash = await bcrypt.hash(tempPassword, 10);
    const userId = uuidv4();
    await pool.query(
      `INSERT INTO users (id, employee_id, username, password_hash, display_name, role, must_change_password) VALUES (?,?,?,?,?,?,1)`,
      [userId, id, b.associateCode, hash, b.name, b.accessRole]
    );
    await logAudit(req, {
      entityType: "userAccount", entityId: userId, action: "created",
      summary: `Login created for "${b.name}" (username ${b.associateCode}, role ${b.accessRole})`,
    });
    return res.status(201).json({ id, tempPassword, username: b.associateCode });
  }
  res.status(201).json({ id });
});

// PUT /api/employees/:id  (Admin/HR only) — every change logged with a field-level diff.
router.put("/:id", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  const b = req.body;
  const [existingRows] = await pool.query(`SELECT * FROM employees WHERE id = ?`, [req.params.id]);
  const existing = existingRows[0];

  await pool.query(
    `UPDATE employees SET name=?, associate_code=?, department=?, role_title=?, designation=?, grade=?, pay_group=?, org_name=?, doj=?, dob=?, manager=?, hod=?, email=?, mobile=?, qualification=? WHERE id=?`,
    [b.name, b.associateCode || null, b.department, b.role, b.designation, b.grade, b.payGroup, b.orgName, b.doj || null, b.dob || null, b.manager, b.hod, b.email, b.mobile, b.qualification, req.params.id]
  );

  if (existing) {
    const changes = diffFields(existing, b, EMPLOYEE_FIELD_MAP);
    if (Object.keys(changes).length) {
      await logAudit(req, {
        entityType: "employee", entityId: req.params.id, action: "updated",
        summary: summarizeChanges(changes), changes,
      });
    }
  }
  res.json({ ok: true });
});

// DELETE /api/employees/:id  (Admin/HR only) — cascades via FK constraints. Logged BEFORE
// deleting (and the audit entry isn't itself cascade-deleted), so the record of "this employee
// existed and was removed, by whom and when" survives permanently.
router.delete("/:id", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  const [rows] = await pool.query(`SELECT name, department FROM employees WHERE id = ?`, [req.params.id]);
  await pool.query(`DELETE FROM employees WHERE id = ?`, [req.params.id]);
  await logAudit(req, {
    entityType: "employee", entityId: req.params.id, action: "deleted",
    summary: `Employee "${rows[0]?.name || req.params.id}" deleted${rows[0]?.department ? ` (${rows[0].department})` : ""}`,
  });
  res.json({ ok: true });
});

// POST /api/employees/bulk-import  (Admin/HR only) — body: { rows: [...] }. Each imported
// employee (and each login created alongside one) gets its own audit entry, same as a single
// manual add — a bulk import is still individually attributable records, not one opaque event.
router.post("/bulk-import", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  const rows = req.body.rows || [];
  let imported = 0;
  const credentials = [];
  for (const r of rows) {
    if (!r.name) continue;
    const id = uuidv4();
    await pool.query(
      `INSERT INTO employees (id, name, associate_code, department, role_title, designation, grade, pay_group, org_name, doj, dob, manager, hod, email, mobile, qualification)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, r.name, r.associateCode || null, r.department, r.role, r.designation, r.grade, r.payGroup, r.orgName, r.doj || null, r.dob || null, r.manager, r.hod, r.email, r.mobile, r.qualification]
    );
    await logAudit(req, {
      entityType: "employee", entityId: id, action: "created",
      summary: `Employee "${r.name}" created via bulk import (${r.department || "—"}, ${r.designation || "—"})`,
    });
    imported++;
    if (req.user.role === "Admin" && r.accessRole && r.associateCode) {
      const tempPassword = Math.random().toString(36).slice(-8) + "A1";
      const hash = await bcrypt.hash(tempPassword, 10);
      const userId = uuidv4();
      await pool.query(
        `INSERT INTO users (id, employee_id, username, password_hash, display_name, role, must_change_password) VALUES (?,?,?,?,?,?,1)`,
        [userId, id, r.associateCode, hash, r.name, r.accessRole]
      );
      await logAudit(req, {
        entityType: "userAccount", entityId: userId, action: "created",
        summary: `Login created for "${r.name}" via bulk import (username ${r.associateCode}, role ${r.accessRole})`,
      });
      credentials.push({ name: r.name, username: r.associateCode, password: tempPassword });
    }
  }
  res.json({ imported, credentials });
});

module.exports = router;
