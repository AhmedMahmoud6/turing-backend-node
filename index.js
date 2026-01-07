import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import fetch from "node-fetch"; // Make sure you have installed node-fetch

const app = express();
app.use(cors());
app.use(express.json());

// Use environment variables for APPSCRIPT_URL and APPSCRIPT_TOKEN
const APPSCRIPT_URL = process.env.APPSCRIPT_URL;
const APPSCRIPT_TOKEN = process.env.APPSCRIPT_TOKEN;

// Initialize Firebase Admin.
// On Railway you can provide the service account JSON as the
// environment variable `GOOGLE_SERVICE_ACCOUNT` (one-line JSON string).
// If not present we fall back to default credentials.
let db;
try {
  if (process.env.GOOGLE_SERVICE_ACCOUNT) {
    try {
      const svc = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
      admin.initializeApp({ credential: admin.credential.cert(svc) });
      console.log(
        "Initialized firebase-admin using GOOGLE_SERVICE_ACCOUNT env"
      );
    } catch (err) {
      console.error(
        "Failed to parse GOOGLE_SERVICE_ACCOUNT JSON, falling back to default credentials:",
        err
      );
      admin.initializeApp();
    }
  } else {
    admin.initializeApp();
    console.log("Initialized firebase-admin with default credentials");
  }
  db = admin.firestore();
} catch (e) {
  console.error(
    "Failed to initialize firebase-admin or obtain firestore instance:",
    e
  );
}

if (!APPSCRIPT_URL) {
  console.warn(
    "APPSCRIPT_URL not set; endpoint will return 500 until configured"
  );
}

app.post("/api/register", async (req, res) => {
  try {
    const { workshopId, name, email, phone, age, governorate } = req.body || {};
    if (!email || !name) return res.status(400).send("missing required fields");

    // Write registration to Firestore first
    let docRef = null;
    try {
      docRef = await db.collection("workshop_registrations").add({
        workshopId: workshopId || null,
        name: name || null,
        email: email || null,
        phone: phone || null,
        age: age || null,
        governorate: governorate || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        email_requested: true,
        email_sent: false,
      });
      console.log("Saved registration to Firestore", docRef.id);
    } catch (err) {
      console.error("Failed to save registration to Firestore", err);
      // continue — we still attempt to forward, but note the error
    }

    // Ensure backend is configured with Apps Script URL
    if (!APPSCRIPT_URL) {
      console.error(
        "APPSCRIPT_URL not configured; cannot forward registration"
      );
      // update Firestore doc with error if created
      if (docRef)
        await docRef.update({
          email_error: "APPSCRIPT_URL not set",
          email_requested: false,
        });
      return res
        .status(500)
        .send("server misconfiguration: APPSCRIPT_URL not set");
    }

    // Forward to Apps Script as JSON (Apps Script expects JSON body)
    const payload = {
      name: name || "",
      email: email || "",
      phone: phone || "",
      age: age || "",
      governorate: governorate || "",
      program_id: workshopId || "",
      // include program title/name and optional group link so Apps Script can render email HTML
      program_title: (req.body && req.body.program_title) || "",
      program_name: (req.body && req.body.program_title) || "",
      group_link: (req.body && req.body.group_link) || "",
    };
    if (APPSCRIPT_TOKEN) payload.token = APPSCRIPT_TOKEN;

    console.log("Forwarding registration to Apps Script (JSON)", {
      workshopId,
      email,
      name,
    });
    let resp;
    try {
      resp = await fetch(APPSCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error("Fetch to Apps Script failed", err);
      if (docRef)
        await docRef.update({
          email_sent: false,
          email_error: String(err),
          email_requested: false,
        });
      throw err;
    }

    const text = await resp.text();
    // Try to parse JSON response and treat `{ error: ... }` as failure
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      // not JSON, ignore
    }

    if (!resp.ok || (parsed && parsed.error)) {
      const errMsg = parsed && parsed.error ? parsed.error : text;
      console.error(
        "Apps Script returned non-OK or error field",
        resp.status,
        errMsg
      );
      if (docRef)
        await docRef.update({
          email_sent: false,
          email_response: text,
          email_requested: false,
        });
      return res.status(502).send(errMsg || "apps script error");
    }

    // mark Firestore doc as emailed
    if (docRef) {
      try {
        await docRef.update({
          email_sent: true,
          email_response: text,
          emailedAt: admin.firestore.FieldValue.serverTimestamp(),
          email_requested: false,
        });
      } catch (err) {
        console.error("Failed to update Firestore doc with email status", err);
      }
    }

    return res.status(200).json({ success: true, data: text });
  } catch (err) {
    console.error("register error", err);
    return res.status(500).send(String(err));
  }
});

const port = process.env.PORT || 5000; // Railway will provide the port
app.listen(port, () => console.log(`Backend listening on port ${port}`));

// health endpoint
app.get("/health", (req, res) => {
  res.json({ ok: true, appsScriptConfigured: !!APPSCRIPT_URL });
});
