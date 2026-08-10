require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const authRoutes = require("./routes/auth");
const employeeRoutes = require("./routes/employees");
const skillRoutes = require("./routes/skills");
const skillMatrixRoutes = require("./routes/skillMatrix");
const sessionRoutes = require("./routes/sessions");
const questionnaireRoutes = require("./routes/questionnaires");
const evaluationRoutes = require("./routes/evaluations");
const effectivenessRoutes = require("./routes/effectiveness");
const tniRoutes = require("./routes/tni");
const contentBankRoutes = require("./routes/contentBank");
const userRoutes = require("./routes/users");
const mandateRoutes = require("./routes/mandate");
const sopBankRoutes = require("./routes/sopBank");
const photoRoutes = require("./routes/photos");
const inductionRoutes = require("./routes/induction");

const app = express();

app.use(cors({ origin: process.env.PUBLIC_URL || true, credentials: true }));
app.use(express.json({ limit: "10mb" }));

// Serve uploaded Training Bank files
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
app.use("/uploads", express.static(uploadDir));

// API routes
app.use("/api/auth", authRoutes);
app.use("/api/employees", employeeRoutes);
app.use("/api/skills", skillRoutes);
app.use("/api/skill-matrix", skillMatrixRoutes);
app.use("/api/sessions", sessionRoutes);
app.use("/api/questionnaires", questionnaireRoutes);
app.use("/api/evaluations", evaluationRoutes);
app.use("/api/effectiveness", effectivenessRoutes);
app.use("/api/tni", tniRoutes);
app.use("/api/content-bank", contentBankRoutes);
app.use("/api/users", userRoutes);
app.use("/api/mandate", mandateRoutes);
app.use("/api/sop-bank", sopBankRoutes);
app.use("/api/photos", photoRoutes);
app.use("/api/induction", inductionRoutes);

app.get("/api/health", (req, res) => res.json({ ok: true, service: "QLC server" }));

// Serve the built frontend (see DEPLOY.md — the React app is built into ./public)
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(publicDir, "index.html"));
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`QLC server running on port ${port}`);
});
