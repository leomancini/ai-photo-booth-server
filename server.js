import express from "express";
import multer from "multer";
import sharp from "sharp";
import { WebSocketServer } from "ws";
import "dotenv/config";
import { randomUUID } from "crypto";
import { existsSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = 3139;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const POE_MODEL = "Nano-Banana-2";

// The styles generated for each set of uploads. Each entry produces one
// combined image; edit the prompts to change how the images get combined.
const BASE_PROMPT =
  "Combine these images into a single, cohesive image. Blend the " +
  "subjects and scenes together naturally into one unified composition. " +
  "IMPORTANT: WE DO NOT MODIFY PEOPLE'S FACES!!! You may render faces in " +
  "the artistic style of the image, but you must NEVER change their " +
  "recognizability: every person must remain instantly identifiable as " +
  "the exact person in the input photos. Preserve their precise facial " +
  "structure, features, proportions, and likeness. Do not beautify, age, " +
  "de-age, or alter identity in ANY way — someone who knows them must " +
  "immediately recognize them in the result. " +
  "Return a single image in portrait orientation with a 2:3 aspect ratio " +
  "(like a 4x6 photo print, taller than wide). NEVER add a border, frame, " +
  "mat, or margin of any kind — the artwork must always be full bleed, " +
  "extending edge-to-edge on all four sides. ";

const STYLES = [
  {
    id: "whimsical",
    label: "Whimsical",
    prompt:
      BASE_PROMPT +
      "Make it whimsical, fantastical, and MAXIMALIST — fill every corner " +
      "of the image with magical elements: shooting stars, rainbows, " +
      "clouds of glittering fairy dust, sparkles, glowing orbs, bubbles, " +
      "hearts, moons, butterflies, flowers, and swirling ribbons of " +
      "magical light. Bright saturated colors, dreamlike storybook " +
      "wonder, dense joyful decoration everywhere — more is more; no " +
      "empty space.",
  },
  {
    id: "classic",
    label: "Classic Family Photo",
    prompt:
      BASE_PROMPT +
      "Make it look like a classic old-style formal family photograph: " +
      "vintage studio portrait, sepia or faded tones, formal posed " +
      "composition, soft studio lighting, aged photo texture.",
  },
  {
    id: "movie-poster",
    label: "Movie Poster",
    prompt:
      BASE_PROMPT +
      "Make it look like an old-school vintage movie poster: dramatic " +
      "painted illustration style, bold title typography, retro color " +
      "palette, cinematic composition with billing block at the bottom.",
  },
];

// Max dimension the uploaded images are resized to before sending (keeps the
// request payload reasonable and improves reliability).
const MAX_DIMENSION = 1536;

// Style reference examples: drop images into style-refs/{style-id}/ and they
// get sent along with that style's request as visual examples to match.
const STYLE_REFS_DIR = join(__dirname, "style-refs");
const REF_MAX_DIMENSION = 1024;

async function loadStyleRefs(styleId) {
  const dir = join(STYLE_REFS_DIR, styleId);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => /\.(jpe?g|png|webp|gif)$/i.test(f))
    .sort();
  return Promise.all(
    files.map(async (f) => {
      const buf = await sharp(join(dir, f))
        .rotate()
        .resize(REF_MAX_DIMENSION, REF_MAX_DIMENSION, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 85 })
        .toBuffer();
      return {
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${buf.toString("base64")}` },
      };
    })
  );
}

for (const style of STYLES) {
  style.refs = await loadStyleRefs(style.id);
  if (style.refs.length) {
    console.log(`Loaded ${style.refs.length} style reference(s) for "${style.id}"`);
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only images are allowed"));
  },
});

app.use(express.json());
app.use(express.static(join(__dirname, "dist")));

// Kiosk-side endpoints require an API key passed as a ?key= query param.
// Phone-side endpoints (scanned, photos) stay open: the phone only learns
// the session ID from the QR code, which is displayed behind this key.
const BOOTH_API_KEY = process.env.BOOTH_API_KEY;
function requireKey(req, res, next) {
  if (!BOOTH_API_KEY) {
    return res.status(500).json({ error: "BOOTH_API_KEY is not configured" });
  }
  if (req.query.key !== BOOTH_API_KEY) {
    return res.status(401).json({ error: "Invalid API key" });
  }
  next();
}

// ---------------------------------------------------------------------------
// Combine three images via Nano Banana 2 on the Poe API
// ---------------------------------------------------------------------------
async function generateStyledImage(style, imageContent) {
  const refs = style.refs || [];
  const n = imageContent.length;
  let content;
  if (refs.length) {
    // References are pattern/texture images; pick one at random per
    // generation for variety.
    const ref = refs[Math.floor(Math.random() * refs.length)];
    content = [
      {
        type: "text",
        text:
          "First, here is a STYLE REFERENCE image — a pattern to draw " +
          "from. Use its colors, patterns, and decorative feel for the " +
          "background and decorative elements of your output:",
      },
      ref,
      {
        type: "text",
        text:
          n === 1
            ? "Now, here is the photo of the subjects:"
            : `Now, here are the ${n} photos of the subjects to combine:`,
      },
      ...imageContent,
      {
        type: "text",
        text:
          style.prompt +
          ` Use the subjects from the ${n === 1 ? "photo" : `${n} photos`} ` +
          "above in one image, using the style reference's palette and " +
          "patterns for the background and decorations.",
      },
    ];
  } else {
    content = [{ type: "text", text: style.prompt }, ...imageContent];
  }

  // Call Poe (OpenAI-compatible) with retries.
  let response;
  for (let retry = 0; retry < 3; retry++) {
    try {
      const poeRes = await fetch("https://api.poe.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.POE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: POE_MODEL,
          messages: [{ role: "user", content }],
          stream: false,
        }),
      });
      response = await poeRes.json();
      break;
    } catch (e) {
      if (retry < 2) await new Promise((r) => setTimeout(r, 3000));
      else throw e;
    }
  }

  const responseText = response?.choices?.[0]?.message?.content || "";
  const urlMatch = responseText.match(/https:\/\/[^\s")]+poecdn\.net\/[^\s")]+/);
  if (!urlMatch) {
    console.warn("[combine] No image URL in Poe response:", responseText.slice(0, 500));
    throw new Error("No image returned by the model");
  }

  const imgRes = await fetch(urlMatch[0]);
  if (!imgRes.ok) throw new Error("Failed to download the combined image");
  return Buffer.from(await imgRes.arrayBuffer());
}

// Normalize an uploaded file to a compressed JPEG data URL content part.
async function normalizeUpload(file) {
  const buf = await sharp(file.buffer)
    .rotate()
    .resize(MAX_DIMENSION, MAX_DIMENSION, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 88 })
    .toBuffer();
  return {
    type: "image_url",
    image_url: { url: `data:image/jpeg;base64,${buf.toString("base64")}` },
  };
}

// List the available styles so the client can render placeholders.
app.get("/api/styles", requireKey, (req, res) => {
  res.json({ styles: STYLES.map(({ id, label }) => ({ id, label })) });
});

// Processed uploads are cached in memory so the images are uploaded once and
// reused across all style requests. Entries expire after 15 minutes.
const uploadStore = new Map();
const UPLOAD_TTL_MS = 15 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of uploadStore) {
    if (now - entry.createdAt > UPLOAD_TTL_MS) uploadStore.delete(id);
  }
}, 60 * 1000).unref();

// Upload the photos once; returns an ID the style requests reuse.
app.post("/api/upload", requireKey, upload.array("images", 3), async (req, res) => {
  const files = req.files || [];
  if (files.length < 1 || files.length > 3) {
    return res.status(400).json({ error: "Please upload 1 to 3 images" });
  }

  try {
    const imageContent = await Promise.all(files.map(normalizeUpload));

    const uploadId = randomUUID();
    uploadStore.set(uploadId, { imageContent, createdAt: Date.now() });
    res.json({ uploadId });
  } catch (e) {
    console.error("[upload] error:", e);
    res.status(500).json({ error: e.message || "Failed to process images" });
  }
});

// Generate one style per request; the client fires one request per style and
// shows each result as soon as it's ready.
app.post("/api/combine", requireKey, async (req, res) => {
  if (!process.env.POE_API_KEY) {
    return res.status(500).json({ error: "POE_API_KEY is not configured" });
  }

  const style = STYLES.find((s) => s.id === req.body.style);
  if (!style) {
    return res.status(400).json({ error: "Unknown style" });
  }

  const entry = uploadStore.get(req.body.uploadId);
  if (!entry) {
    return res.status(410).json({ error: "Upload expired — please try again" });
  }

  try {
    const buf = await generateStyledImage(style, entry.imageContent);
    res.json({
      id: style.id,
      label: style.label,
      image: `data:image/jpeg;base64,${buf.toString("base64")}`,
    });
  } catch (e) {
    console.error(`[combine:${style.id}] error:`, e);
    res.status(500).json({ error: e.message || "Failed to combine images" });
  }
});

// ---------------------------------------------------------------------------
// Booth sessions: a kiosk screen (/booth) creates a session and shows a QR
// code; the phone scans it, uploads photos, and the kiosk polls for results.
// ---------------------------------------------------------------------------
const sessions = new Map();
const SESSION_TTL_MS = 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}, 5 * 60 * 1000).unref();

// WebSocket subscribers per session; the kiosk gets pushed a session
// snapshot on connect and whenever the session changes.
const sessionSockets = new Map();

function sessionSnapshot(s) {
  return {
    status: s.status,
    results: s.results.map(({ id, label, status, error }) => ({
      id,
      label,
      status,
      error,
      print: printStateFor(s.id, id),
    })),
  };
}

function broadcastSession(sessionId) {
  const s = sessions.get(sessionId);
  const sockets = sessionSockets.get(sessionId);
  if (!s || !sockets) return;
  const msg = JSON.stringify(sessionSnapshot(s));
  for (const socket of sockets) {
    try {
      socket.send(msg);
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Print queue
// ---------------------------------------------------------------------------
// The booth's printer is a Bluetooth device wired to a Raspberry Pi that this
// server cannot reach. So the Pi polls this queue instead, prints, and reports
// back.
//
// A job keeps its own copy of the image bytes. Starting a new session clears
// every previous session, and without that copy a queued job would lose the
// image out from under it the moment someone walked up and started over.
const printJobs = new Map();
const PRINT_JOB_TTL_MS = 60 * 60 * 1000;
let printJobCounter = 0;

function printStateFor(sessionId, styleId) {
  let latest = null;
  for (const job of printJobs.values()) {
    if (job.sessionId !== sessionId || job.styleId !== styleId) continue;
    if (!latest || job.createdAt >= latest.createdAt) latest = job;
  }
  return latest ? { jobId: latest.id, status: latest.status, error: latest.error } : null;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of printJobs) {
    if (now - job.createdAt > PRINT_JOB_TTL_MS) printJobs.delete(id);
  }
}, 5 * 60 * 1000).unref();

// Short session IDs keep the QR code simple. Ambiguous characters excluded.
const SESSION_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
function shortSessionId(len = 6) {
  let id = "";
  for (let i = 0; i < len; i++) {
    id += SESSION_ID_ALPHABET[Math.floor(Math.random() * SESSION_ID_ALPHABET.length)];
  }
  return id;
}

app.post("/api/session", requireKey, (req, res) => {
  // A new session immediately frees all previous sessions (and their
  // generated images) — only one booth session is active at a time.
  sessions.clear();

  const sessionId = shortSessionId();
  sessions.set(sessionId, {
    id: sessionId,
    createdAt: Date.now(),
    status: "waiting",
    results: [],
    images: new Map(),
  });
  res.json({ sessionId });
});

app.get("/api/session/:id", requireKey, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Session not found" });
  res.json({
    status: s.status,
    results: s.results.map(({ id, label, status, error }) => ({
      id,
      label,
      status,
      error,
    })),
  });
});

// The phone pings this when the upload page loads so the kiosk knows the
// QR code was scanned.
app.post("/api/session/:id/scanned", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Session not found" });
  if (s.status === "waiting") {
    s.status = "scanned";
    broadcastSession(req.params.id);
  }
  res.json({ ok: true });
});

app.get("/api/session/:id/image/:styleId", requireKey, (req, res) => {
  const s = sessions.get(req.params.id);
  const buf = s?.images.get(req.params.styleId);
  if (!buf) return res.status(404).end();
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.end(buf);
});

// Phone-side view of a session, so the upload page can show the finished
// photos and offer to print one. Keyless for the same reason as the endpoints
// above: the phone only ever learns the session ID from the QR code.
app.get("/api/session/:id/status", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Session not found" });
  res.json(sessionSnapshot(s));
});

// Phone-side thumbnail of a finished style.
app.get("/api/session/:id/preview/:styleId", (req, res) => {
  const s = sessions.get(req.params.id);
  const buf = s?.images.get(req.params.styleId);
  if (!buf) return res.status(404).end();
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.end(buf);
});

// Phone-side: ask for a print. Copies the image into the job so a later
// session reset cannot strand it.
app.post("/api/session/:id/print", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Session not found" });

  const styleId = req.body?.styleId;
  const buf = styleId && s.images.get(styleId);
  if (!buf) return res.status(404).json({ error: "That photo is not ready yet" });

  const existing = printStateFor(s.id, styleId);
  if (existing && existing.status !== "failed") {
    return res.json({ jobId: existing.jobId, status: existing.status, duplicate: true });
  }

  const job = {
    id: `p${++printJobCounter}${shortSessionId(4)}`,
    sessionId: s.id,
    styleId,
    label: s.results.find((r) => r.id === styleId)?.label || styleId,
    image: buf,
    status: "queued",
    error: null,
    createdAt: Date.now(),
  };
  printJobs.set(job.id, job);
  broadcastSession(s.id);
  res.json({ jobId: job.id, status: job.status });
});

// Device-side: the Pi claims the oldest queued job. 204 means nothing to do,
// which is the common case, so keep it cheap.
app.get("/api/print/next", requireKey, (req, res) => {
  let next = null;
  for (const job of printJobs.values()) {
    if (job.status !== "queued") continue;
    if (!next || job.createdAt < next.createdAt) next = job;
  }
  if (!next) return res.status(204).end();

  next.status = "claimed";
  next.claimedAt = Date.now();
  broadcastSession(next.sessionId);
  res.json({
    jobId: next.id,
    sessionId: next.sessionId,
    styleId: next.styleId,
    label: next.label,
    bytes: next.image.length,
  });
});

app.get("/api/print/:jobId/image", requireKey, (req, res) => {
  const job = printJobs.get(req.params.jobId);
  if (!job) return res.status(404).end();
  res.setHeader("Content-Type", "image/jpeg");
  res.end(job.image);
});

// Device-side progress. "printing" while the job is on the wire, then "done"
// or "failed" -- a failed job goes back on the queue so it can be retried.
app.post("/api/print/:jobId/status", requireKey, (req, res) => {
  const job = printJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  const status = req.body?.status;
  if (!["printing", "done", "failed"].includes(status)) {
    return res.status(400).json({ error: "status must be printing, done or failed" });
  }
  job.status = status;
  job.error = status === "failed" ? req.body?.error || "Print failed" : null;
  broadcastSession(job.sessionId);
  res.json({ ok: true });
});

// The phone posts its photos here; generation runs in the background and the
// kiosk sees each style appear in the session as it finishes.
app.post("/api/session/:id/photos", upload.array("images", 3), async (req, res) => {
  if (!process.env.POE_API_KEY) {
    return res.status(500).json({ error: "POE_API_KEY is not configured" });
  }

  const s = sessions.get(req.params.id);
  if (!s) {
    return res.status(404).json({ error: "Session not found — rescan the QR code" });
  }
  if (s.status === "generating") {
    return res.status(409).json({ error: "Already creating photos for this session" });
  }

  const files = req.files || [];
  if (files.length < 1 || files.length > 3) {
    return res.status(400).json({ error: "Please upload 1 to 3 images" });
  }

  try {
    const imageContent = await Promise.all(files.map(normalizeUpload));

    const sessionId = req.params.id;
    s.status = "generating";
    s.results = STYLES.map(({ id, label }) => ({ id, label, status: "pending" }));
    s.images = new Map();
    res.json({ ok: true });
    broadcastSession(sessionId);

    Promise.allSettled(
      STYLES.map(async (style) => {
        const entry = s.results.find((r) => r.id === style.id);
        try {
          const buf = await generateStyledImage(style, imageContent);
          s.images.set(style.id, buf);
          entry.status = "done";
        } catch (e) {
          console.error(`[session:${style.id}] error:`, e);
          entry.status = "error";
          entry.error = e.message || "Generation failed";
        }
        broadcastSession(sessionId);
      })
    ).then(() => {
      s.status = "done";
      broadcastSession(sessionId);
    });
  } catch (e) {
    console.error("[session photos] error:", e);
    res.status(500).json({ error: e.message || "Failed to process images" });
  }
});

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(join(__dirname, "dist", "index.html"));
});

const server = app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});

// Kiosk clients connect to /ws?session=<id> for live session updates.
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (socket, req) => {
  const url = new URL(req.url, "http://localhost");
  const sessionId = url.searchParams.get("session");
  if (!sessionId) return socket.close();
  if (!BOOTH_API_KEY || url.searchParams.get("key") !== BOOTH_API_KEY) {
    return socket.close();
  }

  let sockets = sessionSockets.get(sessionId);
  if (!sockets) sessionSockets.set(sessionId, (sockets = new Set()));
  sockets.add(socket);

  socket.on("close", () => {
    sockets.delete(socket);
    if (!sockets.size) sessionSockets.delete(sessionId);
  });

  const s = sessions.get(sessionId);
  if (s) socket.send(JSON.stringify(sessionSnapshot(s)));
});
