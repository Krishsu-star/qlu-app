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
    // Stage 5: company-wide audit trail. Deliberately NOT foreign-keyed to sessions (or anything
    // else) with ON DELETE CASCADE — an audit trail that disappears when the record it describes
    // is deleted defeats its own purpose. entity_type lets this same table serve every module as
    // each one is wired up (sessions/attendance today; employees/skill-matrix to follow).
    `CREATE TABLE IF NOT EXISTS audit_log (
       id VARCHAR(36) PRIMARY KEY,
       entity_type VARCHAR(50) NOT NULL,
       entity_id VARCHAR(36) NOT NULL,
       session_id VARCHAR(36) NULL,
       action VARCHAR(50) NOT NULL,
       summary VARCHAR(500),
       changes JSON NULL,
       performed_by VARCHAR(255),
       performed_role VARCHAR(50),
       reason VARCHAR(1000) NULL,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       INDEX idx_audit_created (created_at),
       INDEX idx_audit_entity (entity_type, entity_id),
       INDEX idx_audit_session (session_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    // Learning Academy — External Virtual Learning Resources (Phase 1). A dedicated master table
    // per the spec, deliberately separate from the existing content_bank table so this rollout
    // can't touch or break anything already working in Learning Academy. Genuinely external,
    // curated third-party courses — never hard-coded into the frontend, always admin-maintained.
    `CREATE TABLE IF NOT EXISTS external_learning_resources (
       id VARCHAR(36) PRIMARY KEY,
       title VARCHAR(255) NOT NULL,
       provider VARCHAR(128) NOT NULL,
       academy_category ENUM('Soft Skills','Management Skills','Leadership Skills','Professional Skills') NOT NULL,
       sub_category VARCHAR(128),
       description TEXT,
       learning_level ENUM('Beginner','Intermediate','Advanced','All Levels') DEFAULT 'All Levels',
       estimated_duration VARCHAR(64),
       language VARCHAR(64) DEFAULT 'English',
       cost_type ENUM('Free','Paid','Free to Learn / Certificate Paid','Subscription Required') DEFAULT 'Free',
       external_url VARCHAR(1024) NOT NULL,
       recommended_audience JSON,
       gmp_related TINYINT(1) DEFAULT 0,
       certificate_available TINYINT(1) DEFAULT 0,
       active TINYINT(1) DEFAULT 1,
       display_order INT DEFAULT 0,
       created_by VARCHAR(255),
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       modified_by VARCHAR(255),
       modified_at TIMESTAMP NULL,
       INDEX idx_elr_category (academy_category),
       INDEX idx_elr_active (active)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    // Seed data from the initial 4-provider list — INSERT IGNORE-style guard via a NOT EXISTS
    // check so this never re-runs or duplicates on subsequent deploys. All URLs spot-verified
    // live before seeding; Admin can edit/deactivate/replace any of these at any time.
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, estimated_duration, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID(), 'Effective Communication in the Workplace', 'OpenLearn', 'Soft Skills', 'Communication Skills',
       'Develop effective workplace communication skills, including expressing ideas clearly, understanding others, and adapting communication styles.',
       'Beginner', 'Approx. 24 hours', 'Free', 'https://www.open.edu/openlearn/mod/oucontent/view.php?id=97118',
       JSON_ARRAY('All Employees'), 0, 1, 1, 1, 'System (initial seed)'
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.open.edu/openlearn/mod/oucontent/view.php?id=97118')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, estimated_duration, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID(), 'Leadership and Followership', 'OpenLearn', 'Leadership Skills', 'Leadership Fundamentals',
       'Explore what makes a good leader, recognise common leadership challenges, and identify the skills you need to develop to enhance your leadership experience.',
       'Beginner', 'Approx. 24 hours', 'Free', 'https://www.open.edu/openlearn/education-development/learning/leadership-and-followership/content-section-overview',
       JSON_ARRAY('All Employees', 'Supervisors', 'Managers'), 0, 1, 1, 2, 'System (initial seed)'
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.open.edu/openlearn/education-development/learning/leadership-and-followership/content-section-overview')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, estimated_duration, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID(), 'Leadership and Management in Organizations', 'Alison', 'Leadership Skills', 'Leadership Fundamentals',
       'A foundational course covering leadership and management principles as applied within organizations.',
       'All Levels', 'Varies', 'Free to Learn / Certificate Paid', 'https://alison.com/course/leadership-and-management-in-organizations',
       JSON_ARRAY('Supervisors', 'Managers', 'Senior Managers'), 0, 1, 1, 3, 'System (initial seed)'
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://alison.com/course/leadership-and-management-in-organizations')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, estimated_duration, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID(), 'Leadership Skills and Team Management', 'Alison', 'Leadership Skills', 'Building High-Performance Teams',
       'Covers core leadership and team management skills for building and running effective teams.',
       'All Levels', 'Varies', 'Free to Learn / Certificate Paid', 'https://alison.com/course/leadership-skills-and-team-management',
       JSON_ARRAY('Supervisors', 'Managers'), 0, 1, 1, 4, 'System (initial seed)'
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://alison.com/course/leadership-skills-and-team-management')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, estimated_duration, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID(), 'Workplace Leadership and Management Skills', 'Alison', 'Management Skills', 'People Management',
       'Practical workplace-focused leadership and management skills course.',
       'All Levels', 'Varies', 'Free to Learn / Certificate Paid', 'https://alison.com/course/workplace-leadership-and-management-skills',
       JSON_ARRAY('Supervisors', 'Managers'), 0, 1, 1, 5, 'System (initial seed)'
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://alison.com/course/workplace-leadership-and-management-skills')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, estimated_duration, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID(), 'Communication in Management & Leadership', 'Coursera', 'Management Skills', 'Communication',
       'A practical toolkit for communicating with clarity, confidence, and impact in management and leadership situations — one-to-one conversations, meetings, written communication, and difficult conversations.',
       'All Levels', 'Approx. 9 hours', 'Free to Learn / Certificate Paid', 'https://www.coursera.org/learn/communication-management',
       JSON_ARRAY('Supervisors', 'Managers', 'Senior Managers'), 0, 1, 1, 6, 'System (initial seed)'
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.coursera.org/learn/communication-management')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, estimated_duration, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID(), 'Business Communications', 'edX', 'Professional Skills', 'Business Communication',
       'Covers core business communication skills for the professional workplace.',
       'All Levels', 'Varies', 'Free to Learn / Certificate Paid', 'https://www.edx.org/learn/business-communications',
       JSON_ARRAY('All Employees', 'Executives'), 0, 1, 1, 7, 'System (initial seed)'
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.edx.org/learn/business-communications')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, estimated_duration, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID(), 'Management', 'edX', 'Management Skills', 'People Management',
       'Covers core management principles and practices for the workplace.',
       'All Levels', 'Varies', 'Free to Learn / Certificate Paid', 'https://www.edx.org/learn/management',
       JSON_ARRAY('Supervisors', 'Managers'), 0, 1, 1, 8, 'System (initial seed)'
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.edx.org/learn/management')`,
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
