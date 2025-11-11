/* Cloud Functions API for Attendance (strict geo-verification) */

const functions = require("firebase-functions");
const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");

// ---------- Firebase Admin ----------
if (!admin.apps.length) {
  admin.initializeApp({
    projectId: process.env.GCLOUD_PROJECT || "cc-lab-project-attendance",
  });
}
const db = admin.firestore();

// ---------- Express App ----------
const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// ---------- Utils ----------
const EARTH_RADIUS = 6371000; // meters
function toRad(v) { return (v * Math.PI) / 180; }
function haversineDistance(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS * c;
}

// ---------- Health ----------
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ---------- Create Session ----------
/**
 * POST /createSession
 * body: { courseId, startTs?, expiresAt?, location?: {lat,lng}, thresholdMeters? }
 */
app.post("/createSession", async (req, res) => {
  try {
    const { courseId, startTs, expiresAt, location, thresholdMeters } = req.body || {};
    if (!courseId) return res.status(400).json({ ok: false, error: "missing_courseId" });

    const sessionRef = db.collection("sessions").doc();
    const session = {
      courseId,
      startTs: startTs || Date.now(),
      expiresAt: expiresAt || (Date.now() + 15 * 60 * 1000), // default 15 min
      token: sessionRef.id,
      createdAt: Date.now(),
      location: location || null,               // {lat,lng} | null
      thresholdMeters: Number.isFinite(thresholdMeters) ? thresholdMeters : 100,
    };

    await sessionRef.set(session);
    res.json({ ok: true, sessionId: sessionRef.id, token: sessionRef.id, session });
  } catch (err) {
    console.error("createSession error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ---------- Check-in (STRICT) ----------
/**
 * POST /checkin
 * body: { sessionToken, studentId, studentName?, location?: {lat,lng} }
 *
 * Rules:
 *  - location REQUIRED (so HTTP/non-HTTPS phones can’t fake)
 *  - session must have location; otherwise reject
 *  - out-of-range => reject & record attempt as "rejected_out_of_range"
 *  - in-range => record "present" verified=true
 */
app.post("/checkin", async (req, res) => {
  try {
    const { sessionToken, studentId, studentName, location } = req.body || {};
    if (!sessionToken || !studentId) {
      return res.status(400).json({ ok: false, error: "missing_params" });
    }

    const sessRef = db.collection("sessions").doc(sessionToken);
    const sessSnap = await sessRef.get();
    if (!sessSnap.exists) {
      return res.status(400).json({ ok: false, error: "invalid_session" });
    }
    const session = sessSnap.data();

    if (session.expiresAt && Date.now() > session.expiresAt) {
      return res.status(400).json({ ok: false, error: "session_expired" });
    }

    // prevent duplicate check-ins
    const existing = await db.collection("attendance")
      .where("sessionId", "==", sessionToken)
      .where("studentId", "==", studentId)
      .limit(1)
      .get();
    if (!existing.empty) {
      return res.json({ ok: false, error: "already_checked_in" });
    }

    // 1) Require client location
    if (!location || typeof location.lat !== "number" || typeof location.lng !== "number") {
      await db.collection("attendance").add({
        studentId,
        studentName: studentName || "",
        courseId: session.courseId || "",
        sessionId: sessionToken,
        timestamp: Date.now(),
        status: "rejected_no_location",
        verified: false,
      });
      return res.status(400).json({ ok: false, error: "location_required" });
    }

    // 2) Session must have a location to compare with
    if (!session.location || typeof session.location.lat !== "number" || typeof session.location.lng !== "number") {
      await db.collection("attendance").add({
        studentId,
        studentName: studentName || "",
        courseId: session.courseId || "",
        sessionId: sessionToken,
        timestamp: Date.now(),
        status: "rejected_no_session_location",
        verified: false,
      });
      return res.status(400).json({ ok: false, error: "session_has_no_location" });
    }

    // 3) Distance check
    const threshold = Number.isFinite(session.thresholdMeters) ? session.thresholdMeters : 100;
    const distanceMeters = haversineDistance(
      location.lat, location.lng,
      session.location.lat, session.location.lng
    );

    if (distanceMeters > threshold) {
      // Outside radius → log attempt as proxy/absent
      await db.collection("attendance").add({
        studentId,
        studentName: studentName || "",
        courseId: session.courseId || "",
        sessionId: sessionToken,
        timestamp: Date.now(),
        status: "rejected_out_of_range", // treat as ABSENT/proxy attempt
        verified: false,
        distanceMeters,
      });
      return res.status(400).json({
        ok: false,
        error: "out_of_range",
        distanceMeters,
        threshold,
      });
    }

    // In-range → VERIFIED present
    const rec = {
      studentId,
      studentName: studentName || "",
      courseId: session.courseId || "",
      sessionId: sessionToken,
      timestamp: Date.now(),
      status: "present",
      verified: true,
      distanceMeters,
    };
    await db.collection("attendance").add(rec);

    return res.json({ ok: true, verified: true, distanceMeters, record: rec });
  } catch (err) {
    console.error("checkin error:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ---------- Attendance + Roster (for dashboard) ----------
/**
 * GET /getAttendanceWithRoster
 * returns { attendance: [...], roster: [...] }
 */
app.get("/getAttendanceWithRoster", async (_req, res) => {
  try {
    const [attSnap, rosterSnap] = await Promise.all([
      db.collection("attendance").orderBy("timestamp", "desc").get(),
      db.collection("students").get(),
    ]);

    const attendance = attSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const roster     = rosterSnap.docs.map(d => d.data());

    res.json({ attendance, roster });
  } catch (err) {
    console.error("getAttendanceWithRoster error:", err);
    res.status(500).json({ ok: false, error: "failed" });
  }
});

// ---------- Finalize Session (mark ABSENT for those who never checked in) ----------
/**
 * POST /finalizeSession
 * body: { sessionId }
 * Adds "absent" entries for roster students who are not present for this session.
 */
app.post("/finalizeSession", async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ ok: false, error: "missing_sessionId" });

    const [attSnap, rosterSnap] = await Promise.all([
      db.collection("attendance").where("sessionId", "==", sessionId).get(),
      db.collection("students").get(),
    ]);

    const presentIds = new Set(
      attSnap.docs
        .map(d => d.data())
        .filter(r => r.status === "present")
        .map(r => r.studentId)
    );

    const batch = db.batch();
    let absents = 0;

    rosterSnap.forEach(doc => {
      const s = doc.data();
      if (s.studentId && !presentIds.has(s.studentId)) {
        const ref = db.collection("attendance").doc();
        batch.set(ref, {
          studentId: s.studentId,
          studentName: s.name || "",
          courseId: s.courseId || "",
          sessionId,
          timestamp: Date.now(),
          status: "absent",
          verified: false,
        });
        absents++;
      }
    });

    if (absents > 0) await batch.commit();
    res.json({ ok: true, absentsAdded: absents });
  } catch (err) {
    console.error("finalizeSession error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ---------- Export HTTPS Function (no .region() to keep v6 compatible) ----------
exports.api = functions.https.onRequest(app);
