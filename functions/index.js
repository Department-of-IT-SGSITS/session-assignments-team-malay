// --- Cloud Functions API skeleton --- //
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Load session signing secret from env config
const CONFIG = functions.config();
const SESSION_SECRET =
  (CONFIG.attendance && CONFIG.attendance.secret) || "dev-secret";

// Small helper: verify Firebase ID token if provided
async function getAuthUid(req) {
  const h = req.get("Authorization") || req.get("authorization");
  if (!h) return null;
  const token = h.startsWith("Bearer ") ? h.slice(7) : h;
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded.uid;
  } catch {
    return null;
  }
}

// --- 1) Teacher: create a class session (returns short-lived token) --- //
app.post("/createSession", async (req, res) => {
  try {
    const { courseId, startTs, durationMinutes = 60 } = req.body || {};
    if (!courseId || !startTs) {
      return res.status(400).json({ error: "courseId and startTs required" });
    }

    // create a short-lived session token (valid 15 minutes by default)
    const expSecs = Math.floor(Date.now() / 1000) + 15 * 60;
    const payload = { courseId, startTs };
    const sessionToken = jwt.sign({ ...payload, exp: expSecs }, SESSION_SECRET);

    // store a session doc
    const sessionRef = db.collection("sessions").doc();
    const sessionId = sessionRef.id;
    await sessionRef.set({
      sessionId,
      courseId,
      startTs,
      endTs: startTs + durationMinutes * 60 * 1000,
      createdAt: Date.now(),
      expiresAt: expSecs * 1000,
    });

    // (QR generation UI banaayenge baad me; abhi token dikha dena kaafi hai)
    return res.status(201).json({ sessionId, sessionToken });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
});


app.get("/getAttendance", async (req, res) => {
  try {
    const snapshot = await db.collection("attendance").get();
    const records = snapshot.docs.map(doc => doc.data());
    res.json(records);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch attendance" });
  }
});

// --- 2) Student: check-in using session token --- //
app.post("/checkin", async (req, res) => {
  try {
    const uid = await getAuthUid(req); // null if not provided/invalid
    // For emulator/demo, allow a fallback studentId in body if no auth
    const { sessionToken, studentId: bodyStudentId } = req.body || {};
    if (!sessionToken) return res.status(400).json({ error: "sessionToken required" });

    // Verify session token
    let decoded;
    try {
      decoded = jwt.verify(sessionToken, SESSION_SECRET);
    } catch {
      return res.status(401).json({ error: "invalid or expired session token" });
    }
    const { courseId, exp } = decoded;
    if (!courseId) return res.status(400).json({ error: "token missing courseId" });

    // decide studentId: prefer auth uid; else use body for emulator
    const studentId = uid || bodyStudentId;
    if (!studentId) return res.status(401).json({ error: "login required (or provide studentId in emulator)" });

    // find latest open session for this course (expiresAt not passed)
    const now = Date.now();
    const sessSnap = await db.collection("sessions")
      .where("courseId", "==", courseId)
      .where("expiresAt", ">=", now)
      .orderBy("expiresAt", "desc")
      .limit(1).get();

    const sessionDoc = sessSnap.empty ? null : sessSnap.docs[0].data();
    const sessionId = sessionDoc ? sessionDoc.sessionId : `unknown-${courseId}`;

    // duplicate check: one per (studentId, sessionId)
    const dup = await db.collection("attendance")
      .where("studentId", "==", studentId)
      .where("sessionId", "==", sessionId)
      .limit(1).get();
    if (!dup.empty) {
      return res.status(200).json({ ok: true, message: "already checked-in" });
    }

    const rec = {
      studentId,
      courseId,
      sessionId,
      timestamp: now,
      status: "present",
      verified: !!uid,
    };
    const ref = await db.collection("attendance").add(rec);

    // (Later we’ll update summaries here)
    return res.status(201).json({ ok: true, id: ref.id, record: rec });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
});

exports.api = functions.https.onRequest(app);
