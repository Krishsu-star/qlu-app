const nodemailer = require("nodemailer");

// Shared transport for every automated QLU email — credentials, training reminders, survey
// notices, and every other "Email" action across the app all go out through this one mailbox.
// Credentials come ONLY from environment variables (SMTP_USER / SMTP_PASS, set in Render's
// dashboard) — never hard-coded here, and never something this codebase (or anyone reading it)
// can see the actual password for.
//
// Microsoft 365 requires SMTP AUTH to be explicitly enabled for the mailbox, and — if the
// account has MFA turned on, which it should — an app password instead of the normal login
// password. See MAIL-SETUP-NOTES.md for exactly how to set that up.
const transporter = nodemailer.createTransport({
  host: "smtp.office365.com",
  port: 587,
  secure: false, // STARTTLS on port 587, not implicit TLS
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendMail({ to, subject, text, cc }) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error("Email is not configured on the server yet (missing SMTP_USER/SMTP_PASS environment variables).");
  }
  await transporter.sendMail({
    from: `"Quest Learning University" <${process.env.SMTP_USER}>`,
    to,
    cc: cc || undefined,
    subject,
    text,
  });
}

module.exports = { sendMail };
