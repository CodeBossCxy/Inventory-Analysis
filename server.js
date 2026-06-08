// Vintech Inventory Web Tool — backend
// Replicates the Power Query (M) logic server-side so a browser can call it
// without exposing the Plex credential or hitting CORS.

import express from "express";
import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---- Config (from .env) -------------------------------------------------
const PLEX_HOST = process.env.PLEX_HOST || "https://Vintech.on.plex.com";
const PLEX_DATASOURCE_ID = process.env.PLEX_DATASOURCE_ID || "18777";
const PLEX_AUTH = process.env.PLEX_AUTH; // the Base64 part after "Basic "
const COMPANY_UTC_OFFSET = Number(process.env.COMPANY_UTC_OFFSET ?? -5); // Plex tenant is UTC-5
const PORT = process.env.PORT || 3000;
const REQUEST_TIMEOUT_MS = Number(process.env.PLEX_TIMEOUT_MS ?? 30000);
const VARIABILITY_CONCURRENCY = Number(process.env.VARIABILITY_CONCURRENCY ?? 5);

// Fail fast on a misconfigured deploy instead of silently returning 500s.
if (!PLEX_AUTH) {
  console.error(
    "\n✖  PLEX_AUTH is not set — refusing to start.\n" +
      "   • Local dev: copy .env.example to .env and fill in PLEX_AUTH.\n" +
      "   • Azure: add PLEX_AUTH under App Service → Settings → Environment variables.\n"
  );
  process.exit(1);
}

const ONE_DAY = 24 * 60 * 60 * 1000;

// ---- Disk cache for completed weeks -------------------------------------
// A finished week's numbers never change, so we cache each (part, week) result
// on disk. First run warms the cache; later runs are near-instant. The current
// (in-progress) week is never cached, and timed-out weeks aren't cached either
// so they retry on the next run until the cache fills in.
const CACHE_DIR = path.join(__dirname, ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "weeks.json");
const weekCache = new Map();
let cacheDirty = false;

function loadCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    const obj = JSON.parse(raw);
    for (const [k, v] of Object.entries(obj)) weekCache.set(k, v);
    console.log(`cache: loaded ${weekCache.size} cached weeks from disk`);
  } catch {
    /* no cache yet — that's fine */
  }
}

function flushCache() {
  if (!cacheDirty) return;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(weekCache)));
    cacheDirty = false;
  } catch (e) {
    console.warn("cache: failed to write", e.message);
  }
}

function cacheKey(partNo, weekStart) {
  return `${PLEX_DATASOURCE_ID}|${partNo}|${weekStart.toISOString().slice(0, 10)}`;
}

// ---- Material catalog (prefix -> name) ----------------------------------
// Each Part_No query uses `${code}-%` as the Plex wildcard.
const MATERIALS = [
  { code: "01", name: "PVC" },
  { code: "02", name: "RPVC" },
  { code: "06", name: "ABS" },
  { code: "07", name: "PCABS" },
  { code: "08", name: "HDPE" },
  { code: "09", name: "PP" },
  { code: "10", name: "TPE/TPV" },
  { code: "12", name: "LDPE" },
  { code: "14", name: "MDPE" },
  { code: "20", name: "TAPE ROLLS" },
  { code: "21", name: "PROMOTER" },
  { code: "22", name: "SLIPCOAT" },
  { code: "25", name: "FLOCK" },
  { code: "29", name: "WIRE" },
  { code: "30", name: "FOIL" },
  { code: "31", name: "MYLAR" },
  { code: "40", name: "COLORANT" },
  { code: "50", name: "PACKAGING" },
  { code: "51", name: "SPOOLS" },
  { code: "52", name: "MISC/DIE-CUT TAPE" },
  { code: "53", name: "TOTES/RETURNABLE" },
  { code: "58", name: "PALLET" },
  { code: "60", name: "TPO" },
  { code: "65", name: "METAL / WEBBING" },
  { code: "70", name: "NYLON" },
  { code: "71", name: "POLYCARB" },
  { code: "75", name: "POLYCARB" },
  { code: "80", name: "SARLINK" },
  { code: "85", name: "ULTRAMID" },
];

// Coefficient of variation = sample std-dev / mean. Returns null when the
// mean is 0 (no activity -> variability is undefined, not zero).
function coeffOfVariation(values) {
  const n = values.length;
  if (n < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (mean === 0) return null;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance) / mean;
}

// ---- Week generation (mirrors the M "WeeksList" step) -------------------
// UTC midnight of the current week's Sunday, in the company timezone.
function startOfCurrentWeekUTC() {
  // "now" shifted into the company timezone, then read in UTC components so
  // the result is independent of where the server happens to run.
  const localNow = new Date(Date.now() + COMPANY_UTC_OFFSET * 60 * 60 * 1000);
  const y = localNow.getUTCFullYear();
  const m = localNow.getUTCMonth();
  const d = localNow.getUTCDate();
  const dow = localNow.getUTCDay(); // 0 = Sunday
  return Date.UTC(y, m, d - dow);
}

// Sunday-anchored weeks, oldest -> newest, ending with the current week.
function buildWeeks(numWeeks) {
  const startOfCurrentWeek = startOfCurrentWeekUTC();
  const weeks = [];
  for (let i = numWeeks - 1; i >= 0; i--) {
    weeks.push(new Date(startOfCurrentWeek - i * 7 * ONE_DAY));
  }
  return weeks; // array of Date (UTC midnight Sundays), oldest first
}

// A week is immutable (safe to cache) once it has fully ended — i.e. its end
// (the following Sunday) is at or before the current week's Sunday.
function isCompletedWeek(weekStart) {
  return weekStart.getTime() + 7 * ONE_DAY <= startOfCurrentWeekUTC();
}

// The in-progress week still changes, so it can't use the permanent disk cache.
// But it doesn't need to be live-to-the-minute for these reports, so we keep a
// short-lived in-memory copy (default 1h) to make repeat runs fast.
const CURRENT_WEEK_TTL_MS = Number(process.env.CURRENT_WEEK_TTL_MS ?? 60 * 60 * 1000);
const currentWeekCache = new Map(); // key -> { ts, result }

// Cache-aware wrapper around fetchWeek. Completed weeks read/write the permanent
// disk cache; the in-progress week uses the short TTL cache. Errors are never
// cached (so they retry next run).
async function fetchWeekCached(partNo, weekStart) {
  const completed = isCompletedWeek(weekStart);
  const key = cacheKey(partNo, weekStart);

  if (completed) {
    if (weekCache.has(key)) return weekCache.get(key);
  } else {
    const hit = currentWeekCache.get(key);
    if (hit && Date.now() - hit.ts < CURRENT_WEEK_TTL_MS) return hit.result;
  }

  const result = await fetchWeek(partNo, weekStart);

  if (completed) {
    weekCache.set(key, result);
    cacheDirty = true;
  } else {
    currentWeekCache.set(key, { ts: Date.now(), result });
  }
  return result;
}

// Plex wants the exact "yyyy-MM-ddTHH:mm:ss.fffZ" shape — toISOString() gives it.
function isoZ(date) {
  return date.toISOString(); // e.g. 2026-06-07T00:00:00.000Z
}

// ---- One week's fetch + sum (mirrors "FetchWeekSums") --------------------
async function fetchWeek(partNo, weekStart) {
  const weekEnd = new Date(weekStart.getTime() + 7 * ONE_DAY);

  const body = JSON.stringify({
    inputs: {
      Part_No: partNo,
      Date: isoZ(weekEnd), // end of week
      Date_Orig: isoZ(weekStart), // start of week
    },
  });

  const url = `${PLEX_HOST}/api/datasources/${PLEX_DATASOURCE_ID}/execute`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${PLEX_AUTH}`,
      "Content-Type": "application/json",
    },
    body,
    // Never let a single stalled call hang the whole report.
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Plex ${resp.status} for week ${isoZ(weekStart)}: ${text.slice(0, 300)}`);
  }

  const parsed = await resp.json();
  const table = parsed?.tables?.[0] ?? { rows: [], columns: [] };
  const columns = table.columns ?? [];
  const rows = table.rows ?? [];

  // Sum a column by name; non-numeric / missing -> 0 (the M "try ... otherwise 0").
  const sumCol = (name) => {
    const idx = columns.indexOf(name);
    if (idx === -1) return 0;
    let total = 0;
    for (const r of rows) {
      const n = Number(r[idx]);
      if (Number.isFinite(n)) total += n;
    }
    return total;
  };

  const Total_Qty_Orig = sumCol("Qty_Orig");
  const Total_Qty = sumCol("Qty");
  const Total_Cost_Orig = sumCol("Cost_Orig");
  const Total_Cost = sumCol("Cost");

  const Qty_Recv = sumCol("Qty_Recv");
  const Qty_Add = sumCol("Qty_Add");
  const Qty_Subcon_Recv = sumCol("Qty_Subcon_Recv");
  const Qty_BOM = sumCol("Qty_BOM");
  const Qty_Scrap = sumCol("Qty_Scrap");
  const Qty_Ship = sumCol("Qty_Ship");
  const Qty_Subcon_Ship = sumCol("Qty_Subcon_Ship");

  const Received = Qty_Recv + Qty_Add + Qty_Subcon_Recv;
  const Depleted = Qty_BOM + Qty_Scrap + Qty_Ship + Qty_Subcon_Ship;

  const year = weekStart.getUTCFullYear();
  const weekNo = weekOfYearSunday(weekStart);

  return {
    Week_Start_Date: isoZ(weekStart).slice(0, 10),
    Year: year,
    Week_No: weekNo,
    YearWeek_SortKey: year * 100 + weekNo,
    YearWeek_Label: `${year} W${String(weekNo).padStart(2, "0")}`,
    Total_Qty_Orig,
    Total_Qty,
    Total_Cost_Orig,
    Total_Cost,
    Received,
    Depleted,
    Depleted_Neg: -Depleted,
    Net_Change: Received - Depleted,
    Qty_Recv,
    Qty_BOM,
    Qty_Scrap,
    Qty_Ship,
  };
}

// Date.WeekOfYear(..., Day.Sunday) equivalent: week 1 contains Jan 1,
// weeks start on Sunday.
function weekOfYearSunday(date) {
  const year = date.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const jan1Dow = jan1.getUTCDay(); // 0 = Sunday
  const firstSunday = new Date(Date.UTC(year, 0, 1 - jan1Dow));
  const diffDays = Math.floor((date - firstSunday) / ONE_DAY);
  return Math.floor(diffDays / 7) + 1;
}

// Simple concurrency limiter so we don't fire 52 requests at once.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const cur = i++;
      results[cur] = await fn(items[cur], cur);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---- API ----------------------------------------------------------------
app.get("/api/inventory", async (req, res) => {
  try {
    if (!PLEX_AUTH) {
      return res.status(500).json({ error: "Server is missing PLEX_AUTH (see .env)." });
    }

    const partNo = (req.query.partNo || "").trim();
    const weeks = Math.min(Math.max(parseInt(req.query.weeks, 10) || 10, 1), 104);

    if (!partNo) {
      return res.status(400).json({ error: "partNo is required (e.g. 65-%)." });
    }

    const weekDates = buildWeeks(weeks);
    const data = await mapLimit(weekDates, 6, (w) => fetchWeekCached(partNo, w));
    flushCache();

    res.json({
      partNo,
      weeks,
      generatedAt: new Date().toISOString(),
      data, // already oldest -> newest
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: String(err.message || err) });
  }
});

// ---- Variability scatter across the whole catalog -----------------------
// This is a heavy pull (every material x week), so it runs as a background job
// the browser polls — avoiding HTTP/proxy timeouts and giving a progress bar.
// The disk cache means only the first run is slow; later runs are near-instant.

// The actual computation, with a progress callback.
async function computeVariability(weeks, onProgress) {
  const weekDates = buildWeeks(weeks);
  const W = weekDates.length;

  const tasks = [];
  MATERIALS.forEach((mat, mi) => {
    weekDates.forEach((w, wi) => {
      tasks.push({ mi, wi, partNo: `${mat.code}-%`, week: w });
    });
  });

  const t0 = Date.now();
  let done = 0;
  const flat = await mapLimit(tasks, VARIABILITY_CONCURRENCY, async (t) => {
    try {
      return await fetchWeekCached(t.partNo, t.week);
    } catch {
      return { Received: 0, Depleted: 0, Total_Cost: 0, __error: true };
    } finally {
      done++;
      if (onProgress) onProgress(done, tasks.length);
    }
  });
  flushCache();

  const errCount = flat.filter((f) => f.__error).length;
  console.log(
    `variability: ${MATERIALS.length} materials x ${W} weeks = ${tasks.length} calls ` +
      `in ${((Date.now() - t0) / 1000).toFixed(1)}s (${errCount} failed/timed-out)`
  );

  const materials = MATERIALS.map((mat, mi) => {
    const series = flat.slice(mi * W, mi * W + W); // oldest -> newest
    const receipts = series.map((s) => s.Received);
    const depletion = series.map((s) => s.Depleted);
    const errors = series.filter((s) => s.__error).length;

    const meanReceipts = receipts.reduce((a, b) => a + b, 0) / W;
    const meanDepletion = depletion.reduce((a, b) => a + b, 0) / W;
    const inventory = series[series.length - 1]?.Total_Cost ?? 0; // latest week's valuation

    return {
      code: mat.code,
      name: mat.name,
      partNo: `${mat.code}-%`,
      cv_receipts: coeffOfVariation(receipts),
      cv_depletion: coeffOfVariation(depletion),
      mean_receipts: meanReceipts,
      mean_depletion: meanDepletion,
      inventory,
      errors,
    };
  });

  return { weeks, generatedAt: new Date().toISOString(), materials };
}

// In-memory job registry (single-process; fine for an internal tool).
const jobs = new Map();
let jobSeq = 0;

// Start a job. If one is already running for the same week count, reuse it so
// two users (or a double-click) don't double the Plex load.
app.post("/api/variability/start", (req, res) => {
  if (!PLEX_AUTH) {
    return res.status(500).json({ error: "Server is missing PLEX_AUTH (see .env)." });
  }
  const weeks = Math.min(Math.max(parseInt(req.query.weeks, 10) || 10, 2), 104);

  for (const [id, job] of jobs) {
    if (job.state === "running" && job.weeks === weeks) {
      return res.json({ jobId: id, reused: true });
    }
  }

  const jobId = `job_${++jobSeq}`;
  const job = { state: "running", weeks, done: 0, total: MATERIALS.length * weeks, result: null, error: null };
  jobs.set(jobId, job);

  computeVariability(weeks, (done, total) => {
    job.done = done;
    job.total = total;
  })
    .then((result) => {
      job.state = "done";
      job.result = result;
    })
    .catch((err) => {
      job.state = "error";
      job.error = String(err.message || err);
      console.error(err);
    });

  // Drop old finished jobs so the map doesn't grow unbounded.
  for (const [id, j] of jobs) {
    if (j !== job && j.state !== "running") jobs.delete(id);
  }

  res.json({ jobId, reused: false });
});

// Poll a job's status / result.
app.get("/api/variability/status", (req, res) => {
  const job = jobs.get(req.query.jobId);
  if (!job) return res.status(404).json({ error: "Unknown or expired jobId. Start a new run." });
  res.json({
    state: job.state,
    done: job.done,
    total: job.total,
    error: job.error,
    result: job.state === "done" ? job.result : null,
  });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

loadCache();

app.listen(PORT, () => {
  console.log(`Vintech Inventory Tool running at http://localhost:${PORT}`);
});
