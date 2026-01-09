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

// Helper: verify session via Kashier GET API
async function fetchKashierSession(sessionId) {
  const base =
    process.env.KASHIER_MODE === "live"
      ? "https://api.kashier.io"
      : "https://test-api.kashier.io";
  const url = `${base}/v3/payment/sessions/${sessionId}/payment`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: process.env.KASHIER_SECRET,
      "api-key": process.env.KASHIER_API_KEY,
      "Content-Type": "application/json",
    },
  });
  const data = await resp.json();
  if (!resp.ok)
    throw new Error(
      `Kashier verify failed: ${resp.status} ${JSON.stringify(data)}`
    );
  return data; // data.data is the payment object per Kashier docs
}

// POST /api/payment/session
app.post("/api/payment/session", async (req, res) => {
  try {
    const {
      amount,
      currency = "EGP",
      order = "order-" + Date.now(),
      merchantRedirect,
      description,
      customerEmail,
      customerReference,
      metaData,
    } = req.body || {};

    if (!amount || !merchantRedirect)
      return res
        .status(400)
        .json({ error: "missing amount or merchantRedirect" });
    if (Number(amount) <= 0)
      return res.status(400).json({ error: "invalid amount" });

    const payload = {
      expireAt: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
      maxFailureAttempts: 3,
      paymentType: "credit",
      amount: String(amount),
      currency,
      order, // merchantOrderId / order
      merchantRedirect: merchantRedirect, // frontend must send a raw URL; encode only once here if needed
      display: "en",
      type: "one-time",
      allowedMethods: "card,wallet",
      merchantId: process.env.KASHIER_MERCHANT_ID,
      failureRedirect: false,
      defaultMethod: "card",
      description: description || `Payment for ${order}`,
      customer: {
        email: customerEmail || "",
        reference: customerReference || "",
      },
      // Disable saved-card retrieval to avoid Kashier UI attempting a browser GET
      // to the cards endpoint (which lacks Authorization headers and returns 400).
      retrieveSavedCard: false,
      saveCard: 'optional',
      serverWebhook: `${process.env.SERVER_BASE}/api/payment/webhook`,
      metaData: metaData || {},
    };

    const endpoint =
      process.env.KASHIER_MODE === "live"
        ? "https://api.kashier.io/v3/payment/sessions"
        : "https://test-api.kashier.io/v3/payment/sessions";

      console.log('Creating Kashier session', { endpoint });
      console.log('Kashier payload', JSON.stringify(payload));
      const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: process.env.KASHIER_SECRET,
        "api-key": process.env.KASHIER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json();
      console.log('Kashier response', { status: resp.status, data });
    if (!resp.ok) return res.status(502).json({ error: data });

    // Persist session with merchantOrderId for reconciliation
    try {
      await db.collection("payments").add({
        sessionId: data._id || data.sessionId || null,
        merchantOrderId: payload.order,
        status: data.status || "CREATED",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        amount: payload.amount,
        currency: payload.currency,
        order: payload.order,
        response: data,
      });
    } catch (err) {
      console.error("Failed to write payment session to Firestore", err);
    }

    // Return sessionUrl to client
    return res.json({ success: true, sessionUrl: data.sessionUrl, raw: data });

  } catch (err) {
    console.error("create payment session error", err);
    return res.status(500).json({ error: String(err) });
  }
});

// POST /api/payment/webhook
app.post("/api/payment/webhook", async (req, res) => {
  try {
    const evt = req.body || {};
    const sessionId =
      evt.sessionId || evt._id || (evt.data && evt.data.sessionId);

    if (!sessionId) {
      console.warn("webhook missing sessionId", evt);
      return res.status(400).send("missing sessionId");
    }

    // Verify session with Kashier (do not trust webhook payload directly)
    let verification;
    try {
      verification = await fetchKashierSession(sessionId);
    } catch (err) {
      console.error("Failed to verify session with Kashier", err);
      return res.status(500).send("verification failed");
    }

    // Kashier returns { message, data: { ...payment... } }
    const payment = verification.data || verification;
    const status = payment.status;
    const orderId = payment.merchantOrderId || payment.order || null;

    // Only consider these as final/success states (adjust as needed)
    const successStates = ["PAID", "CAPTURED", "AUTHORIZED"];

    // Idempotent update: only update if status changed (and create if missing)
    const snapshot = await db
      .collection("payments")
      .where("sessionId", "==", sessionId)
      .limit(1)
      .get();
    if (!snapshot.empty) {
      const doc = snapshot.docs[0];
      const prev = doc.data().status;
      if (prev !== status) {
        await doc.ref.update({
          status,
          verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
          verification: payment,
        });
      }
    } else {
      await db.collection("payments").add({
        sessionId,
        orderId,
        status,
        verification: payment,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    // You can trigger post-payment work here if status is in successStates
    // e.g., fulfill order, mark registration paid, send receipt, etc.

    return res.status(200).send("OK");
  } catch (err) {
    console.error("webhook handler error", err);
    return res.status(500).json({ error: String(err) });
  }
});

const port = process.env.PORT || 5000; // Railway will provide the port
app.listen(port, () => console.log(`Backend listening on port ${port}`));

// health endpoint
app.get("/health", (req, res) => {
  res.json({ ok: true, appsScriptConfigured: !!APPSCRIPT_URL });
});
