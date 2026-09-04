// FX Signal backend — Route 2: no TradingView.
// Every hour it pulls 1-hour candles for the USD pairs from Twelve Data (free tier),
// runs the starter strategy (EMA 20/50 cross filtered by EMA 200, ATR stops),
// stores any new signals and pushes them to your phone.
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "50kb" }));

const PORT = process.env.PORT || 3000;
const APP_KEY = process.env.APP_KEY || "CHANGE_ME";          // phone app sends this
const TICK_KEY = process.env.TICK_KEY || APP_KEY;             // cron ping sends this
const TD_KEY = process.env.TWELVE_DATA_KEY || "";             // free key from twelvedata.com
const DATA_FILE = path.join(__dirname, "data.json");
const MAX_SIGNALS = 500;

const PAIRS = ["EURUSD", "GBPUSD", "AUDUSD", "NZDUSD", "USDJPY", "USDCHF", "USDCAD"];
const STRATEGY = { fast: 20, slow: 50, trend: 200, atrLen: 14, slMult: 1.5, tpMult: 3.0 };
const BARS_NEEDED = 260;

// ---------- tiny JSON store ----------
function load() { try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { return { signals: [], devices: [], lastBar: {} }; } }
function save(db) { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }
let db = load();
db.lastBar = db.lastBar || {};

// ---------- indicators ----------
function ema(values, len) {
  const k = 2 / (len + 1);
  const out = [];
  let e = values.slice(0, len).reduce((a, b) => a + b, 0) / len;
  for (let i = 0; i < values.length; i++) {
    if (i < len - 1) { out.push(null); continue; }
    if (i === len - 1) { out.push(e); continue; }
    e = values[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}
function atr(bars, len) {
  const tr = bars.map((b, i) => i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)));
  const out = [];
  let a = tr.slice(0, len).reduce((x, y) => x + y, 0) / len;
  for (let i = 0; i < tr.length; i++) {
    if (i < len - 1) { out.push(null); continue; }
    if (i === len - 1) { out.push(a); continue; }
    a = (a * (len - 1) + tr[i]) / len; // Wilder smoothing, same as Pine's ta.atr
    out.push(a);
  }
  return out;
}

// ---------- market data ----------
async function fetchBars(pair) {
  const sym = `${pair.slice(0, 3)}/${pair.slice(3)}`;
  const url = `https://api.twelvedata.com/time_series?symbol=${sym}&interval=1h&outputsize=${BARS_NEEDED}&apikey=${TD_KEY}`;
  let j;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(url);
    j = await r.json();
    if (j.values) break;
    const msg = j.message || "no data";
    if (attempt === 0 && /API credits/i.test(msg)) { await new Promise((res) => setTimeout(res, 61000)); continue; }
    throw new Error(msg);
  }
  // newest first → oldest first; drop a bar that is still forming
  const cutoff = Date.now() - 60 * 60 * 1000;
  return j.values
    .map((v) => ({ t: v.datetime, open: +v.open, high: +v.high, low: +v.low, close: +v.close }))
    .filter((b) => new Date(b.t.replace(" ", "T") + "Z").getTime() <= cutoff)
    .reverse();
}

// ---------- strategy ----------
function evaluate(pair, bars) {
  if (bars.length < STRATEGY.trend + 5) return null;
  const closes = bars.map((b) => b.close);
  const f = ema(closes, STRATEGY.fast), s = ema(closes, STRATEGY.slow), t = ema(closes, STRATEGY.trend), a = atr(bars, STRATEGY.atrLen);
  const i = bars.length - 1, p = i - 1;
  const crossUp = f[p] <= s[p] && f[i] > s[i];
  const crossDown = f[p] >= s[p] && f[i] < s[i];
  const close = closes[i];
  const d = pair.endsWith("JPY") ? 3 : 5;
  const rnd = (x) => +x.toFixed(d);
  if (crossUp && close > t[i]) return { dir: "BUY", entry: rnd(close), sl: rnd(close - a[i] * STRATEGY.slMult), tp: rnd(close + a[i] * STRATEGY.tpMult), bar: bars[i].t };
  if (crossDown && close < t[i]) return { dir: "SELL", entry: rnd(close), sl: rnd(close + a[i] * STRATEGY.slMult), tp: rnd(close - a[i] * STRATEGY.tpMult), bar: bars[i].t };
  return null;
}

let running = false;
async function runEngine() {
  if (running) return { skipped: "already running — a check is in progress, try again in a minute" };
  if (!TD_KEY) return { error: "TWELVE_DATA_KEY not set" };
  running = true;
  const report = {};
  try {
    for (const pair of PAIRS) {
      try {
        const bars = await fetchBars(pair);
        const last = bars[bars.length - 1]?.t;
        if (!last) { report[pair] = "no bars returned"; continue; }
        if (db.lastBar[pair] === last) { report[pair] = `already checked bar ${last}`; continue; }
        db.lastBar[pair] = last;
        const hasOpen = db.signals.some((x) => x.pair === pair && x.status === "open");
        const sig = evaluate(pair, bars);
        if (sig && !hasOpen) {
          const rec = { id: `${Date.now()}-${pair}`, pair, ...sig, tf: "60", receivedAt: new Date().toISOString(), status: "open" };
          db.signals.unshift(rec);
          db.signals = db.signals.slice(0, MAX_SIGNALS);
          report[pair] = `${sig.dir} signal`;
          notify(`${pair} ${sig.dir}`, `Entry ${sig.entry}  SL ${sig.sl}  TP ${sig.tp}`).catch(() => {});
        } else report[pair] = sig ? "signal but position already open" : "no setup";
        save(db);
      } catch (e) { report[pair] = `error: ${e.message}`; }
      await new Promise((r) => setTimeout(r, 10000)); // free tier: 8 requests/minute
    }
  } finally { running = false; }
  db.lastRun = { at: new Date().toISOString(), report };
  save(db);
  return report;
}

// run on the hour as a backup (only works while the service is awake)
setInterval(() => { if (new Date().getUTCMinutes() === 2) runEngine(); }, 60 * 1000);

// ---------- API ----------
function requireAppKey(req, res, next) {
  if (req.get("x-app-key") !== APP_KEY) return res.status(401).json({ error: "bad app key" });
  next();
}

app.get("/tick", async (req, res) => {
  if (req.query.key !== TICK_KEY) return res.status(401).json({ error: "bad key" });
  res.json({ ok: true, report: await runEngine() });
});

app.get("/signals", requireAppKey, (req, res) => {
  const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 7 * 86400e3);
  res.json(db.signals.filter((s) => new Date(s.receivedAt) >= since));
});

app.post("/signals/:id/status", requireAppKey, (req, res) => {
  const s = db.signals.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  if (!["open", "won", "lost", "skipped"].includes(req.body.status)) return res.status(400).json({ error: "bad status" });
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

app.get("/health", (_req, res) => res.json({ ok: true, signals: db.signals.length, devices: db.devices.length, dataKey: !!TD_KEY, lastRun: db.lastRun || null }));

// ---------- Expo push ----------
async function notify(title, body) {
  if (!db.devices.length) return;
  await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(db.devices.map((to) => ({ to, title, body, sound: "default" }))),
  });
}

app.listen(PORT, () => console.log(`FX signal backend listening on ${PORT}`));
