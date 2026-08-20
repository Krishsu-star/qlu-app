const express = require("express");
const { requireAuth } = require("../authMiddleware");
const { sendMail } = require("../mailer");
const { logAudit } = require("../auditLogger");

const router = express.Router();

// POST /api/mail/send — sends a real email through the shared qlu@questhealthcare.co.in
// mailbox. Every "Email" action across the app calls this now (credentials, training reminders,
// survey notices, and so on) — previously these just opened a mailto: draft in whoever clicked
// the button's own email client; now they send automatically, from one consistent address, and
// are logged to the audit trail as proof the notification actually went out.
router.post("/send", requireAuth, async (req, res) => {
  const { to, subject, body, cc } = req.body;
  if (!to || !subject) return res.status(400).json({ error: "Recipient and subject are required." });
  try {
    await sendMail({ to, subject, text: body || "", cc });
  } catch (err) {
    return res.status(502).json({ error: err.message || "Could not send email." });
  }
  await logAudit(req, {
    entityType: "emailNotification", entityId: to, action: "sent",
    summary: `Email sent to ${to}${cc ? ` (cc: ${cc})` : ""}: "${subject}"`,
  });
  res.json({ ok: true });
});

module.exports = router;
