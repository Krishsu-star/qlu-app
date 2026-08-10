// Run once after setting up the database and .env file:  npm run initdb
// This creates all tables (if they don't already exist) and a first Admin login.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const { randomUUID } = require("crypto");

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true,
  });

  console.log("Applying schema...");
  const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  await connection.query(schema);

  // Safe to re-run: widens the questionnaires.category list for databases created before
  // SOP support was added — CREATE TABLE IF NOT EXISTS above won't touch an existing table.
  console.log("Applying migrations...");
  try {
    await connection.query(`ALTER TABLE questionnaires MODIFY COLUMN category ENUM('Evaluation','Effectiveness','SOP','Induction','Learning Academy') NOT NULL`);
  } catch (err) {
    console.log("  (category migration skipped: " + err.message + ")");
  }
  try {
    await connection.query(`ALTER TABLE users MODIFY COLUMN role ENUM('Admin','HR','Manager','User','QA','SiteHead') NOT NULL`);
  } catch (err) {
    console.log("  (role migration skipped: " + err.message + ")");
  }
  try {
    await connection.query(`ALTER TABLE content_bank MODIFY COLUMN type ENUM('Video','PPT','Document','Book','Other','Video Course','Reading Course') NOT NULL`);
  } catch (err) {
    console.log("  (content_bank type migration skipped: " + err.message + ")");
  }
  try {
    await connection.query(`ALTER TABLE content_bank ADD COLUMN academy VARCHAR(128) NULL`);
  } catch (err) {
    console.log("  (content_bank.academy migration skipped: " + err.message + ")");
  }
  try {
    await connection.query(`ALTER TABLE content_bank ADD COLUMN questionnaire_id VARCHAR(36) NULL`);
  } catch (err) {
    console.log("  (content_bank.questionnaire_id migration skipped: " + err.message + ")");
  }

  const [existing] = await connection.query(`SELECT id FROM users WHERE username = 'admin' LIMIT 1`);
  if (existing.length === 0) {
    console.log("Creating default admin account (username: admin / password: admin123)...");
    const hash = await bcrypt.hash("admin123", 10);
    await connection.query(
      `INSERT INTO users (id, employee_id, username, password_hash, display_name, role, must_change_password) VALUES (?, NULL, 'admin', ?, 'QLC Admin', 'Admin', 0)`,
      [randomUUID(), hash]
    );
    console.log("IMPORTANT: sign in as admin/admin123 and change this password immediately once you're on the live server.");
  } else {
    console.log("Admin account already exists — skipping.");
  }

  // 5 test accounts for a small pilot group — one each of HR and Manager, three Users (one
  // reporting to the test Manager), all sharing password "test123" and forced to change it
  // on first login. Safe to run again: skipped if they already exist.
  const testAccounts = [
    { code: "T90001", name: "Priya Sharma", dept: "HR", designation: "HR Executive", manager: "", role: "HR", username: "T90001" },
    { code: "T90002", name: "Rajesh Kumar", dept: "Production", designation: "Production Manager", manager: "", role: "Manager", username: "T90002" },
    { code: "T90003", name: "Anita Verma", dept: "Production", designation: "Officer", manager: "Rajesh Kumar", role: "User", username: "T90003" },
    { code: "T90004", name: "Suresh Patel", dept: "Quality", designation: "QA Officer", manager: "", role: "User", username: "T90004" },
    { code: "T90005", name: "Meena Iyer", dept: "HR", designation: "HR Associate", manager: "Priya Sharma", role: "User", username: "T90005" },
  ];
  const [existingTest] = await connection.query(`SELECT id FROM users WHERE username = 'T90001' LIMIT 1`);
  if (existingTest.length === 0) {
    console.log("Creating 5 test accounts (T90001–T90005 / password: test123)...");
    const testHash = await bcrypt.hash("test123", 10);
    for (const acc of testAccounts) {
      const empId = randomUUID();
      await connection.query(
        `INSERT INTO employees (id, name, associate_code, department, designation, grade, manager, email) VALUES (?, ?, ?, ?, ?, 'E1', ?, ?)`,
        [empId, acc.name, acc.code, acc.dept, acc.designation, acc.manager, `${acc.code.toLowerCase()}@example.com`]
      );
      await connection.query(
        `INSERT INTO users (id, employee_id, username, password_hash, display_name, role, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [randomUUID(), empId, acc.username, testHash, acc.name, acc.role]
      );
    }
    console.log("Test logins ready — share these with your 5 pilot users:");
    testAccounts.forEach((a) => console.log(`  ${a.username} / test123  (${a.role} — ${a.name})`));
  } else {
    console.log("Test accounts already exist — skipping.");
  }

  await connection.end();
  console.log("Database ready.");
}

main().catch((err) => {
  console.error("Database setup failed:", err.message);
  process.exit(1);
});
