const pool = require("../db");

// Returns a Set of employee IDs the given user is allowed to see, or null to mean "everyone"
async function scopeForUser(user) {
  if (user.role === "Admin" || user.role === "HR") return null;
  if (user.role === "User") return new Set([user.employeeId]);
  if (user.role === "Manager") {
    const [meRows] = await pool.query(`SELECT name FROM employees WHERE id = ?`, [user.employeeId]);
    if (!meRows[0]) return new Set();
    const [team] = await pool.query(`SELECT id FROM employees WHERE id = ? OR LOWER(TRIM(manager)) = LOWER(TRIM(?))`, [user.employeeId, meRows[0].name]);
    return new Set(team.map((r) => r.id));
  }
  return new Set();
}

module.exports = { scopeForUser };
