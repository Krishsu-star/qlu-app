const mysql = require("mysql2/promise");
require("dotenv").config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  charset: "utf8mb4_general_ci",
  connectTimeout: 20000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  // Managed cloud databases (e.g. Aiven) require an encrypted connection.
  // Set DB_SSL=true in .env when connecting to one; leave unset for a local NAS database.
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

// A fatal connection error (e.g. a momentary DNS blip reaching a free-tier database) is
// normally emitted on the pool itself, not through a query's promise — without a listener
// here, that alone can crash the whole process regardless of try/catch elsewhere.
pool.on("error", (err) => {
  console.error("Database pool error (server stays up):", err.message);
});

// Auto-apply small, safe database changes on startup, so a plain redeploy
// is enough — no separate manual script needs to be run. Each one is
// wrapped so a column that already exists just gets skipped quietly.
async function runStartupMigrations() {
  const migrations = [
    `ALTER TABLE employees ADD COLUMN separation_date DATE NULL`,
    `ALTER TABLE employees ADD COLUMN employment_status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active'`,
    `ALTER TABLE skill_matrix ADD COLUMN year INT NOT NULL DEFAULT ${new Date().getFullYear()}`,
    `ALTER TABLE skill_matrix DROP INDEX uniq_emp_skill`,
    `ALTER TABLE skill_matrix ADD UNIQUE KEY uniq_emp_skill_year (employee_id, skill_id, year)`,
    `ALTER TABLE tni ADD COLUMN year INT NOT NULL DEFAULT ${new Date().getFullYear()}`,
    `ALTER TABLE skills MODIFY COLUMN category ENUM('Technical','Behavioural','Mandatory') NOT NULL`,
    `ALTER TABLE sessions MODIFY COLUMN category ENUM('Technical','Behavioural','Mandatory') NOT NULL`,
    `ALTER TABLE skills ADD COLUMN criticality ENUM('Critical','Major','Normal') NOT NULL DEFAULT 'Normal'`,
    `ALTER TABLE skills ADD COLUMN level_guidance TEXT NULL`,
    `ALTER TABLE skills ADD COLUMN designation VARCHAR(128) NULL`,
    `ALTER TABLE skills ADD COLUMN requires_qualification TINYINT(1) NOT NULL DEFAULT 0`,
    `ALTER TABLE skill_matrix ADD COLUMN qualification_status ENUM('Not Started','Trained','Assessed','Qualified','Authorized') NOT NULL DEFAULT 'Not Started'`,
    `ALTER TABLE skill_matrix ADD COLUMN assessor VARCHAR(255) NULL`,
    `ALTER TABLE skill_matrix ADD COLUMN assessment_date DATE NULL`,
    `ALTER TABLE skill_matrix ADD COLUMN next_review_date DATE NULL`,
    `ALTER TABLE skill_matrix ADD COLUMN qual_remarks TEXT NULL`,
    `ALTER TABLE skill_matrix ADD COLUMN evidence_note VARCHAR(500) NULL`,
    `ALTER TABLE skills ADD COLUMN owner_department VARCHAR(128) NULL`,
    // Best-effort backfill: for existing skills, assume whoever they were already scoped to is
    // also who maintains them — preserves today's Manager-edit behavior for skills that already
    // exist. New skills going forward get an explicit, independent owner (see routes/skills.js).
    `UPDATE skills SET owner_department = department WHERE owner_department IS NULL AND department IS NOT NULL`,
    // Training Attendance module — Stage 1: Training Type master + extended Training Program fields
    `CREATE TABLE IF NOT EXISTS training_types (
       id VARCHAR(36) PRIMARY KEY, name VARCHAR(100) NOT NULL, code VARCHAR(20) NOT NULL UNIQUE,
       attendance_method VARCHAR(255), active TINYINT(1) NOT NULL DEFAULT 1
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `ALTER TABLE sessions ADD COLUMN training_type_code VARCHAR(20) NOT NULL DEFAULT 'CLASSROOM'`,
    `ALTER TABLE sessions ADD COLUMN status ENUM('Draft','Scheduled','In Progress','Completed','Closed') NOT NULL DEFAULT 'Scheduled'`,
    `ALTER TABLE sessions ADD COLUMN co_trainer VARCHAR(255) NULL`,
    `ALTER TABLE sessions ADD COLUMN coordinator VARCHAR(255) NULL`,
    `ALTER TABLE sessions ADD COLUMN target_audience VARCHAR(255) NULL`,
    `ALTER TABLE sessions ADD COLUMN objective TEXT NULL`,
    `ALTER TABLE sessions ADD COLUMN related_sop_id VARCHAR(36) NULL`,
    `ALTER TABLE sessions ADD COLUMN sop_version VARCHAR(50) NULL`,
    `ALTER TABLE sessions ADD COLUMN certificate_required TINYINT(1) NOT NULL DEFAULT 0`,
    `ALTER TABLE sessions ADD COLUMN delivery_type ENUM('Internal','External') NOT NULL DEFAULT 'Internal'`,
    `ALTER TABLE attendance ADD COLUMN check_in TIME NULL`,
    `ALTER TABLE attendance ADD COLUMN check_out TIME NULL`,
    `ALTER TABLE attendance ADD COLUMN remarks VARCHAR(500) NULL`,
    `ALTER TABLE attendance MODIFY COLUMN status ENUM('Nominated','Attended','Absent','Partial','Late','Excused') DEFAULT 'Nominated'`,
    // Seed the 4 default training types from the user's spec — skipped automatically on rerun since code is UNIQUE.
    `INSERT INTO training_types (id, name, code, attendance_method) VALUES
       (UUID(), 'Classroom Training', 'CLASSROOM', 'Manual / QR / Employee selection'),
       (UUID(), 'OJT', 'OJT', 'Trainer confirmation'),
       (UUID(), 'Webinar', 'WEBINAR', 'Online attendance / manual'),
       (UUID(), 'SOP Training', 'SOP', 'Employee acknowledgement + assessment')`,
    // Training Attendance module — Stage 3: approval & lock workflow. A session can only reach
    // Closed by passing through Trainer Confirmed first (never set directly), and once Closed,
    // only Admin may still touch it — and must leave a reason, logged in session_corrections.
    `ALTER TABLE sessions MODIFY COLUMN status ENUM('Draft','Scheduled','In Progress','Completed','Trainer Confirmed','Closed') NOT NULL DEFAULT 'Scheduled'`,
    `ALTER TABLE sessions ADD COLUMN trainer_confirmed_by VARCHAR(255) NULL`,
    `ALTER TABLE sessions ADD COLUMN trainer_confirmed_at TIMESTAMP NULL`,
    `ALTER TABLE sessions ADD COLUMN closed_by VARCHAR(255) NULL`,
    `ALTER TABLE sessions ADD COLUMN closed_at TIMESTAMP NULL`,
    `CREATE TABLE IF NOT EXISTS session_corrections (
       id VARCHAR(36) PRIMARY KEY, session_id VARCHAR(36) NOT NULL, edited_by VARCHAR(255),
       reason TEXT NOT NULL, edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ];
  for (const sql of migrations) {
    try {
      await pool.query(sql);
      console.log("Migration applied:", sql);
    } catch (err) {
      console.log("Migration skipped (already applied or not needed):", err.message);
    }
  }
}
runStartupMigrations();

module.exports = pool;
