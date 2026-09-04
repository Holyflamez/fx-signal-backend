// FX Signal backend — receives TradingView webhooks, serves signals to the app,
// and sends a push notification to your phone when a new signal arrives.
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "50kb" }));
app.use(express.text({ type: "text/plain", limit: "50kb" })); // TradingView sometimes sends text/plain

const PORT = process.env.PORT || 3000;
const SECRET = process.env.WEBHOOK_SECRET || "CHANGE_ME";
const APP_KEY = process.env.APP_KEY || "CHANGE_ME_TOO"; // the phone app sends this
const DATA_FILE = path.join(__dirname, "data.json");
const MAX_SIGNALS = 500;

const ALLOWED_PAIRS = ["EURUSD", "GBPUSD", "AUDUSD", "NZDUSD", "USDJPY", "USDCHF", "USDCAD"];

// ---------- tiny JSON store (fine for one user; swap for a DB later) ----------
function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { return { signals: [], devices: [] }; }
}
function save(db) { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }
let db = load();

// ---------- auth for the app ----------
function requireAppKey(req, res, next) {
  if (req.get("x-app-key") !== APP_KEY) return res.status(401).json({ error: "bad app key" });
  next();
}

// ---------- TradingView webhook ----------
app.post("/webhook", async (req, res) => {
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "not JSON" }); } }
  if (!body || body.secret !== SECRET) return res.status(401).json({ error: "bad secret" });

  const pair = String(body.pair || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6);
  const dir = body.dir === "SELL" ? "SELL" : "BUY";
  const entry = +body.entry, sl = +body.sl, tp = +body.tp;
  if (!ALLOWED_PAIRS.includes(pair)) return res.status(400).json({ error: "pair not allowed" });
  if (![entry, sl, tp].every(Number.isFinite)) return res.status(400).json({ error: "bad prices" });

  const sig = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    pair, dir, entry, sl, tp,
    tf: body.tf || "60",
    receivedAt: new Date().toISOString(),
    status: "open",
  };
  db.signals.unshift(sig);
  db.signals = db.signals.slice(0, MAX_SIGNALS);
  save(db);
  res.json({ ok: true, id: sig.id });

  notify(`${pair} ${dir}`, `Entry ${entry}  SL ${sl}  TP ${tp}`).catch(() => {});
});

// ---------- API used by the phone app ----------
app.get("/signals", requireAppKey, (req, res) => {
  const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 7 * 86400e3);
  res.json(db.signals.filter((s) => new Date(s.receivedAt) >= since));
});

app.post("/signals/:id/status", requireAppKey, (req, res) => {
  const s = db.signals.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  const allowed = ["open", "won", "lost", "skipped"];
  if (!allowed.includes(req.body.status)) return res.status(400).json({ error: "bad status" });
  s.status = req.body.status;
  save(db);
  res.json(s);
});

app.post("/devices", requireAppKey, (req, res) => {
  const token = String(req.body.token || "");
  if (!token.startsWith("ExponentPushToken")) return res.status(400).json({ error: "bad token" });
  if (!db.devices.includes(token)) { db.devices.push(token); save(db); }
  res.json({ ok: true });
});

app.get("/health", (_req, res) => res.json({ ok: true, signals: db.signals.length, devices: db.devices.length }));

// ---------- Expo push notifications ----------
async function notify(title, body) {
  if (!db.devices.length) return;
  const messages = db.devices.map((to) => ({ to, title, body, sound: "default" }));
  await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(messages),
  });
}

app.listen(PORT, () => console.log(`FX signal backend listening on ${PORT}`));
