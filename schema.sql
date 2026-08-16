-- Quest Learning University (QLC) — database schema
-- Run this once against an empty MySQL/MariaDB database (IT will create the database
-- and a dedicated user; see DEPLOY.md). Character set is set explicitly so names,
-- questions, and remarks in any language store correctly.

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS employees (
  id            VARCHAR(36) PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  associate_code VARCHAR(64) UNIQUE,
  department    VARCHAR(128),
  role_title    VARCHAR(255),
  designation   VARCHAR(255),
  grade         VARCHAR(32),
  pay_group     VARCHAR(64),
  org_name      VARCHAR(255),
  doj           DATE NULL,
  dob           DATE NULL,
  manager       VARCHAR(255),
  hod           VARCHAR(255),
  email         VARCHAR(255),
  mobile        VARCHAR(32),
  qualification VARCHAR(255),
  separation_date DATE NULL,
  employment_status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id                  VARCHAR(36) PRIMARY KEY,
  employee_id         VARCHAR(36) NULL,
  username            VARCHAR(128) NOT NULL UNIQUE,
  password_hash       VARCHAR(255) NOT NULL,
  display_name        VARCHAR(255),
  role                ENUM('Admin','HR','Manager','User','QA','SiteHead') NOT NULL,
  must_change_password TINYINT(1) DEFAULT 1,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS skills (
  id             VARCHAR(36) PRIMARY KEY,
  name           VARCHAR(255) NOT NULL,
  category       ENUM('Technical','Behavioural','Mandatory') NOT NULL,
  department     VARCHAR(128) NULL,
  designation    VARCHAR(128) NULL,
  owner_department VARCHAR(128) NULL,
  requires_qualification TINYINT(1) NOT NULL DEFAULT 0,
  criticality    ENUM('Critical','Major','Normal') NOT NULL DEFAULT 'Normal',
  level_guidance TEXT NULL,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS skill_matrix (
  id                  VARCHAR(36) PRIMARY KEY,
  employee_id         VARCHAR(36) NOT NULL,
  skill_id            VARCHAR(36) NOT NULL,
  year                INT NOT NULL DEFAULT (YEAR(CURDATE())),
  required_level      TINYINT NOT NULL DEFAULT 0,
  current_level       TINYINT NOT NULL DEFAULT 0,
  last_assessed       DATE NULL,
  qualification_status ENUM('Not Started','Trained','Assessed','Qualified','Authorized') NOT NULL DEFAULT 'Not Started',
  assessor            VARCHAR(255) NULL,
  assessment_date     DATE NULL,
  next_review_date    DATE NULL,
  qual_remarks        TEXT NULL,
  evidence_note       VARCHAR(500) NULL,
  UNIQUE KEY uniq_emp_skill_year (employee_id, skill_id, year),
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS questionnaires (
  id          VARCHAR(36) PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  category    ENUM('Evaluation','Effectiveness','SOP','Induction','Learning Academy') NOT NULL,
  is_test     TINYINT(1) DEFAULT 0,
  pass_score  INT DEFAULT 70,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS questions (
  id               VARCHAR(36) PRIMARY KEY,
  questionnaire_id VARCHAR(36) NOT NULL,
  text             TEXT NOT NULL,
  q_type           ENUM('mcq','yesno','rating5','score100','text') NOT NULL,
  options_json     TEXT NULL,
  correct_answer   VARCHAR(255) NULL,
  sort_order       INT DEFAULT 0,
  FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sessions (
  id                            VARCHAR(36) PRIMARY KEY,
  title                         VARCHAR(255) NOT NULL,
  category                      ENUM('Technical','Behavioural','Mandatory') NOT NULL,
  trainer                       VARCHAR(255),
  session_date                  DATE NOT NULL,
  start_time                    TIME,
  end_time                      TIME,
  venue                         VARCHAR(255),
  max_seats                     INT DEFAULT 20,
  skill_id                      VARCHAR(36) NULL,
  description                   TEXT,
  evaluation_questionnaire_id   VARCHAR(36) NULL,
  effectiveness_questionnaire_id VARCHAR(36) NULL,
  created_at                    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE SET NULL,
  FOREIGN KEY (evaluation_questionnaire_id) REFERENCES questionnaires(id) ON DELETE SET NULL,
  FOREIGN KEY (effectiveness_questionnaire_id) REFERENCES questionnaires(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS attendance (
  id          VARCHAR(36) PRIMARY KEY,
  session_id  VARCHAR(36) NOT NULL,
  employee_id VARCHAR(36) NOT NULL,
  status      ENUM('Nominated','Attended','Absent','Partial') DEFAULT 'Nominated',
  UNIQUE KEY uniq_session_emp (session_id, employee_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Legacy (non-questionnaire) evaluation fields, kept for sessions without a linked questionnaire
CREATE TABLE IF NOT EXISTS evaluations (
  id              VARCHAR(36) PRIMARY KEY,
  session_id      VARCHAR(36) NOT NULL,
  employee_id     VARCHAR(36) NOT NULL,
  pre_score       INT NULL,
  post_score      INT NULL,
  feedback_rating TINYINT NULL,
  UNIQUE KEY uniq_session_emp_eval (session_id, employee_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS effectiveness (
  id             VARCHAR(36) PRIMARY KEY,
  session_id     VARCHAR(36) NOT NULL,
  employee_id    VARCHAR(36) NOT NULL,
  status         ENUM('Effective','Partially Effective','Not Effective') NULL,
  remarks        TEXT,
  evaluated_date DATE NULL,
  UNIQUE KEY uniq_session_emp_eff (session_id, employee_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Questionnaire-based responses (Evaluation and Effectiveness both use this shape)
CREATE TABLE IF NOT EXISTS eval_responses (
  id          VARCHAR(36) PRIMARY KEY,
  session_id  VARCHAR(36) NOT NULL,
  employee_id VARCHAR(36) NOT NULL,
  question_id VARCHAR(36) NOT NULL,
  value       TEXT,
  UNIQUE KEY uniq_response (session_id, employee_id, question_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS eff_responses (
  id          VARCHAR(36) PRIMARY KEY,
  session_id  VARCHAR(36) NOT NULL,
  employee_id VARCHAR(36) NOT NULL,
  question_id VARCHAR(36) NOT NULL,
  value       TEXT,
  UNIQUE KEY uniq_eff_response (session_id, employee_id, question_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS test_attempts (
  id               VARCHAR(36) PRIMARY KEY,
  session_id       VARCHAR(36) NOT NULL,
  employee_id      VARCHAR(36) NOT NULL,
  questionnaire_id VARCHAR(36) NOT NULL,
  attempt_number   INT NOT NULL,
  score            INT NOT NULL,
  passed           TINYINT(1) NOT NULL,
  attempt_date     DATE NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tni (
  id          VARCHAR(36) PRIMARY KEY,
  employee_id VARCHAR(36) NOT NULL,
  skill_id    VARCHAR(36) NULL,
  year        INT NOT NULL DEFAULT (YEAR(CURDATE())),
  source      ENUM('Skill Gap','Manager Nomination','Appraisal Outcome','Compliance/Regulatory') NOT NULL,
  priority    ENUM('High','Medium','Low') NOT NULL,
  status      ENUM('Identified','Planned','Scheduled','Completed') NOT NULL DEFAULT 'Identified',
  remarks     TEXT,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mandate (
  id           VARCHAR(36) PRIMARY KEY DEFAULT 'singleton',
  target_hours INT NOT NULL DEFAULT 40,
  year         INT NOT NULL,
  updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sop_documents (
  id               VARCHAR(36) PRIMARY KEY,
  title            VARCHAR(255) NOT NULL,
  department       VARCHAR(128),
  link             VARCHAR(1024),
  file_path        VARCHAR(1024),
  questionnaire_id VARCHAR(36) NULL,
  uploaded_by      VARCHAR(255),
  date_added       DATE,
  FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sop_assignments (
  id              VARCHAR(36) PRIMARY KEY,
  sop_id          VARCHAR(36) NOT NULL,
  employee_id     VARCHAR(36) NOT NULL,
  assigned_by     VARCHAR(255),
  assignment_type ENUM('Induction','Annual Refresher') DEFAULT 'Induction',
  assigned_date   DATE,
  read_date       DATE NULL,
  test_score      INT NULL,
  completed_date  DATE NULL,
  FOREIGN KEY (sop_id) REFERENCES sop_documents(id) ON DELETE CASCADE,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS induction_records (
  id               VARCHAR(36) PRIMARY KEY,
  employee_id      VARCHAR(36) NOT NULL,
  topic            VARCHAR(128) NOT NULL,
  trainer          VARCHAR(255),
  session_date     DATE NULL,
  from_time        TIME NULL,
  to_time          TIME NULL,
  questionnaire_id VARCHAR(36) NULL,
  score            INT NULL,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS trainer_assessments (
  id                VARCHAR(36) PRIMARY KEY,
  trainer_name      VARCHAR(255) NOT NULL,
  trainer_type      ENUM('Internal','External') NOT NULL,
  subject           VARCHAR(255),
  assessed_by       VARCHAR(255),
  assessment_date   DATE,
  criteria          JSON,
  status            ENUM('Draft','Pending Approval','Approved','Rejected') DEFAULT 'Draft',
  qa_approval       JSON,
  site_head_approval JSON,
  hr_approval       JSON,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS photos (
  id          VARCHAR(36) PRIMARY KEY,
  session_id  VARCHAR(36) NULL,
  caption     VARCHAR(500),
  file_path   VARCHAR(1024) NOT NULL,
  uploaded_by VARCHAR(255),
  date_added  DATE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS content_bank (
  id               VARCHAR(36) PRIMARY KEY,
  title            VARCHAR(255) NOT NULL,
  type             ENUM('Video','PPT','Document','Book','Other','Video Course','Reading Course') NOT NULL,
  skill_id         VARCHAR(36) NULL,
  academy          VARCHAR(128) NULL,
  questionnaire_id VARCHAR(36) NULL,
  link             VARCHAR(1024),
  file_path        VARCHAR(1024) NULL,
  description      TEXT,
  date_added       DATE,
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE SET NULL,
  FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS course_completions (
  id             VARCHAR(36) PRIMARY KEY,
  employee_id    VARCHAR(36) NOT NULL,
  content_id     VARCHAR(36) NOT NULL,
  completed_date DATE,
  score          INT NULL,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (content_id) REFERENCES content_bank(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS certificate_settings (
  id                VARCHAR(36) PRIMARY KEY DEFAULT 'singleton',
  site_head_name    VARCHAR(255),
  site_head_sig     VARCHAR(1024),
  hr_name           VARCHAR(255),
  hr_sig            VARCHAR(1024),
  appreciation_text TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS surveys (
  id                  VARCHAR(36) PRIMARY KEY,
  name                VARCHAR(255) NOT NULL,
  type                VARCHAR(64) NOT NULL,
  purpose             TEXT,
  start_date          DATE,
  end_date            DATE,
  anonymous           TINYINT(1) DEFAULT 0,
  target_type         VARCHAR(32) DEFAULT 'All',
  target_departments  JSON,
  target_grades       JSON,
  target_employee_ids JSON,
  questions           JSON,
  status              ENUM('Draft','Pending Approval','Approved','Active','Closed','Archived') DEFAULT 'Draft',
  created_by          VARCHAR(255),
  created_date        DATE,
  approved_by         VARCHAR(255),
  approval_date       DATE NULL,
  published_date      DATE NULL,
  closed_date         DATE NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS survey_assignments (
  id              VARCHAR(36) PRIMARY KEY,
  survey_id       VARCHAR(36) NOT NULL,
  employee_id     VARCHAR(36) NOT NULL,
  assigned_date   DATE,
  status          ENUM('Not Started','In Progress','Completed') DEFAULT 'Not Started',
  completion_date DATE NULL,
  FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE CASCADE,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS survey_responses (
  id               VARCHAR(36) PRIMARY KEY,
  survey_id        VARCHAR(36) NOT NULL,
  employee_id      VARCHAR(36) NULL,
  anonymous_token  VARCHAR(64) NULL,
  start_datetime   DATETIME,
  submit_datetime  DATETIME NULL,
  status           ENUM('In Progress','Completed') DEFAULT 'In Progress',
  FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS survey_response_details (
  id           VARCHAR(36) PRIMARY KEY,
  response_id  VARCHAR(36) NOT NULL,
  question_id  VARCHAR(64) NOT NULL,
  value        JSON,
  FOREIGN KEY (response_id) REFERENCES survey_responses(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS survey_action_plans (
  id           VARCHAR(36) PRIMARY KEY,
  survey_id    VARCHAR(36) NOT NULL,
  finding      VARCHAR(500),
  action       TEXT,
  owner        VARCHAR(255),
  target_date  DATE NULL,
  priority     VARCHAR(16) DEFAULT 'Medium',
  status       VARCHAR(32) DEFAULT 'Open',
  remarks      TEXT,
  FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS survey_audit_log (
  id         VARCHAR(36) PRIMARY KEY,
  survey_id  VARCHAR(36) NOT NULL,
  action     VARCHAR(255),
  user       VARCHAR(255),
  date       DATE,
  FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;
