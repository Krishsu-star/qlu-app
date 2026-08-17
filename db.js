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
       UUID() AS id,
       'Effective Communication in the Workplace' AS title,
       'OpenLearn' AS provider,
       'Soft Skills' AS academy_category,
       'Communication Skills' AS sub_category,
       'Develop effective workplace communication skills, including expressing ideas clearly, understanding others, and adapting communication styles.' AS description,
       'Beginner' AS learning_level,
       'Approx. 24 hours' AS estimated_duration,
       'Free' AS cost_type,
       'https://www.open.edu/openlearn/mod/oucontent/view.php?id=97118' AS external_url,
       JSON_ARRAY('All Employees') AS recommended_audience,
       0 AS gmp_related,
       1 AS certificate_available,
       1 AS active,
       1 AS display_order,
       'System (initial seed)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.open.edu/openlearn/mod/oucontent/view.php?id=97118')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, estimated_duration, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Leadership and Followership' AS title,
       'OpenLearn' AS provider,
       'Leadership Skills' AS academy_category,
       'Leadership Fundamentals' AS sub_category,
       'Explore what makes a good leader, recognise common leadership challenges, and identify the skills you need to develop to enhance your leadership experience.' AS description,
       'Beginner' AS learning_level,
       'Approx. 24 hours' AS estimated_duration,
       'Free' AS cost_type,
       'https://www.open.edu/openlearn/education-development/learning/leadership-and-followership/content-section-overview' AS external_url,
       JSON_ARRAY('All Employees', 'Supervisors', 'Managers') AS recommended_audience,
       0 AS gmp_related,
       1 AS certificate_available,
       1 AS active,
       2 AS display_order,
       'System (initial seed)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.open.edu/openlearn/education-development/learning/leadership-and-followership/content-section-overview')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, estimated_duration, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Leadership and Management in Organizations' AS title,
       'Alison' AS provider,
       'Leadership Skills' AS academy_category,
       'Leadership Fundamentals' AS sub_category,
       'A foundational course covering leadership and management principles as applied within organizations.' AS description,
       'All Levels' AS learning_level,
       'Varies' AS estimated_duration,
       'Free to Learn / Certificate Paid' AS cost_type,
       'https://alison.com/course/leadership-and-management-in-organizations' AS external_url,
       JSON_ARRAY('Supervisors', 'Managers', 'Senior Managers') AS recommended_audience,
       0 AS gmp_related,
       1 AS certificate_available,
       1 AS active,
       3 AS display_order,
       'System (initial seed)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://alison.com/course/leadership-and-management-in-organizations')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, estimated_duration, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Leadership Skills and Team Management' AS title,
       'Alison' AS provider,
       'Leadership Skills' AS academy_category,
       'Building High-Performance Teams' AS sub_category,
       'Covers core leadership and team management skills for building and running effective teams.' AS description,
       'All Levels' AS learning_level,
       'Varies' AS estimated_duration,
       'Free to Learn / Certificate Paid' AS cost_type,
       'https://alison.com/course/leadership-skills-and-team-management' AS external_url,
       JSON_ARRAY('Supervisors', 'Managers') AS recommended_audience,
       0 AS gmp_related,
       1 AS certificate_available,
       1 AS active,
       4 AS display_order,
       'System (initial seed)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://alison.com/course/leadership-skills-and-team-management')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, estimated_duration, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Workplace Leadership and Management Skills' AS title,
       'Alison' AS provider,
       'Management Skills' AS academy_category,
       'People Management' AS sub_category,
       'Practical workplace-focused leadership and management skills course.' AS description,
       'All Levels' AS learning_level,
       'Varies' AS estimated_duration,
       'Free to Learn / Certificate Paid' AS cost_type,
       'https://alison.com/course/workplace-leadership-and-management-skills' AS external_url,
       JSON_ARRAY('Supervisors', 'Managers') AS recommended_audience,
       0 AS gmp_related,
       1 AS certificate_available,
       1 AS active,
       5 AS display_order,
       'System (initial seed)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://alison.com/course/workplace-leadership-and-management-skills')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, estimated_duration, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Communication in Management & Leadership' AS title,
       'Coursera' AS provider,
       'Management Skills' AS academy_category,
       'Communication' AS sub_category,
       'A practical toolkit for communicating with clarity, confidence, and impact in management and leadership situations — one-to-one conversations, meetings, written communication, and difficult conversations.' AS description,
       'All Levels' AS learning_level,
       'Approx. 9 hours' AS estimated_duration,
       'Free to Learn / Certificate Paid' AS cost_type,
       'https://www.coursera.org/learn/communication-management' AS external_url,
       JSON_ARRAY('Supervisors', 'Managers', 'Senior Managers') AS recommended_audience,
       0 AS gmp_related,
       1 AS certificate_available,
       1 AS active,
       6 AS display_order,
       'System (initial seed)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.coursera.org/learn/communication-management')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, estimated_duration, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Business Communications' AS title,
       'edX' AS provider,
       'Professional Skills' AS academy_category,
       'Business Communication' AS sub_category,
       'Covers core business communication skills for the professional workplace.' AS description,
       'All Levels' AS learning_level,
       'Varies' AS estimated_duration,
       'Free to Learn / Certificate Paid' AS cost_type,
       'https://www.edx.org/learn/business-communications' AS external_url,
       JSON_ARRAY('All Employees', 'Executives') AS recommended_audience,
       0 AS gmp_related,
       1 AS certificate_available,
       1 AS active,
       7 AS display_order,
       'System (initial seed)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.edx.org/learn/business-communications')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, estimated_duration, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Management' AS title,
       'edX' AS provider,
       'Management Skills' AS academy_category,
       'People Management' AS sub_category,
       'Covers core management principles and practices for the workplace.' AS description,
       'All Levels' AS learning_level,
       'Varies' AS estimated_duration,
       'Free to Learn / Certificate Paid' AS cost_type,
       'https://www.edx.org/learn/management' AS external_url,
       JSON_ARRAY('Supervisors', 'Managers') AS recommended_audience,
       0 AS gmp_related,
       1 AS certificate_available,
       1 AS active,
       8 AS display_order,
       'System (initial seed)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.edx.org/learn/management')`,
    // Per user feedback: employees must be able to open a course directly with NO login/signup
    // wall. Alison, Coursera, and edX all gate actual lesson content behind a free account even
    // though their landing pages are public — deactivating those 6 rather than deleting them, so
    // the history/URLs aren't lost if this policy ever changes.
    `UPDATE external_learning_resources SET active = 0, modified_by = 'System (deactivated — requires signup to open lessons)', modified_at = NOW()
     WHERE external_url IN (
       'https://alison.com/course/leadership-and-management-in-organizations',
       'https://alison.com/course/leadership-skills-and-team-management',
       'https://alison.com/course/workplace-leadership-and-management-skills',
       'https://www.coursera.org/learn/communication-management',
       'https://www.edx.org/learn/business-communications',
       'https://www.edx.org/learn/management'
     ) AND active = 1`,
    // Replacement resources — genuinely no-signup, spot-verified live: MIT OpenCourseWare states
    // explicitly "no sign-up, no enrollment" for all content; TED Talks have never required an
    // account to watch.
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, estimated_duration, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Advanced Communication for Leaders' AS title,
       'MIT OpenCourseWare' AS provider,
       'Leadership Skills' AS academy_category,
       'Leadership Communication' AS sub_category,
       'Interactive oral and interpersonal communication skills critical to leaders: presenting to a hostile audience, running effective meetings, active listening, and group decision-making.' AS description,
       'Advanced' AS learning_level,
       'Self-paced' AS estimated_duration,
       'Free' AS cost_type,
       'https://ocw.mit.edu/courses/15-281-advanced-communication-for-leaders-spring-2016/' AS external_url,
       JSON_ARRAY('Supervisors', 'Managers', 'Senior Managers', 'Leadership Team') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 9 AS display_order, 'System (initial seed)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://ocw.mit.edu/courses/15-281-advanced-communication-for-leaders-spring-2016/')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, estimated_duration, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Organizational Leadership and Change' AS title,
       'MIT OpenCourseWare' AS provider,
       'Leadership Skills' AS academy_category,
       'Change Leadership' AS sub_category,
       'Practical experience blending leadership theory and practice — reflecting on prior leadership experience and applying lessons learned to further develop leadership capabilities.' AS description,
       'Advanced' AS learning_level,
       'Self-paced' AS estimated_duration,
       'Free' AS cost_type,
       'https://ocw.mit.edu/courses/15-317-organizational-leadership-and-change-summer-2009/' AS external_url,
       JSON_ARRAY('Managers', 'Senior Managers', 'Department Heads', 'Leadership Team') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 10 AS display_order, 'System (initial seed)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://ocw.mit.edu/courses/15-317-organizational-leadership-and-change-summer-2009/')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, estimated_duration, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'How Great Leaders Inspire Action' AS title,
       'TED' AS provider,
       'Leadership Skills' AS academy_category,
       'Leadership Fundamentals' AS sub_category,
       'Simon Sinek''s widely-watched talk on the "Golden Circle" model for inspirational leadership — why some leaders and organizations inspire when others, with the same resources, do not.' AS description,
       'All Levels' AS learning_level,
       '18 minutes' AS estimated_duration,
       'Free' AS cost_type,
       'https://www.ted.com/talks/simon_sinek_how_great_leaders_inspire_action' AS external_url,
       JSON_ARRAY('All Employees', 'Supervisors', 'Managers', 'Senior Managers', 'Leadership Team') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 11 AS display_order, 'System (initial seed)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.ted.com/talks/simon_sinek_how_great_leaders_inspire_action')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, estimated_duration, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       '10 Ways to Have a Better Conversation' AS title,
       'TED' AS provider,
       'Soft Skills' AS academy_category,
       'Active Listening' AS sub_category,
       'Longtime radio host Celeste Headlee shares 10 practical rules for better conversations — honesty, brevity, clarity, and genuine listening.' AS description,
       'Beginner' AS learning_level,
       '11 minutes' AS estimated_duration,
       'Free' AS cost_type,
       'https://www.ted.com/talks/celeste_headlee_10_ways_to_have_a_better_conversation' AS external_url,
       JSON_ARRAY('All Employees') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 12 AS display_order, 'System (initial seed)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.ted.com/talks/celeste_headlee_10_ways_to_have_a_better_conversation')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, estimated_duration, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Your Body Language May Shape Who You Are' AS title,
       'TED' AS provider,
       'Soft Skills' AS academy_category,
       'Presentation Skills' AS sub_category,
       'Social psychologist Amy Cuddy on how body language and "power posing" affect confidence, presence, and how others perceive you.' AS description,
       'Beginner' AS learning_level,
       '21 minutes' AS estimated_duration,
       'Free' AS cost_type,
       'https://www.ted.com/talks/amy_cuddy_your_body_language_may_shape_who_you_are' AS external_url,
       JSON_ARRAY('All Employees') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 13 AS display_order, 'System (initial seed)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.ted.com/talks/amy_cuddy_your_body_language_may_shape_who_you_are')`,
    // Learning Academy Phase 2a — employee tracking workflow (Not Started/In Progress/Completed/
    // Certificate Submitted/Verified/Rejected). Certificate fields are text-based for now (number,
    // dates, remarks) — actual FILE attachment comes in Phase 2b once the existing upload pattern
    // (e.g. photos/SOP documents) has been reviewed, so this doesn't guess at a convention blind.
    // No cascade FK to external_learning_resources — a progress record (and its audit history)
    // should survive even if the resource it refers to is later deleted or deactivated.
    `CREATE TABLE IF NOT EXISTS external_learning_progress (
       id VARCHAR(36) PRIMARY KEY,
       employee_id VARCHAR(36) NOT NULL,
       resource_id VARCHAR(36) NOT NULL,
       status ENUM('Not Started','In Progress','Completed','Certificate Submitted','Verified','Rejected') NOT NULL DEFAULT 'Not Started',
       started_date DATE NULL,
       completed_date DATE NULL,
       certificate_number VARCHAR(255) NULL,
       certificate_completion_date DATE NULL,
       certificate_expiry_date DATE NULL,
       certificate_file_path VARCHAR(1024) NULL,
       certificate_remarks TEXT NULL,
       verified_by VARCHAR(255) NULL,
       verified_date DATE NULL,
       verification_remarks TEXT NULL,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
       UNIQUE KEY uniq_emp_resource (employee_id, resource_id),
       INDEX idx_elp_status (status)
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
