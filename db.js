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
