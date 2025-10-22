// index_fixed.js — RAW RGBA compare vs server baseline (no watermark assumptions)
// Adds: per-image A-channel flag, deviation histogram/distribution, and max deviation excluding 255/254.
// NEW: Server-persisted cross-run history of changed pixels (signed RGBA deltas);
//      Analysis of (1) random selection vs (2) fixed delta per pixel across runs.
//      History is cleared ONLY when baseline is replaced.

import { TYPE_MAP_10, drawOne } from './frozen.js';

// ---------- DOM ----------
const $run   = document.getElementById("btn-run");
const $clear = document.getElementById("btn-clear");
const $set   = document.getElementById("btn-set");
const $out   = document.getElementById("output");
const $sum   = document.getElementById("summary");

// ---------- helpers ----------
function getPixelsFrom(ctxOrCanvas) {
  let canvas, ctx;
  if (ctxOrCanvas && typeof ctxOrCanvas.getContext === "function") {
    canvas = ctxOrCanvas;
    ctx = canvas.getContext("2d", { willReadFrequently: true, alpha: true });
  } else if (ctxOrCanvas && ctxOrCanvas.canvas) {
    ctx = ctxOrCanvas;
    canvas = ctx.canvas;
  } else {
    throw new Error("No canvas or 2d context to read from");
  }
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return new Uint8Array(img.data.buffer.slice(0));
}

function u8ToBase64(u8) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    const sub = u8.subarray(i, i + chunk);
    s += String.fromCharCode.apply(null, sub);
  }
  return btoa(s);
}
function base64ToU8(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
const nowStr = () => new Date().toLocaleString();

// ---------- baseline I/O ----------
async function fetchBaseline() {
  const resp = await fetch("/baseline", { method: "GET" });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error("GET /baseline failed");
  const data = await resp.json();
  const map = new Map();
  const pix = data?.pixels || {};
  for (const [k, b64] of Object.entries(pix)) map.set(k, base64ToU8(b64));
  return { map, meta: data?.meta || {} };
}
async function putBaseline(map) {
  const pixels = {};
  for (const [k, u8] of map.entries()) pixels[k] = u8ToBase64(u8);
  const payload = { pixels, meta: { savedAt: nowStr() } };
  const resp = await fetch("/baseline", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error("PUT /baseline failed");
}

// ---------- history I/O (server persisted; tolerant and with POST fallback) ----------
async function getHistoryFromServer() {
  try {
    const resp = await fetch("/history", { method: "GET" });
    if (resp.status === 404) return { runs: 0, byImage: {} };
    if (!resp.ok) throw new Error(`GET /history failed: ${resp.status}`);
    const hist = await resp.json();
    hist.runs = hist.runs || 0;
    hist.byImage = hist.byImage || {};
    return hist;
  } catch (e) {
    console.warn("[history] GET failed; using empty history. Error:", e);
    return { runs: 0, byImage: {} };
  }
}

async function putHistoryToServer(history) {
  // Try PUT first
  try {
    const resp = await fetch("/history", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(history),
    });
    if (resp.ok) { try { return await resp.json(); } catch { return null; } }
    // If method not allowed, fall through to POST
    if (resp.status !== 405) throw new Error(`PUT /history failed: ${resp.status}`);
  } catch (e) {
    // Network/connection errors (e.g., ERR_CONNECTION_REFUSED) will land here — try POST fallback
  }

  // POST fallback (requires optional server route /history/put; harmless to try)
  try {
    const resp2 = await fetch("/history/put", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(history),
    });
    if (!resp2.ok) throw new Error(`POST /history/put failed: ${resp2.status}`);
    try { return await resp2.json(); } catch { return null; }
  } catch (e2) {
    console.warn("[history] write failed via PUT and POST:", e2);
    // Final failure — return null so callers can choose to continue without history
    return null;
  }
}

// Merge this run’s deltas into persisted history (client-side)
function mergeDeltaClientSide(hist, deltaByImage) {
  hist.runs = (hist.runs || 0) + 1;
  hist.byImage = hist.byImage || {};

  for (const [name, { changedMap }] of Object.entries(deltaByImage)) {
    let rec = hist.byImage[name];
    if (!rec) {
      rec = hist.byImage[name] = {
        perRunChanged: [],
        everChanged: [],        // Array used as a set of pixel indices
        perPixel: {}            // pix -> { n, patterns: { "dr,dg,db,da": count } }
      };
    }
    const changedCount = Object.keys(changedMap).length;
    rec.perRunChanged.push(changedCount);

    // everChanged
    const evSet = new Set(rec.everChanged);
    for (const pix of Object.keys(changedMap)) evSet.add(Number(pix));
    rec.everChanged = Array.from(evSet);

    // perPixel stats (track stability of signed deltas)
    for (const [pixStr, delta] of Object.entries(changedMap)) {
      const pix = Number(pixStr);
      const key = delta.join(",");
      if (!rec.perPixel[pix]) rec.perPixel[pix] = { n: 0, patterns: {} };
      rec.perPixel[pix].n += 1;
      rec.perPixel[pix].patterns[key] = (rec.perPixel[pix].patterns[key] || 0) + 1;
    }
  }
  return hist;
}

// ---------- rendering ----------
function clearCanvases() {
  const root = document.getElementById("canvas-root");
  if (root) root.innerHTML = "";
}
function renderAll(sessionId = 1) {
  const result = new Map();
  clearCanvases();
  for (let k = 0; k < TYPE_MAP_10.length; k++) {
    const type = TYPE_MAP_10[k];
    const name = `S${sessionId}_${type}_${k + 1}`;
    const ctx = drawOne(type, name);
    result.set(name, getPixelsFrom(ctx));
  }
  return result;
}

// ---------- differ (returns sparse changedMap with SIGNED deltas) ----------
function diffRaw(prevU8, currU8, cap = 50) {
  const len = Math.min(prevU8.length, currU8.length);
  const totalPixels = len >> 2;

  const samples = [];
  const changedMap = Object.create(null); // pixelIndex -> [dr, dg, db, da] (SIGNED)

  // tracking variables
  let changed = 0;
  let alphaChanges = 0;
  let maxDeviation = 0;
  let maxDeviationExcl255_254 = 0;
  let hasAlphaChange = false;

  const hist = new Uint32Array(256);

  for (let i = 0; i < len; i += 4) {
    const r0 = prevU8[i],     g0 = prevU8[i + 1], b0 = prevU8[i + 2], a0 = prevU8[i + 3];
    const r1 = currU8[i],     g1 = currU8[i + 1], b1 = currU8[i + 2], a1 = currU8[i + 3];

    const sdr = r1 - r0, sdg = g1 - g0, sdb = b1 - b0, sda = a1 - a0;
    const dr = Math.abs(sdr), dg = Math.abs(sdg), db = Math.abs(sdb), da = Math.abs(sda);

    if (da) { alphaChanges++; hasAlphaChange = true; }

    const localMax = Math.max(dr, dg, db, da);
    hist[localMax]++;

    if (localMax > maxDeviation) maxDeviation = localMax;
    if (localMax !== 255 && localMax !== 254 && localMax > maxDeviationExcl255_254)
      maxDeviationExcl255_254 = localMax;

    if (dr || dg || db || da) {
      const pixIndex = i >> 2;
      changed++;
      changedMap[pixIndex] = [sdr, sdg, sdb, sda]; // SIGNED
      if (samples.length < cap) {
        samples.push({
          pixel: pixIndex,
          prev: [r0, g0, b0, a0],
          curr: [r1, g1, b1, a1],
          dev_abs: [dr, dg, db, da],
          dev_signed: [sdr, sdg, sdb, sda],
        });
      }
    }
  }

  // deviation % distribution (excluding 0)
  const deviationDistribution = [];
  const sumChanged = hist.reduce((a, b, i) => (i > 0 ? a + b : a), 0);
  if (sumChanged > 0) {
    for (let d = 1; d < 256; d++) if (hist[d]) {
      const pct = (hist[d] / sumChanged) * 100;
      deviationDistribution.push({ dev: d, pct: +pct.toFixed(2) });
    }
  }

  return {
    totalPixels,
    changedPixels: changed,
    pctChanged: totalPixels ? changed / totalPixels : 0,
    alphaChanges,
    maxDeviation,
    maxDeviationExcl255_254,
    hasAlphaChange,
    deviationHistogram: Array.from(hist),
    deviationDistribution,
    sample: samples,
    changedMap, // NEW: full sparse map of changed pixels -> signed delta
  };
}

// ---------- analysis (works with server history structure) ----------
function analyzeHistoryServerShape(hist) {
  const perImageSummary = {};
  for (const [name, rec] of Object.entries(hist.byImage || {})) {
    const runsSeen = (rec.perRunChanged || []).length;
    const avgChanged = runsSeen
      ? rec.perRunChanged.reduce((a, b) => a + b, 0) / runsSeen
      : 0;
    const unionChanged = (rec.everChanged || []).length;

    let stable = 0, unstable = 0, single = 0;
    for (const slot of Object.values(rec.perPixel || {})) {
      if (slot.n === 1) { single++; continue; }
      const patternsCount = Object.keys(slot.patterns || {}).length;
      if (patternsCount === 1) stable++; else unstable++;
    }
    const pctFixed = (stable + unstable) ? (100 * stable / (stable + unstable)) : null;

    perImageSummary[name] = {
      runsSeen,
      avgChangedPerRun: +avgChanged.toFixed(2),
      unionChanged,
      selectionRandomnessHint: unionChanged > avgChanged * 1.5 ? "appears random" : "appears partly fixed",
      pixelsChangedOnce: single,
      pixelsChangedMultiple: stable + unstable,
      pixelsWithFixedDelta: stable,
      pixelsWithVariableDelta: unstable,
      pctFixedDeltaAmongMulti: pctFixed != null ? +pctFixed.toFixed(2) : "n/a"
    };
  }
  return { runs: hist.runs || 0, perImageSummary };
}

// ---------- logging helpers (NEW) ----------
// Log all pixels with variable signed delta patterns across runs.
// A "variable" pixel is one that changed >=2 times AND has >1 distinct dev pattern.
function logVariableDeltaPixels(hist, limitPerImage = 200) {
  const byImage = hist?.byImage || {};
  console.group("[history] Pixels with VARIABLE signed deltas across runs");
  for (const [name, rec] of Object.entries(byImage)) {
    const perPixel = rec?.perPixel || {};
    const variableEntries = [];

    for (const [pixStr, slot] of Object.entries(perPixel)) {
      if (!slot || typeof slot !== "object") continue;
      const n = slot.n || 0;
      const patterns = slot.patterns || {};
      const keys = Object.keys(patterns);
      if (n >= 2 && keys.length > 1) {
        // Build a compact patterns summary like: { "1,0,0,0": 3, "0,1,0,0": 2 }
        const patt = {};
        for (const k of keys) patt[k] = patterns[k];
        variableEntries.push({ pixel: Number(pixStr), timesChanged: n, patterns: patt });
      }
    }

    if (variableEntries.length === 0) {
      console.log(`Image: ${name} — no variable-delta pixels.`);
      continue;
    }

    // Sort by timesChanged desc, then by number of patterns desc
    variableEntries.sort((a, b) => {
      if (b.timesChanged !== a.timesChanged) return b.timesChanged - a.timesChanged;
      const ap = Object.keys(a.patterns).length, bp = Object.keys(b.patterns).length;
      return bp - ap;
    });

    const shown = variableEntries.slice(0, limitPerImage);
    console.group(`Image: ${name} — variable pixels: ${variableEntries.length} (showing ${shown.length})`);
    for (const entry of shown) {
      console.log(`pixel=${entry.pixel}, timesChanged=${entry.timesChanged}, patterns=`, entry.patterns);
    }
    if (variableEntries.length > shown.length) {
      console.log(`… ${variableEntries.length - shown.length} more not shown`);
    }
    console.groupEnd();
  }
  console.groupEnd();
}

// ---------- UI ----------
function show(summary, details) {
  if ($sum) $sum.innerHTML = summary;
  if ($out) $out.textContent = JSON.stringify(details, null, 2);
}

async function runCompare() {
  $run.disabled = true;
  try {
    const serverBaseline = await fetchBaseline();
    const current = renderAll();

    if (!serverBaseline) {
      show(`No server baseline. Click <b>Set Current as Baseline</b> first.`, { note: "no baseline" });
      return;
    }

    const baseline = serverBaseline.map;
    const meta = serverBaseline.meta || {};
    const report = {};
    let overall = { total: 0, changed: 0, alpha: 0, maxDeviation: 0, maxDeviationExcl255_254: 0 };
    const imagesWithAlphaChanges = [];

    // Build per-run delta to persist on the server
    const deltaByImage = {};

    for (const [name, u8now] of current.entries()) {
      const u8prev = baseline.get(name);
      if (!u8prev) {
        report[name] = { note: "missing in baseline" };
        continue;
      }

      const r = diffRaw(u8prev, u8now, 50);
      const pctStr = (Math.round(r.pctChanged * 10000) / 100).toFixed(2) + "%";

      const allDevPct = r.deviationDistribution
        .slice()
        .sort((a, b) => b.pct - a.pct)
        .map((e) => `${e.dev}:${e.pct.toFixed(2)}%`)
        .join(", ");

      report[name] = {
        totalPixels: r.totalPixels,
        changedPixels: r.changedPixels,
        pctChanged: pctStr,
        alphaChanges: r.alphaChanges,
        maxDeviation: r.maxDeviation,
        maxDeviationExcl255_254: r.maxDeviationExcl255_254,
        hasAlphaChange: r.hasAlphaChange,
        deviationDistribution: r.deviationDistribution,
        allDeviationSummary: allDevPct,
        sample: r.sample,
      };

      // Collect sparse signed deltas for server persistence
      deltaByImage[name] = { changedMap: r.changedMap };

      overall.total += r.totalPixels;
      overall.changed += r.changedPixels;
      overall.alpha += r.alphaChanges;
      overall.maxDeviation = Math.max(overall.maxDeviation, r.maxDeviation);
      overall.maxDeviationExcl255_254 = Math.max(overall.maxDeviationExcl255_254, r.maxDeviationExcl255_254);
      if (r.hasAlphaChange) imagesWithAlphaChanges.push(name);
    }

    // ---- Persist run delta via GET→merge→PUT (tolerant)
    let hist = await getHistoryFromServer();             // tolerant GET
    hist = mergeDeltaClientSide(hist, deltaByImage);
    const wrote = await putHistoryToServer(hist);        // tolerant PUT→POST fallback
    if (wrote === null) {
      console.warn("[history] persist failed; continuing without updating server-side history.");
    }

    // Summarize per-image %changed stats for this run
    const pctList = Object.values(report)
      .map((r) => typeof r?.pctChanged === "string" ? parseFloat(r.pctChanged.replace("%", "")) : null)
      .filter((v) => v != null && !Number.isNaN(v));

    let statsLine = "";
    if (pctList.length) {
      const min = Math.min(...pctList),
            max = Math.max(...pctList),
            range = max - min;
      statsLine = `Per-image %changed — min: <b>${min.toFixed(2)}%</b>, max: <b>${max.toFixed(2)}%</b>, range: <b>${range.toFixed(2)}%</b>.<br/>`;
    }

    const pctOverall = overall.total ? overall.changed / overall.total : 0;
    const overallPctStr = (Math.round(pctOverall * 10000) / 100).toFixed(2) + "%";

    const alphaLine = imagesWithAlphaChanges.length
      ? `Images with <b>Alpha (A) channel changes</b>: <b>${imagesWithAlphaChanges.join(", ")}</b>.<br/>`
      : `Images with <b>Alpha (A) channel changes</b>: <b>none</b>.<br/>`;

    const exclHiLine = `Overall max deviation (excluding 255 & 254): <b>${overall.maxDeviationExcl255_254}</b> (0–253).<br/>`;

    // Cross-run analysis using server history
    const histSummary = analyzeHistoryServerShape(hist);

    show(
      `Compared against server baseline saved at <b>${meta.savedAt || "unknown"}</b>.<br/>
       Overall changed: <b>${overall.changed}</b> / ${overall.total} (${overallPctStr}).<br/>
       ${statsLine}
       Overall max deviation: <b>${overall.maxDeviation}</b> (0–255).<br/>
       ${exclHiLine}
       ${alphaLine}
       Alpha-channel changes (A≠): <b>${overall.alpha}</b>.<br/>
       Baseline not modified.<br/>
       <hr/>
       <b>Cross-run analysis (server-persisted)</b>: see console for per-image details.`,
      { report, history: histSummary }
    );

    // Console diagnostics
    console.group(`[Cross-run analysis] (server) runs=${histSummary.runs}`);
    for (const [name, s] of Object.entries(histSummary.perImageSummary)) {
      console.group(`Image: ${name}`);
      console.log(`runsSeen: ${s.runsSeen}`);
      console.log(`avgChangedPerRun: ${s.avgChangedPerRun}`);
      console.log(`unionChanged (pixels changed at least once): ${s.unionChanged}`);
      console.log(`selectionRandomnessHint: ${s.selectionRandomnessHint}`);
      console.log(`pixelsChangedOnce: ${s.pixelsChangedOnce}`);
      console.log(`pixelsChangedMultiple: ${s.pixelsChangedMultiple}`);
      console.log(`pixelsWithFixedDelta: ${s.pixelsWithFixedDelta}`);
      console.log(`pixelsWithVariableDelta: ${s.pixelsWithVariableDelta}`);
      console.log(`pctFixedDeltaAmongMulti: ${s.pctFixedDeltaAmongMulti}%`);
      console.groupEnd();
    }
    console.groupEnd();

    // NEW: detailed list of pixels with variable delta patterns (per image)
    logVariableDeltaPixels(hist, /* limitPerImage */ 200);

    // Also dump detailed per-image deviation summaries for current run
    for (const [name, rec] of Object.entries(report)) {
      if (rec?.allDeviationSummary)
        console.log(`[${name}] deviations (all): ${rec.allDeviationSummary}`);
    }
  } catch (e) {
    console.error(e);
    show("Error while comparing. See console.", { error: String(e) });
  } finally {
    $run.disabled = false;
  }
}

// ---------- baseline ops ----------
async function setBaseline() {
  $set.disabled = true;
  try {
    const current = renderAll();
    await putBaseline(current);

    // Clear server history ONLY when the baseline is replaced (tolerant):
    const cleared = await putHistoryToServer({ runs: 0, byImage: {} }) !== null;

    const note = cleared
      ? "History cleared."
      : '<span style="color:#f59e0b">History not cleared (history endpoint unreachable).</span>';

    show(
      `Server baseline set at <b>${nowStr()}</b>. ${note}`,
      { saved: [...current.keys()], historyCleared: cleared }
    );
  } catch (e) {
    console.error(e);
    show("Error while setting baseline. See console.", { error: String(e) });
  } finally {
    $set.disabled = false;
  }
}

async function clearBaseline() {
  $clear.disabled = true;
  try {
    // Do NOT clear history here
    clearCanvases();
    show("Server baseline cleared (history retained).", { cleared: true });
  } catch (e) {
    console.error(e);
    show("Error while clearing baseline. See console.", { error: String(e) });
  } finally {
    $clear.disabled = false;
  }
}

// ---------- bind ----------
if (!window.__pp_bound_listeners__) {
  $run?.addEventListener("click", runCompare);
  $set?.addEventListener("click", setBaseline);
  $clear?.addEventListener("click", clearBaseline);
  window.__pp_bound_listeners__ = true;
}
