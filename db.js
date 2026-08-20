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
    // Cost-type taxonomy upgrade: the original 4-tier system is widened (not replaced) to include
    // the more accurate 5-tier system, so existing rows never hit an invalid-enum error. Existing
    // rows are then relabeled to their closest new equivalent right after.
    `ALTER TABLE external_learning_resources MODIFY COLUMN cost_type ENUM('Free','Paid','Free to Learn / Certificate Paid','Subscription Required','Free Learning','Free Learning – Certificate May Be Paid','Enrollment Required','Paid Course','Free Preview / Introduction') DEFAULT 'Free Learning'`,
    `UPDATE external_learning_resources SET cost_type = 'Free Learning' WHERE cost_type = 'Free'`,
    `UPDATE external_learning_resources SET cost_type = 'Paid Course' WHERE cost_type = 'Paid'`,
    `UPDATE external_learning_resources SET cost_type = 'Free Learning – Certificate May Be Paid' WHERE cost_type = 'Free to Learn / Certificate Paid'`,
    `UPDATE external_learning_resources SET cost_type = 'Enrollment Required' WHERE cost_type = 'Subscription Required'`,
    // Per user decision: the earlier no-login-only policy is relaxed — reactivating the 6
    // Alison/Coursera/edX resources deactivated during Phase 1 for requiring a free account.
    `UPDATE external_learning_resources SET active = 1, modified_by = 'System (reactivated — login requirement no longer a blocker per updated policy)', modified_at = NOW() WHERE active = 0`,
    // 50-course QLU Learning Academy Library import (46 new — 3 of the original 50 were already
    // seeded in Phase 1: OpenLearn "Effective Communication in the Workplace", OpenLearn "Leadership
    // and Followership", and Coursera "Communication in Management & Leadership"; one further
    // duplicate within the source doc itself, Great Learning's "Performance Management," is safely
    // deduplicated below by the same URL-based NOT EXISTS guard used everywhere else in this file.
    // Given the scale (46 courses), URL patterns per provider were confirmed live (OpenLearn,
    // Alison, Coursera in Phase 1; Great Learning here), but not every individual course URL —
    // flagged clearly to the user; Admin can fix any that don't resolve via Manage Resources.
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Introduction to Soft Skills Communication' AS title,
       'Alison' AS provider,
       'Soft Skills' AS academy_category,
       'Communication Skills' AS sub_category,
       'Covers the fundamentals of soft-skills-based workplace communication.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://alison.com/course/introduction-to-soft-skills-communication' AS external_url,
       JSON_ARRAY('All Employees') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 20 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://alison.com/course/introduction-to-soft-skills-communication')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Introduction to Communication Skills' AS title,
       'Alison' AS provider,
       'Soft Skills' AS academy_category,
       'Communication Skills' AS sub_category,
       'A foundational course on core communication skills for the workplace.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://alison.com/course/introduction-to-communication-skills' AS external_url,
       JSON_ARRAY('All Employees') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 21 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://alison.com/course/introduction-to-communication-skills')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Interpersonal Skills – Introduction to Soft Skills' AS title,
       'Alison' AS provider,
       'Soft Skills' AS academy_category,
       'Interpersonal Skills' AS sub_category,
       'Introduces interpersonal skills as a core soft-skills discipline.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://alison.com/course/diploma-in-interpersonal-skills' AS external_url,
       JSON_ARRAY('All Employees') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 22 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://alison.com/course/diploma-in-interpersonal-skills')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Essential Soft Skills: Listening' AS title,
       'Alison' AS provider,
       'Soft Skills' AS academy_category,
       'Active Listening' AS sub_category,
       'Covers active listening as an essential workplace soft skill.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://alison.com/course/essential-soft-skills-listening' AS external_url,
       JSON_ARRAY('All Employees') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 23 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://alison.com/course/essential-soft-skills-listening')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Introduction to Interpersonal Skills' AS title,
       'Alison' AS provider,
       'Soft Skills' AS academy_category,
       'Interpersonal Skills' AS sub_category,
       'A beginner-level introduction to interpersonal skills at work.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://alison.com/course/introduction-to-interpersonal-skills' AS external_url,
       JSON_ARRAY('All Employees') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 24 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://alison.com/course/introduction-to-interpersonal-skills')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'The Importance of Interpersonal Skills' AS title,
       'OpenLearn' AS provider,
       'Soft Skills' AS academy_category,
       'Interpersonal Skills' AS sub_category,
       'Explores why interpersonal skills matter in professional and personal contexts.' AS description,
       'Beginner' AS learning_level,
       'Free Learning' AS cost_type,
       'https://www.open.edu/openlearn/health-sports-psychology/the-importance-interpersonal-skills/content-section-overview' AS external_url,
       JSON_ARRAY('All Employees') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 25 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.open.edu/openlearn/health-sports-psychology/the-importance-interpersonal-skills/content-section-overview')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Talk the Talk – Presentation Skills' AS title,
       'OpenLearn' AS provider,
       'Soft Skills' AS academy_category,
       'Presentation Skills' AS sub_category,
       'Covers the essentials of confident, effective presentation skills.' AS description,
       'Beginner' AS learning_level,
       'Free Learning' AS cost_type,
       'https://www.open.edu/openlearn/education-development/talk-the-talk-presentation-skills/content-section-overview' AS external_url,
       JSON_ARRAY('All Employees') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 26 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.open.edu/openlearn/education-development/talk-the-talk-presentation-skills/content-section-overview')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Emotional Intelligence in the Workplace' AS title,
       'Coursera' AS provider,
       'Soft Skills' AS academy_category,
       'Emotional Intelligence' AS sub_category,
       'Covers emotional intelligence fundamentals applied to workplace situations.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://www.coursera.org/learn/emotional-intelligence-in-the-workplace' AS external_url,
       JSON_ARRAY('All Employees') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 27 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.coursera.org/learn/emotional-intelligence-in-the-workplace')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Emotional Intelligence for Business Professionals' AS title,
       'Coursera' AS provider,
       'Soft Skills' AS academy_category,
       'Emotional Intelligence' AS sub_category,
       'A more advanced look at applying emotional intelligence in business settings.' AS description,
       'Intermediate' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://www.coursera.org/learn/emotional-intelligence-for-business-professionals' AS external_url,
       JSON_ARRAY('Supervisors', 'Managers') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 28 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.coursera.org/learn/emotional-intelligence-for-business-professionals')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Introduction to Management' AS title,
       'Great Learning' AS provider,
       'Management Skills' AS academy_category,
       'People Management' AS sub_category,
       'Overview of core management concepts: market analysis, leadership, and resource management.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://www.mygreatlearning.com/academy/learn-for-free/courses/introduction-to-management' AS external_url,
       JSON_ARRAY('Supervisors', 'Managers') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 29 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.mygreatlearning.com/academy/learn-for-free/courses/introduction-to-management')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Leadership and Management' AS title,
       'Great Learning' AS provider,
       'Management Skills' AS academy_category,
       'People Management' AS sub_category,
       'Covers the relationship and distinction between leadership and management.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://www.mygreatlearning.com/academy/learn-for-free/courses/leadership-and-management' AS external_url,
       JSON_ARRAY('Supervisors', 'Managers') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 30 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.mygreatlearning.com/academy/learn-for-free/courses/leadership-and-management')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Project Management' AS title,
       'Great Learning' AS provider,
       'Management Skills' AS academy_category,
       'Planning' AS sub_category,
       'Introduces core project management principles and practices.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://www.mygreatlearning.com/academy/learn-for-free/courses/project-management' AS external_url,
       JSON_ARRAY('Supervisors', 'Managers') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 31 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.mygreatlearning.com/academy/learn-for-free/courses/project-management')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Performance Management' AS title,
       'Great Learning' AS provider,
       'Management Skills' AS academy_category,
       'Performance Management' AS sub_category,
       'Covers planning, monitoring, reviewing, feedback, and performance appraisal concepts.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://www.mygreatlearning.com/academy/learn-for-free/courses/performance-management' AS external_url,
       JSON_ARRAY('Supervisors', 'Managers') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 32 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.mygreatlearning.com/academy/learn-for-free/courses/performance-management')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Conflict Management' AS title,
       'Great Learning' AS provider,
       'Management Skills' AS academy_category,
       'Conflict Resolution' AS sub_category,
       'Covers approaches to identifying and resolving workplace conflict.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://www.mygreatlearning.com/academy/learn-for-free/courses/conflict-management' AS external_url,
       JSON_ARRAY('Supervisors', 'Managers') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 33 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.mygreatlearning.com/academy/learn-for-free/courses/conflict-management')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Time Management' AS title,
       'Great Learning' AS provider,
       'Management Skills' AS academy_category,
       'Time Management' AS sub_category,
       'Covers prioritization, goal-setting, and productivity techniques for managers.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://www.mygreatlearning.com/academy/learn-for-free/courses/time-management' AS external_url,
       JSON_ARRAY('All Employees', 'Supervisors', 'Managers') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 34 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.mygreatlearning.com/academy/learn-for-free/courses/time-management')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Leadership & Management in Organizations' AS title,
       'Alison' AS provider,
       'Management Skills' AS academy_category,
       'People Management' AS sub_category,
       'A foundational course covering leadership and management principles within organizations.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://alison.com/course/leadership-and-management-in-organizations' AS external_url,
       JSON_ARRAY('Supervisors', 'Managers', 'Senior Managers') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 35 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://alison.com/course/leadership-and-management-in-organizations')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Leadership & Management Skills for Business' AS title,
       'Alison' AS provider,
       'Management Skills' AS academy_category,
       'People Management' AS sub_category,
       'Covers leadership and management skills for running and managing a team.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://alison.com/course/leadership-and-management-skills-for-business-managing-employees' AS external_url,
       JSON_ARRAY('Supervisors', 'Managers') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 36 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://alison.com/course/leadership-and-management-skills-for-business-managing-employees')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Conflict Management Strategies' AS title,
       'Coursera' AS provider,
       'Management Skills' AS academy_category,
       'Conflict Resolution' AS sub_category,
       'Covers strategies and frameworks for managing conflict in professional settings.' AS description,
       'Intermediate' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://www.coursera.org/learn/conflict-management-strategies' AS external_url,
       JSON_ARRAY('Supervisors', 'Managers') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 37 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.coursera.org/learn/conflict-management-strategies')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Communication in Management & Leadership' AS title,
       'Coursera' AS provider,
       'Management Skills' AS academy_category,
       'Communication' AS sub_category,
       'Covers one-to-one communication, meetings, written communication, performance discussions, and influencing.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://www.coursera.org/learn/communication-management' AS external_url,
       JSON_ARRAY('Supervisors', 'Managers', 'Senior Managers') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 38 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.coursera.org/learn/communication-management')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'How to Develop Leadership Skills' AS title,
       'Alison' AS provider,
       'Leadership Skills' AS academy_category,
       'Leadership Fundamentals' AS sub_category,
       'Covers foundational techniques for developing personal leadership skills.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://alison.com/course/how-to-develop-leadership-skills' AS external_url,
       JSON_ARRAY('Supervisors', 'Managers') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 39 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://alison.com/course/how-to-develop-leadership-skills')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Effective Leadership Skills and Strategies' AS title,
       'Alison' AS provider,
       'Leadership Skills' AS academy_category,
       'Leadership Fundamentals' AS sub_category,
       'Covers strategies for effective leadership in the workplace.' AS description,
       'Intermediate' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://alison.com/course/effective-leadership-skills-and-strategies' AS external_url,
       JSON_ARRAY('Supervisors', 'Managers') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 40 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://alison.com/course/effective-leadership-skills-and-strategies')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Leadership Skills for Beginners' AS title,
       'Great Learning' AS provider,
       'Leadership Skills' AS academy_category,
       'Leadership Fundamentals' AS sub_category,
       'An introductory course covering the basics of leadership.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://www.mygreatlearning.com/academy/learn-for-free/courses/leadership-skills-for-beginners' AS external_url,
       JSON_ARRAY('All Employees', 'Supervisors') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 41 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.mygreatlearning.com/academy/learn-for-free/courses/leadership-skills-for-beginners')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Strategic Thinking for Aspiring Leaders' AS title,
       'Great Learning' AS provider,
       'Leadership Skills' AS academy_category,
       'Strategic Thinking' AS sub_category,
       'Covers strategic-thinking fundamentals for employees moving into leadership roles.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://www.mygreatlearning.com/academy/learn-for-free/courses/strategic-thinking-for-aspiring-leaders' AS external_url,
       JSON_ARRAY('Supervisors', 'Managers') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 42 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.mygreatlearning.com/academy/learn-for-free/courses/strategic-thinking-for-aspiring-leaders')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Strategic Management' AS title,
       'Great Learning' AS provider,
       'Leadership Skills' AS academy_category,
       'Strategic Thinking' AS sub_category,
       'Covers strategic management concepts and frameworks.' AS description,
       'Intermediate' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://www.mygreatlearning.com/academy/learn-for-free/courses/strategic-management' AS external_url,
       JSON_ARRAY('Managers', 'Senior Managers') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 43 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.mygreatlearning.com/academy/learn-for-free/courses/strategic-management')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Strategic Management' AS title,
       'Coursera / Copenhagen Business School' AS provider,
       'Leadership Skills' AS academy_category,
       'Strategic Thinking' AS sub_category,
       'A university-backed course on strategic management fundamentals.' AS description,
       'Intermediate' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://www.coursera.org/learn/strategic-management' AS external_url,
       JSON_ARRAY('Managers', 'Senior Managers') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 44 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.coursera.org/learn/strategic-management')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Strategic Management Foundations & Capabilities' AS title,
       'Coursera' AS provider,
       'Leadership Skills' AS academy_category,
       'Strategic Thinking' AS sub_category,
       'Covers the foundations and organizational capabilities behind strategic management.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://www.coursera.org/learn/strategic-management-foundations-capabilities' AS external_url,
       JSON_ARRAY('Managers', 'Senior Managers') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 45 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.coursera.org/learn/strategic-management-foundations-capabilities')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Diploma in Human Resources' AS title,
       'Alison' AS provider,
       'Professional Skills' AS academy_category,
       'HR & Recruitment' AS sub_category,
       'A broad diploma-level introduction to human resources concepts.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://alison.com/course/diploma-in-human-resources' AS external_url,
       JSON_ARRAY('All Employees') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 46 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://alison.com/course/diploma-in-human-resources')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Recruitment Consultant' AS title,
       'Alison' AS provider,
       'Professional Skills' AS academy_category,
       'HR & Recruitment' AS sub_category,
       'Covers recruitment practices, sourcing methods, and finding suitable candidates.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://alison.com/course/recruitment-consultant' AS external_url,
       JSON_ARRAY('All Employees') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 47 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://alison.com/course/recruitment-consultant')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'The Recruitment and Onboarding Process' AS title,
       'Alison' AS provider,
       'Professional Skills' AS academy_category,
       'HR & Recruitment' AS sub_category,
       'Covers attraction, selection, job descriptions, selection tools, and onboarding.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://alison.com/course/the-recruitment-and-onboarding-process' AS external_url,
       JSON_ARRAY('All Employees') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 48 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://alison.com/course/the-recruitment-and-onboarding-process')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'HR Employee Management and Training' AS title,
       'Alison' AS provider,
       'Professional Skills' AS academy_category,
       'HR & Recruitment' AS sub_category,
       'Covers employee management and training practices from an HR perspective.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://alison.com/course/hr-employee-management-and-training' AS external_url,
       JSON_ARRAY('All Employees') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 49 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://alison.com/course/hr-employee-management-and-training')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Introduction to Human Resource Concepts' AS title,
       'Alison' AS provider,
       'Professional Skills' AS academy_category,
       'HR & Recruitment' AS sub_category,
       'A foundational overview of core human resource management concepts.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://alison.com/course/introduction-to-human-resource-concepts' AS external_url,
       JSON_ARRAY('All Employees') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 50 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://alison.com/course/introduction-to-human-resource-concepts')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Human Resource Management' AS title,
       'Great Learning' AS provider,
       'Professional Skills' AS academy_category,
       'HR & Recruitment' AS sub_category,
       'Covers core human resource management practices.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://www.mygreatlearning.com/academy/learn-for-free/courses/human-resource-management' AS external_url,
       JSON_ARRAY('All Employees') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 51 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.mygreatlearning.com/academy/learn-for-free/courses/human-resource-management')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'AI for Human Resources Professionals' AS title,
       'Alison' AS provider,
       'Professional Skills' AS academy_category,
       'HR & Recruitment' AS sub_category,
       'Covers how AI tools are being applied within HR functions.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://alison.com/course/ai-for-human-resources-professionals' AS external_url,
       JSON_ARRAY('All Employees') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 52 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://alison.com/course/ai-for-human-resources-professionals')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'AI in Human Resource Management' AS title,
       'Great Learning' AS provider,
       'Professional Skills' AS academy_category,
       'HR & Recruitment' AS sub_category,
       'Covers AI-supported recruitment, resume screening, candidate engagement, onboarding and L&D.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://www.mygreatlearning.com/academy/learn-for-free/courses/ai-in-human-resource-management' AS external_url,
       JSON_ARRAY('All Employees') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 53 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.mygreatlearning.com/academy/learn-for-free/courses/ai-in-human-resource-management')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Talent Acquisition' AS title,
       'Coursera / HRCI' AS provider,
       'Professional Skills' AS academy_category,
       'HR & Recruitment' AS sub_category,
       'Covers talent acquisition principles and practices.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://www.coursera.org/learn/talent-acquisition' AS external_url,
       JSON_ARRAY('All Employees') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 54 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.coursera.org/learn/talent-acquisition')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Succeed in the Workplace – CV & Interview Skills' AS title,
       'OpenLearn' AS provider,
       'Professional Skills' AS academy_category,
       'HR & Recruitment' AS sub_category,
       'Covers CVs, applications, and interview situations — useful for HR/recruiters as well as job seekers.' AS description,
       'Beginner' AS learning_level,
       'Free Learning' AS cost_type,
       'https://www.open.edu/openlearn/education-development/employability-hub/succeed-the-workplace-cvs-applications-and-interviews/content-section-overview' AS external_url,
       JSON_ARRAY('All Employees') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 55 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.open.edu/openlearn/education-development/employability-hub/succeed-the-workplace-cvs-applications-and-interviews/content-section-overview')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Digital Skills: Succeeding in a Digital World' AS title,
       'OpenLearn' AS provider,
       'Professional Skills' AS academy_category,
       'Digital Skills' AS sub_category,
       'Covers core digital skills needed to succeed in a modern workplace.' AS description,
       'Beginner' AS learning_level,
       'Free Learning' AS cost_type,
       'https://www.open.edu/openlearn/digital-computing/digital-skills-succeeding-digital-world/content-section-overview' AS external_url,
       JSON_ARRAY('All Employees') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 56 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.open.edu/openlearn/digital-computing/digital-skills-succeeding-digital-world/content-section-overview')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'AI Fluency' AS title,
       'OpenLearn' AS provider,
       'Professional Skills' AS academy_category,
       'Digital Skills' AS sub_category,
       'Covers AI fundamentals, generative AI, responsible AI, Microsoft Copilot, privacy, and AI-related workplace issues.' AS description,
       'Beginner' AS learning_level,
       'Free Learning' AS cost_type,
       'https://www.open.edu/openlearn/digital-computing/ai-fluency/content-section-overview' AS external_url,
       JSON_ARRAY('All Employees') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 57 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.open.edu/openlearn/digital-computing/ai-fluency/content-section-overview')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Customer Service Essentials' AS title,
       'Great Learning' AS provider,
       'Professional Skills' AS academy_category,
       'Collaboration' AS sub_category,
       'Covers core customer-service skills and best practices.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://www.mygreatlearning.com/academy/learn-for-free/courses/customer-service-essentials' AS external_url,
       JSON_ARRAY('All Employees') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 58 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.mygreatlearning.com/academy/learn-for-free/courses/customer-service-essentials')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Personal Branding for Career Success' AS title,
       'OpenLearn' AS provider,
       'Professional Skills' AS academy_category,
       'Career Development' AS sub_category,
       'Covers building a personal brand to support career growth.' AS description,
       'Beginner' AS learning_level,
       'Free Learning' AS cost_type,
       'https://www.open.edu/openlearn/education-development/employability-hub/personal-branding-career-success/content-section-overview' AS external_url,
       JSON_ARRAY('All Employees') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 59 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.open.edu/openlearn/education-development/employability-hub/personal-branding-career-success/content-section-overview')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Internships and Other Work Experiences' AS title,
       'OpenLearn' AS provider,
       'Professional Skills' AS academy_category,
       'Career Development' AS sub_category,
       'Covers how to make the most of internships and early work experience.' AS description,
       'Beginner' AS learning_level,
       'Free Learning' AS cost_type,
       'https://www.open.edu/openlearn/education-development/employability-hub/internships-and-other-work-experiences/content-section-overview' AS external_url,
       JSON_ARRAY('All Employees') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 59 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.open.edu/openlearn/education-development/employability-hub/internships-and-other-work-experiences/content-section-overview')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Exploring Career Mentoring and Coaching' AS title,
       'OpenLearn' AS provider,
       'Professional Skills' AS academy_category,
       'Learning & Development' AS sub_category,
       'Covers the fundamentals of mentoring and coaching for career development.' AS description,
       'Beginner' AS learning_level,
       'Free Learning' AS cost_type,
       'https://www.open.edu/openlearn/education-development/exploring-career-mentoring-and-coaching/content-section-overview' AS external_url,
       JSON_ARRAY('All Employees', 'Supervisors', 'Managers') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 62 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.open.edu/openlearn/education-development/exploring-career-mentoring-and-coaching/content-section-overview')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Employee Development & Well-Being' AS title,
       'Coursera' AS provider,
       'Professional Skills' AS academy_category,
       'Learning & Development' AS sub_category,
       'Covers employee development practices and workplace well-being.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://www.coursera.org/learn/employee-development-and-well-being' AS external_url,
       JSON_ARRAY('Supervisors', 'Managers') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 63 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.coursera.org/learn/employee-development-and-well-being')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Leading with Power Skills: Emotions & Emotional Intelligence' AS title,
       'Coursera' AS provider,
       'Professional Skills' AS academy_category,
       'Learning & Development' AS sub_category,
       'Covers leading through power skills, emotions, and emotional intelligence.' AS description,
       'Intermediate' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://www.coursera.org/learn/leading-with-power-skills-emotions-and-emotional-intelligence' AS external_url,
       JSON_ARRAY('Supervisors', 'Managers') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 64 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.coursera.org/learn/leading-with-power-skills-emotions-and-emotional-intelligence')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'The Six Disciplines of Breakthrough Learning – Free Introduction' AS title,
       'The 6Ds Company' AS provider,
       'Professional Skills' AS academy_category,
       'Learning & Development' AS sub_category,
       'A free introduction to the 6Ds framework: Define, Design, Deliver, Drive, Deploy, Document.' AS description,
       'All Levels' AS learning_level,
       'Free Preview / Introduction' AS cost_type,
       'https://www.the6ds.com/' AS external_url,
       JSON_ARRAY('Department Heads', 'Leadership Team') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 65 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.the6ds.com/')`,
    `INSERT INTO external_learning_resources (id, title, provider, academy_category, sub_category, description, learning_level, cost_type, external_url, recommended_audience, gmp_related, certificate_available, active, display_order, created_by)
     SELECT * FROM (SELECT
       UUID() AS id,
       'Performance Management' AS title,
       'Great Learning' AS provider,
       'Professional Skills' AS academy_category,
       'Learning & Development' AS sub_category,
       'Covers performance-management concepts from an L&D perspective.' AS description,
       'Beginner' AS learning_level,
       'Free Learning – Certificate May Be Paid' AS cost_type,
       'https://www.mygreatlearning.com/academy/learn-for-free/courses/performance-management' AS external_url,
       JSON_ARRAY('Supervisors', 'Managers') AS recommended_audience,
       0 AS gmp_related, 0 AS certificate_available, 1 AS active, 66 AS display_order, 'System (50-course QLU library import)' AS created_by
     ) AS tmp WHERE NOT EXISTS (SELECT 1 FROM external_learning_resources WHERE external_url = 'https://www.mygreatlearning.com/academy/learn-for-free/courses/performance-management')`,
    // QLU AI Assistant — lightweight conversation history. Deliberately NOT a separate
    // AI_TOOL_LOG table (per the user's own architecture doc) — every tool call the assistant
    // makes is logged through the SAME shared audit_log/logAudit() used everywhere else in the
    // app, entityType "aiToolCall", so it shows up in the existing Audit Trail screen for free
    // rather than needing a whole second audit UI just for AI actions.
    `CREATE TABLE IF NOT EXISTS ai_conversations (
       id VARCHAR(36) PRIMARY KEY,
       employee_id VARCHAR(36) NOT NULL,
       started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
       INDEX idx_ai_conv_employee (employee_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS ai_messages (
       id VARCHAR(36) PRIMARY KEY,
       conversation_id VARCHAR(36) NOT NULL,
       role ENUM('user','assistant') NOT NULL,
       content TEXT NOT NULL,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE,
       INDEX idx_ai_msg_conv (conversation_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    // ---- Skill Bank & Skill Matrix redesign (per user's spec) ----
    // Every change below is ADDITIVE: existing columns are kept exactly as they are, and every
    // new column either has a safe default or gets backfilled from the existing data so nothing
    // currently reading the old shape can break. This matters more than usual here — a prior
    // round on this exact module (skillMatrix.js) turned out to have grown independently of what
    // was shared, so this is deliberately built to not need to know what the live frontend does.

    // Skill Master: expanded fields, all nullable/defaulted so existing rows and existing
    // POST/PUT calls (which don't send these fields) keep working unchanged. One ALTER per
    // column, matching every other migration in this file — relies on the try/catch wrapper
    // above for idempotency (fails harmlessly with "Duplicate column" on re-run) rather than
    // "IF NOT EXISTS" syntax, which isn't used anywhere else in this codebase and hasn't been
    // proven against this database version.
    `ALTER TABLE skills ADD COLUMN sub_category VARCHAR(255) NULL`,
    `ALTER TABLE skills ADD COLUMN description TEXT NULL`,
    `ALTER TABLE skills ADD COLUMN skill_type ENUM('Core','Functional','Technical','Future Skill') NOT NULL DEFAULT 'Functional'`,
    `ALTER TABLE skills ADD COLUMN status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active'`,
    `ALTER TABLE skills ADD COLUMN version INT NOT NULL DEFAULT 1`,
    `ALTER TABLE skills ADD COLUMN remarks TEXT NULL`,
    `ALTER TABLE skills ADD COLUMN created_by VARCHAR(255) NULL`,
    `ALTER TABLE skills ADD COLUMN created_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
    `ALTER TABLE skills ADD COLUMN modified_by VARCHAR(255) NULL`,
    `ALTER TABLE skills ADD COLUMN modified_date TIMESTAMP NULL`,

    // Proficiency Level Master — configurable instead of hard-coded, per the spec's explicit
    // recommendation. Deliberately kept on the SAME 0-4 numeric range your data already uses
    // (not the spec's literal 1-5) so every existing stored proficiency value keeps its exact
    // meaning — this is a labeling/configurability upgrade, not a renumbering that would require
    // touching every historical skill_matrix row.
    `CREATE TABLE IF NOT EXISTS proficiency_levels (
       id VARCHAR(36) PRIMARY KEY,
       level_number TINYINT NOT NULL UNIQUE,
       level_name VARCHAR(100) NOT NULL,
       level_description TEXT,
       status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
       display_order INT NOT NULL DEFAULT 0
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `INSERT INTO proficiency_levels (id, level_number, level_name, level_description, display_order)
     SELECT * FROM (SELECT UUID() AS id, 0 AS level_number, 'Beginner' AS level_name, 'Basic awareness and requires significant guidance' AS level_description, 0 AS display_order) AS tmp
     WHERE NOT EXISTS (SELECT 1 FROM proficiency_levels WHERE level_number = 0)`,
    `INSERT INTO proficiency_levels (id, level_number, level_name, level_description, display_order)
     SELECT * FROM (SELECT UUID() AS id, 1 AS level_number, 'Basic' AS level_name, 'Can perform simple tasks with guidance' AS level_description, 1 AS display_order) AS tmp
     WHERE NOT EXISTS (SELECT 1 FROM proficiency_levels WHERE level_number = 1)`,
    `INSERT INTO proficiency_levels (id, level_number, level_name, level_description, display_order)
     SELECT * FROM (SELECT UUID() AS id, 2 AS level_number, 'Intermediate' AS level_name, 'Can independently perform regular tasks' AS level_description, 2 AS display_order) AS tmp
     WHERE NOT EXISTS (SELECT 1 FROM proficiency_levels WHERE level_number = 2)`,
    `INSERT INTO proficiency_levels (id, level_number, level_name, level_description, display_order)
     SELECT * FROM (SELECT UUID() AS id, 3 AS level_number, 'Advanced' AS level_name, 'Can handle complex tasks and guide others' AS level_description, 3 AS display_order) AS tmp
     WHERE NOT EXISTS (SELECT 1 FROM proficiency_levels WHERE level_number = 3)`,
    `INSERT INTO proficiency_levels (id, level_number, level_name, level_description, display_order)
     SELECT * FROM (SELECT UUID() AS id, 4 AS level_number, 'Expert' AS level_name, 'Subject matter expert who can lead, design and coach' AS level_description, 4 AS display_order) AS tmp
     WHERE NOT EXISTS (SELECT 1 FROM proficiency_levels WHERE level_number = 4)`,

    // Skill Matrix: add Minimum/Target/Maximum alongside the existing required_level — NOT
    // replacing it. required_level is left fully intact and still updated going forward (see
    // skillMatrix.js), so any existing code path reading it keeps working exactly as before.
    // Every existing row is backfilled so min=target=max=its old required_level, meaning no
    // employee's gap status changes the moment this migration runs — widening a range is now
    // possible, but nothing is auto-widened.
    `ALTER TABLE skill_matrix ADD COLUMN min_required_level TINYINT NULL`,
    `ALTER TABLE skill_matrix ADD COLUMN target_level TINYINT NULL`,
    `ALTER TABLE skill_matrix ADD COLUMN max_required_level TINYINT NULL`,
    `ALTER TABLE skill_matrix ADD COLUMN assessment_source VARCHAR(100) NULL`,
    `UPDATE skill_matrix SET min_required_level = required_level, target_level = required_level, max_required_level = required_level WHERE min_required_level IS NULL`,

    // Skill Assessment History — "where was the employee, where are they now" per the spec.
    // Purpose-built and separate from the generic audit_log (which already captures this as an
    // audit entry) because this is meant to be easy to query/chart per skill over time without
    // parsing generic diff JSON. No FK to skills — a history row must survive a skill later being
    // edited or deactivated, same philosophy as audit_log surviving deletion of what it describes.
    `CREATE TABLE IF NOT EXISTS skill_assessment_history (
       id VARCHAR(36) PRIMARY KEY,
       employee_id VARCHAR(36) NOT NULL,
       skill_id VARCHAR(36) NOT NULL,
       previous_level TINYINT NULL,
       new_level TINYINT NOT NULL,
       assessment_source VARCHAR(100) NULL,
       assessed_by VARCHAR(255) NULL,
       assessment_date DATE NULL,
       comments TEXT NULL,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
       INDEX idx_sah_employee_skill (employee_id, skill_id)
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
