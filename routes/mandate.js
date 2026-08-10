const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../authMiddleware");

const router = express.Router();

// GET /api/mandate — the current year's target, plus every employee's actual man-hours
// (computed live from attendance, never stored). Scoped like every other module: Manager
// only sees their own team, User only sees themself.
router.get("/", requireAuth, async (req, res) => {
  try {
    const year = new Date().getFullYear();
    let [rows] = await pool.query(`SELECT * FROM mandate WHERE year = ? LIMIT 1`, [year]);
    let mandate = rows[0];
    if (!mandate) {
      mandate = { id: "singleton", target_hours: 40, year };
      await pool.query(`INSERT INTO mandate (id, target_hours, year) VALUES (?, ?, ?)`, [`mandate-${year}`, 40, year]);
    }

    let employeeFilter = "";
    let params = [`${year}-01-01`, `${year}-12-31`];
    if (req.user.role === "Manager") {
      const [me] = await pool.query(`SELECT name FROM employees WHERE id = ?`, [req.user.employeeId]);
      employeeFilter = "AND e.manager = ?";
      params.push(me[0]?.name || "");
    } else if (req.user.role === "User") {
      employeeFilter = "AND e.id = ?";
      params.push(req.user.employeeId);
    }

    const [actuals] = await pool.query(
      `SELECT e.id, e.name, e.department,
        COALESCE(SUM(TIMESTAMPDIFF(MINUTE, s.start_time, s.end_time)) / 60, 0) AS actual_hours
       FROM employees e
       LEFT JOIN attendance a ON a.employee_id = e.id AND a.status = 'Attended'
       LEFT JOIN sessions s ON s.id = a.session_id AND s.date BETWEEN ? AND ?
       WHERE 1=1 ${employeeFilter}
       GROUP BY e.id, e.name, e.department`,
      params
    );

    res.json({
      targetHours: mandate.target_hours,
      year: mandate.year,
      rows: actuals.map((r) => ({
        employeeId: r.id, name: r.name, department: r.department,
        target: mandate.target_hours, actual: Math.round(r.actual_hours * 10) / 10,
        met: r.actual_hours >= mandate.target_hours,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/mandate — Admin/HR only, updates this year's target hours
router.put("/", requireAuth, requireRole("Admin", "HR"), async (req, res) => {
  try {
    const { targetHours } = req.body;
    const year = new Date().getFullYear();
    const [existing] = await pool.query(`SELECT id FROM mandate WHERE year = ? LIMIT 1`, [year]);
    if (existing.length) {
      await pool.query(`UPDATE mandate SET target_hours = ? WHERE year = ?`, [targetHours, year]);
    } else {
      await pool.query(`INSERT INTO mandate (id, target_hours, year) VALUES (?, ?, ?)`, [`mandate-${year}`, targetHours, year]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
