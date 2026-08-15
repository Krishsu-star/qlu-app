const express = require("express");
const { randomUUID: uuidv4 } = require("crypto");
const bcrypt = require("bcryptjs");
const pool = require("../db");
const { requireAuth, requireRole } = require("../authMiddleware");

const router = express.Router();

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
    separationDate: r.separation_date,
    employmentStatus: r.employment_status,
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
  const separationDate = b.separationDate || null;
  const employmentStatus = separationDate ? "Inactive" : "Active"; // always derived, not client-trusted
  await pool.query(
    `INSERT INTO employees (id, name, associate_code, department, role_title, designation, grade, pay_group, org_name, doj, dob, manager, hod, email, mobile, qualification, separation_date, employment_status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, b.name, b.associateCode || null, b.department, b.role, b.designation, b.grade, b.payGroup, b.orgName, b.doj || null, b.dob || null, b.manager, b.hod, b.email, b.mobile, b.qualification, separationDate, employmentStatus]
  );

  // Optional: create a login at the same time (Admin only), mirroring the local version's flow
  if (req.user.role === "Admin" && b.accessRole && b.associateCode) {
    const tempPassword = Math.random().toString(36).slice(-8) + "A1";
    const hash = await bcrypt.hash(tempPassword, 10);
    await pool.query(
      `INSERT INTO users (id, employee_id, username, password_hash, display_name, role, must_change_password) VALUES (?,?,?,?,?,?,1)`,
      [uuidv4(), id, b.associateCode, hash, b.name, b.accessRole]
    );
    return res.status(201).json({ id, tempPassword, username: b.associateCode });
  }
  res.status(201).json({ id });
});

// PUT /api/employees/:id  (Admin/HR only)
router.put("/:id", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  const b = req.body;
  const separationDate = b.separationDate || null;
  const employmentStatus = separationDate ? "Inactive" : "Active"; // always derived, not client-trusted
  await pool.query(
    `UPDATE employees SET name=?, associate_code=?, department=?, role_title=?, designation=?, grade=?, pay_group=?, org_name=?, doj=?, dob=?, manager=?, hod=?, email=?, mobile=?, qualification=?, separation_date=?, employment_status=? WHERE id=?`,
    [b.name, b.associateCode || null, b.department, b.role, b.designation, b.grade, b.payGroup, b.orgName, b.doj || null, b.dob || null, b.manager, b.hod, b.email, b.mobile, b.qualification, separationDate, employmentStatus, req.params.id]
  );
  res.json({ ok: true, employmentStatus });
});

// DELETE /api/employees/:id  (Admin/HR only) — cascades via FK constraints
router.delete("/:id", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  await pool.query(`DELETE FROM employees WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
});

// POST /api/employees/bulk-import  (Admin/HR only) — body: { rows: [...] }
router.post("/bulk-import", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  const rows = req.body.rows || [];
  let imported = 0;
  const credentials = [];
  const errors = [];
  const validDate = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.name) continue;
    try {
      const id = uuidv4();
      const separationDate = validDate(r.separationDate);
      const employmentStatus = separationDate ? "Inactive" : "Active";
      await pool.query(
        `INSERT INTO employees (id, name, associate_code, department, role_title, designation, grade, pay_group, org_name, doj, dob, manager, hod, email, mobile, qualification, separation_date, employment_status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, r.name, r.associateCode || null, r.department, r.role, r.designation, r.grade, r.payGroup, r.orgName, validDate(r.doj), validDate(r.dob), r.manager, r.hod, r.email, r.mobile, r.qualification, separationDate, employmentStatus]
      );
      imported++;
      if (req.user.role === "Admin" && r.accessRole && r.associateCode) {
        try {
          const tempPassword = Math.random().toString(36).slice(-8) + "A1";
          const hash = await bcrypt.hash(tempPassword, 10);
          await pool.query(
            `INSERT INTO users (id, employee_id, username, password_hash, display_name, role, must_change_password) VALUES (?,?,?,?,?,?,1)`,
            [uuidv4(), id, r.associateCode, hash, r.name, r.accessRole]
          );
          credentials.push({ name: r.name, username: r.associateCode, password: tempPassword });
        } catch (loginErr) {
          // Employee row saved fine — just the login creation failed (e.g. that username's taken already).
          errors.push({ row: i + 2, name: r.name, error: `Employee saved, but login wasn't created: ${loginErr.sqlMessage || loginErr.message}` });
        }
      }
    } catch (err) {
      // Don't let one bad row (e.g. a duplicate Associate Code) stop the whole batch.
      errors.push({ row: i + 2, name: r.name, error: err.sqlMessage || err.message });
    }
  }
  res.json({ imported, credentials, errors });
});

module.exports = router;
