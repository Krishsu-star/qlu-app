const express = require("express");
const { randomUUID: uuidv4 } = require("crypto");
const pool = require("../db");
const { requireAuth } = require("../authMiddleware");
const { logAudit } = require("../auditLogger");

const router = express.Router();

// ============================================================================
// QLU Smart Assistant — rule-based version. No paid AI API, no per-token cost.
//
// This replaces the earlier Claude-API-powered version with a keyword/intent
// matcher: it recognizes common question patterns and answers them either with
// a real, live data lookup (same idea as the earlier "tools," scoped to
// req.user.employeeId exactly as before) or a pre-written FAQ answer. It won't
// understand creative or unusual phrasing the way a real LLM would, but for
// the questions people actually ask day to day, it's reliable, instant, and
// free to run beyond your existing hosting.
// ============================================================================

// ---- Data lookups — identical in spirit to the earlier "tools," every one still
// hard-scoped to req.user.employeeId, never a caller-supplied id. ----

async function getMyPendingTraining(employeeId) {
  const [rows] = await pool.query(
    `SELECT s.title, s.session_date, s.start_time, s.end_time, s.venue, s.trainer
     FROM attendance a JOIN sessions s ON s.id = a.session_id
     WHERE a.employee_id = ? AND a.status = 'Nominated' ORDER BY s.session_date`,
    [employeeId]
  );
  if (!rows.length) return "You don't have any pending training right now — you're all caught up.";
  const lines = rows.map((r, i) => `${i + 1}. ${r.title} — ${formatDate(r.session_date)}, ${r.start_time}-${r.end_time} at ${r.venue || "TBD"}${r.trainer ? ` (Trainer: ${r.trainer})` : ""}`);
  return `You have ${rows.length} pending training program${rows.length > 1 ? "s" : ""}:\n${lines.join("\n")}`;
}

async function getMyTrainingHistory(employeeId) {
  const [rows] = await pool.query(
    `SELECT s.title, s.session_date, a.status, s.trainer
     FROM attendance a JOIN sessions s ON s.id = a.session_id
     WHERE a.employee_id = ? AND a.status IN ('Attended','Partial') ORDER BY s.session_date DESC LIMIT 10`,
    [employeeId]
  );
  if (!rows.length) return "You don't have any completed training on record yet.";
  const lines = rows.map((r, i) => `${i + 1}. ${r.title} — ${formatDate(r.session_date)} (${r.status})`);
  return `Here's your most recent training history (last ${rows.length}):\n${lines.join("\n")}`;
}

async function getMySkillGaps(employeeId) {
  const PROFICIENCY_LABELS = ["None", "Basic", "Working", "Proficient", "Expert"];
  const year = new Date().getFullYear();
  const [rows] = await pool.query(
    `SELECT s.name AS skill_name, sm.required_level, sm.current_level
     FROM skill_matrix sm JOIN skills s ON s.id = sm.skill_id
     WHERE sm.employee_id = ? AND sm.year = ? AND sm.current_level < sm.required_level`,
    [employeeId, year]
  );
  if (!rows.length) return `Good news — you have no open skill gaps for ${year}. Your current levels meet or exceed what's required for every tracked skill.`;
  const lines = rows.map((r, i) => `${i + 1}. ${r.skill_name}: currently ${PROFICIENCY_LABELS[r.current_level]}, required ${PROFICIENCY_LABELS[r.required_level]}`);
  return `You have ${rows.length} skill gap${rows.length > 1 ? "s" : ""} for ${year}:\n${lines.join("\n")}\n\nCheck Skill Matrix for more detail, or ask me to find a course on any of these topics.`;
}

async function getMySopStatus(employeeId) {
  const [rows] = await pool.query(
    `SELECT d.title, sa.read_date, sa.test_score, sa.assigned_date
     FROM sop_assignments sa JOIN sop_documents d ON d.id = sa.sop_id
     WHERE sa.employee_id = ? ORDER BY sa.assigned_date DESC LIMIT 10`,
    [employeeId]
  );
  if (!rows.length) return "You don't have any SOPs assigned right now.";
  const lines = rows.map((r, i) => {
    const status = r.read_date && r.test_score != null ? "Completed" : r.read_date ? "Read — Assessment Pending" : "Pending";
    return `${i + 1}. ${r.title} — ${status}`;
  });
  return `Your SOP acknowledgment status:\n${lines.join("\n")}`;
}

async function getMyExternalLearning(employeeId) {
  const [rows] = await pool.query(
    `SELECT r.title, r.provider, p.status
     FROM external_learning_progress p JOIN external_learning_resources r ON r.id = p.resource_id
     WHERE p.employee_id = ? ORDER BY p.updated_at DESC LIMIT 10`,
    [employeeId]
  );
  if (!rows.length) return "You haven't started any external learning courses yet. Try Learning Academy → External Virtual Learning to browse what's available.";
  const lines = rows.map((r, i) => `${i + 1}. ${r.title} (${r.provider}) — ${r.status}`);
  return `Your external learning progress:\n${lines.join("\n")}`;
}

async function searchLearningCatalog(query) {
  const q = `%${query}%`;
  const [rows] = await pool.query(
    `SELECT title, provider, academy_category, sub_category, learning_level, cost_type, external_url
     FROM external_learning_resources WHERE active = 1 AND (title LIKE ? OR description LIKE ? OR sub_category LIKE ? OR academy_category LIKE ?) LIMIT 5`,
    [q, q, q, q]
  );
  if (!rows.length) return `I couldn't find any courses matching "${query}" — try a broader term, or browse Learning Academy → External Virtual Learning directly.`;
  const lines = rows.map((r, i) => `${i + 1}. ${r.title} — ${r.provider} (${r.learning_level}, ${r.cost_type})\n   ${r.external_url}`);
  return `Found ${rows.length} course${rows.length > 1 ? "s" : ""} matching "${query}":\n${lines.join("\n")}\n\nOpen Learning Academy → External Virtual Learning to start one — it'll track your progress automatically.`;
}

function formatDate(d) {
  if (!d) return "—";
  const date = new Date(d);
  if (isNaN(date)) return String(d);
  return `${String(date.getDate()).padStart(2, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${date.getFullYear()}`;
}

// ---- FAQ knowledge base — grounded in how this exact QLU system actually works ----
const FAQ = [
  { keywords: ["what is qlu", "what is quest learning", "about qlu"],
    answer: "QLU (Quest Learning University) is Quest Healthcare's training and development platform — it covers internal training sessions, skill tracking, SOP acknowledgments, external learning resources, and certificates, all in one place." },
  { keywords: ["how do i complete", "how to complete training", "mark attendance", "complete a course"],
    answer: "For internal training, your trainer marks your attendance in the Training Calendar once a session happens. For external courses (Learning Academy → External Virtual Learning), click START LEARNING to open the course, then update your status as you go — Completed, and for courses with certificates, you can submit your certificate details afterward." },
  { keywords: ["certificate", "how do i get a certificate", "download certificate"],
    answer: "Once you complete an internal course in Learning Academy, a \"Certificate\" button appears — it generates a branded PDF signed by Site Head and HR. For external courses, if a certificate is offered, submit its details (number, dates) after marking the course complete, and T&D/QA will verify it." },
  { keywords: ["sop", "standard operating procedure", "acknowledge sop"],
    answer: "SOPs assigned to you appear in the SOP Bank. Completing one usually means reading the document and passing any linked assessment — you can check your current status by asking me \"what's my SOP status\"." },
  { keywords: ["login", "sign up", "account required", "need an account"],
    answer: "Most external learning resources in the library are marked as genuinely free to open — no login needed for those. A few require a free account with the provider (Alison, Coursera, etc.) to access full lesson content — this is shown per-course in the Cost column." },
  { keywords: ["gmp", "gmp test", "gmp training"],
    answer: "GMP (Good Manufacturing Practice) training shows up like any other assigned training in your pending/history list — ask me \"what training do I have pending\" to check." },
  { keywords: ["skill matrix", "what is skill matrix"],
    answer: "The Skill Matrix tracks your Required vs Current proficiency level for each skill relevant to your role. A gap means your current level is below what's required — ask me \"do I have any skill gaps\" to see yours." },
  { keywords: ["contact", "help", "support", "who do i ask", "it support"],
    answer: "For anything I can't help with, reach out to qlu@questhealthcare.co.in, or speak with your manager or HR directly." },
  { keywords: ["hello", "hi ", "hey"],
    answer: "Hello! I can help with your training, skills, SOPs, and learning resources. Try asking about your pending training, or say \"find a course on...\" followed by a topic." },
];

// ---- Intent matcher — checked in priority order (most specific first) ----
async function answerMessage(message, employeeId) {
  const text = message.toLowerCase();

  const wantsTraining = /training|course|session/.test(text);
  if (/(pending|upcoming|due|scheduled|nominat)/.test(text) && wantsTraining) return getMyPendingTraining(employeeId);
  if (/(history|completed|attended|past|record)/.test(text) && wantsTraining) return getMyTrainingHistory(employeeId);
  if (/(skill\s*gap|proficien|skill level)/.test(text)) return getMySkillGaps(employeeId);
  if (/\bsop\b|standard operating procedure|acknowledg/.test(text)) return getMySopStatus(employeeId);
  if (/(external learning|my (course )?progress|external.*status)/.test(text)) return getMyExternalLearning(employeeId);

  const searchMatch =
    text.match(/(?:find|search|looking for|recommend|any course).*?(?:course|training).*?(?:on|about|for|in|regarding)\s+([a-z0-9 ]{2,40})/) ||
    text.match(/course.*?(?:on|about)\s+([a-z0-9 ]{2,40})/);
  if (searchMatch) return searchLearningCatalog(searchMatch[1].trim());

  for (const faq of FAQ) {
    if (faq.keywords.some((k) => text.includes(k))) return faq.answer;
  }

  return "I'm not sure I understood that. I can help with: your pending training, your training history, skill gaps, SOP status, external learning progress, or finding a course (e.g. \"find a course on leadership\"). What would you like to know?";
}

// POST /api/ai/chat  body: { conversationId?, message }
router.post("/chat", requireAuth, async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: "Message is required." });
  if (!req.user.employeeId) return res.status(400).json({ error: "This account isn't linked to an employee record, so the assistant isn't available yet." });

  let conversationId = req.body.conversationId;
  if (!conversationId) {
    conversationId = uuidv4();
    await pool.query(`INSERT INTO ai_conversations (id, employee_id) VALUES (?, ?)`, [conversationId, req.user.employeeId]);
  } else {
    await pool.query(`UPDATE ai_conversations SET last_message_at = NOW() WHERE id = ?`, [conversationId]);
  }
  await pool.query(`INSERT INTO ai_messages (id, conversation_id, role, content) VALUES (?,?,?,?)`, [uuidv4(), conversationId, "user", message]);

  let reply;
  try {
    reply = await answerMessage(message, req.user.employeeId);
  } catch (err) {
    reply = "Sorry, something went wrong looking that up — please try again.";
  }

  await pool.query(`INSERT INTO ai_messages (id, conversation_id, role, content) VALUES (?,?,?,?)`, [uuidv4(), conversationId, "assistant", reply]);
  await logAudit(req, { entityType: "aiToolCall", entityId: conversationId, action: "answered", summary: `QLU Assistant answered a question (rule-based, no external AI call)` });

  res.json({ conversationId, reply });
});

router.get("/conversations/mine", requireAuth, async (req, res) => {
  if (!req.user.employeeId) return res.json([]);
  const [rows] = await pool.query(`SELECT id, started_at, last_message_at FROM ai_conversations WHERE employee_id = ? ORDER BY last_message_at DESC LIMIT 5`, [req.user.employeeId]);
  res.json(rows.map((r) => ({ id: r.id, startedAt: r.started_at, lastMessageAt: r.last_message_at })));
});

router.get("/conversations/:id/messages", requireAuth, async (req, res) => {
  const [convRows] = await pool.query(`SELECT employee_id FROM ai_conversations WHERE id = ?`, [req.params.id]);
  if (!convRows[0] || convRows[0].employee_id !== req.user.employeeId) return res.status(404).json({ error: "Conversation not found." });
  const [rows] = await pool.query(`SELECT role, content, created_at FROM ai_messages WHERE conversation_id = ? ORDER BY created_at`, [req.params.id]);
  res.json(rows.map((r) => ({ role: r.role, content: r.content, createdAt: r.created_at })));
});

module.exports = router;
