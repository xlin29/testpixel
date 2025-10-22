// compare_png.js — server-backed persistence + existing comparisons + toDataURL pixel comparisons (+ A-channel any-change)
// Requires server endpoints:
//   GET  /last-session  -> { raw, png_blob, png_durl, meta:{savedAt} } or 404
//   PUT  /last-session  -> accepts { raw?, png_blob?, png_durl?, meta? } (any subset)

import { TYPE_MAP_10, drawOne } from "./frozen.js";

// ---------- DOM ----------
const $run  = document.getElementById("btn-run");
const $sum  = document.getElementById("summary");
const $out  = document.getElementById("output");
const $root = document.getElementById("canvas-root");
const $clr  = document.getElementById("btn-clear-last");

// Keep current maps in memory so "Clear Last Session" can replace server files
let CURRENT_RAW_MAP   = null; // Map<string, Uint8Array>  (raw RGBA from canvases)
let CURRENT_PNG_PIX   = null; // Map<string, Uint8Array>  (decoded via toBlob)
let CURRENT_PNG_DURL  = null; // Map<string, string>      (toDataURL)
let CURRENT_DURL_PIX  = null; // Map<string, Uint8Array>  (decoded from toDataURL)

// ---------- base64 helpers for RAW/pixel blobs ----------
function u8ToB64(u8){
  let s = "", chunk = 0x8000;
  for (let i=0;i<u8.length;i+=chunk) s += String.fromCharCode.apply(null, u8.subarray(i, i+chunk));
  return btoa(s);
}
function b64ToU8(b64){
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
function rawMapToObj(map){ const obj = {}; for (const [k, u8] of map.entries()) obj[k] = u8ToB64(u8); return obj; }
function objToRawMap(obj){ const map = new Map(); for (const [k, b64] of Object.entries(obj || {})) map.set(k, b64ToU8(b64)); return map; }

// ---------- server I/O (/last-session) ----------
// Server canonical schema: { raw:{}, png_blob:{}, png_durl:{}, meta:{savedAt} }
async function getLastSession(){
  const resp = await fetch("/last-session", { method: "GET" });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error("GET /last-session failed");
  const data = await resp.json();
  return {
    when: data?.meta?.savedAt || null,
    rawMap: objToRawMap(data?.raw || {}),
    pngBlobMap: objToRawMap(data?.png_blob || {}),
    pngDURL: new Map(Object.entries(data?.png_durl || {})),
  };
}
async function putLastSession(rawMap, pngBlobPixMap, pngDURLMap){
  const payload = {
    raw: rawMapToObj(rawMap),
    png_blob: rawMapToObj(pngBlobPixMap),
    png_durl: Object.fromEntries(pngDURLMap.entries()),
    meta: { savedAt: new Date().toISOString() },
  };
  const resp = await fetch("/last-session", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error("PUT /last-session failed");
  return payload.meta.savedAt;
}
// Initialize once if missing (so you won’t see "(no prev)" after restart)
async function maybeInitLastSession(rawMap, pngBlobPixMap, pngDURLMap, last){
  if (last) return last;
  const when = await putLastSession(rawMap, pngBlobPixMap, pngDURLMap);
  return { when, rawMap, pngBlobMap: pngBlobPixMap, pngDURL: pngDURLMap };
}

// ---------- pixel helpers ----------
function getPixelsFrom(ctxOrCanvas){
  let canvas, ctx;
  if (ctxOrCanvas && typeof ctxOrCanvas.getContext === "function"){
    canvas = ctxOrCanvas; ctx = canvas.getContext("2d", { willReadFrequently:true, alpha:true });
  } else if (ctxOrCanvas && ctxOrCanvas.canvas){
    ctx = ctxOrCanvas; canvas = ctx.canvas;
  } else { throw new Error("No canvas or 2d context to read from"); }
  const img = ctx.getImageData(0,0,canvas.width,canvas.height);
  return new Uint8Array(img.data.buffer.slice(0));
}
function nowStr(){ return new Date().toLocaleString(); }
function makeCanvas(w, h){ const cv = document.createElement("canvas"); cv.width = w; cv.height = h; return cv; }
function clearRoot(){ $root.innerHTML = ""; }

// Decode a PNG dataURL to pixels (draw to canvas then read)
async function dataURLToPixels(durl, w, h){
  const img = await new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("PNG dataURL decode failed"));
    im.src = durl;
  });
  const cv = makeCanvas(w, h);
  const ctx = cv.getContext("2d", { willReadFrequently:true, alpha:true });
  // ensure opaque floor (consistent with other paths)
  ctx.save(); ctx.globalCompositeOperation = "destination-over"; ctx.fillStyle = "#ffffff";
  ctx.fillRect(0,0,w,h); ctx.restore();
  ctx.drawImage(img, 0, 0, w, h);
  return getPixelsFrom(cv);
}

// Canvas → PNG pixels via toBlob round-trip
async function roundTripPNGAndGetPixels(srcCanvas){
  const blob = await new Promise(res => srcCanvas.toBlob(res, "image/png"));
  const url = URL.createObjectURL(blob);
  try{
    const img = await new Promise((resolve, reject)=>{
      const im = new Image();
      im.onload = ()=> resolve(im);
      im.onerror = ()=> reject(new Error("PNG decode failed"));
      im.src = url;
    });
    const cv = makeCanvas(srcCanvas.width, srcCanvas.height);
    const ctx = cv.getContext("2d", { willReadFrequently:true, alpha:true });
    ctx.save(); ctx.globalCompositeOperation = "destination-over"; ctx.fillStyle = "#ffffff";
    ctx.fillRect(0,0,cv.width,cv.height); ctx.restore();
    ctx.drawImage(img, 0, 0);
    return getPixelsFrom(cv);
  } finally { URL.revokeObjectURL(url); }
}

// RAW-pixel diff (includes full metrics + Alpha-channel any-change count)
function diffAll(prevU8, currU8){
  const len = Math.min(prevU8.length, currU8.length);
  const totalPixels = len >> 2;
  const diffs = [];
  const hist = new Uint32Array(256);
  let changed = 0, maxDeviation = 0, maxDeviationExcl255_254 = 0;
  let alphaChanges = 0;
  let hasAlphaChange = false;

  for (let i=0;i<len;i+=4){
    const r0=prevU8[i], g0=prevU8[i+1], b0=prevU8[i+2], a0=prevU8[i+3];
    const r1=currU8[i], g1=currU8[i+1], b1=currU8[i+2], a1=currU8[i+3];

    // channel-wise diffs (RGB deltas still used for magnitude / histogram)
    const dr=Math.abs(r1-r0), dg=Math.abs(g1-g0), db=Math.abs(b1-b0), da=Math.abs(a1-a0);

    // **A-channel any-change**: count whenever the alpha byte differs at all
    if (a0 !== a1){ alphaChanges++; hasAlphaChange = true; }

    const localMax = Math.max(dr,dg,db,da);
    hist[localMax]++;
    if (localMax>maxDeviation) maxDeviation=localMax;
    if (localMax!==255 && localMax!==254 && localMax>maxDeviationExcl255_254) maxDeviationExcl255_254 = localMax;

    if (dr||dg||db||da){
      changed++;
      diffs.push({ pixel:i>>2, prev:[r0,g0,b0,a0], curr:[r1,g1,b1,a1], dev:[dr,dg,db,da] });
    }
  }

  const deviationDistribution = [];
  const sumChanged = hist.reduce((a,b,i)=> i>0 ? a+b : a, 0);
  if (sumChanged>0){
    for (let d=1; d<256; d++){
      if (!hist[d]) continue;
      deviationDistribution.push({ dev:d, pct:+((hist[d]/sumChanged)*100).toFixed(2) });
    }
  }

  return {
    totalPixels,
    changedPixels: changed,
    pctChanged: totalPixels ? changed/totalPixels : 0,
    maxDeviation,
    maxDeviationExcl255_254,
    deviationHistogram: Array.from(hist),
    deviationDistribution,
    diffs,
    alphaChanges,
    hasAlphaChange,
  };
}

// ---------- UI ----------
function show(summary, details){
  if ($sum) $sum.innerHTML = summary;
  if ($out) $out.textContent = JSON.stringify(details, null, 2);
}
const line = (s) =>
  `diff: <b>${s.changedPixels}</b> / ${s.totalPixels} (${(s.pctChanged*100).toFixed(2)}%) · ` +
  `Max <b>${s.maxDeviation}</b> · Max excl 255 & 254 <b>${s.maxDeviationExcl255_254}</b> · ` +
  `A≠ <b>${s.alphaChanges || 0}</b>`;

function addItemCard(name, rawCanvas, stats, lastWhen){
  const {
    sRawPng,        // existing: RAW vs PNG(toBlob decoded)
    sRawLast,       // existing: RAW vs last RAW
    sPngLast,       // existing: PNG(toBlob decoded) vs last PNG(toBlob decoded)
    sRawVsDurl,     // NEW: RAW vs toDataURL(decoded)
    sPngVsDurl,     // NEW: PNG(toBlob decoded) vs toDataURL(decoded)
    sDurlLast,      // NEW: toDataURL(decoded) vs last toDataURL(decoded)
  } = stats;

  const card = document.createElement("div"); card.className = "item";
  const title = document.createElement("div"); title.innerHTML = `<b>${name}</b>`; card.appendChild(title);

  const canvRow = document.createElement("div"); canvRow.className = "row2";
  const col1 = document.createElement("div");
  const lb1 = document.createElement("div"); lb1.className = "label"; lb1.textContent = "RAW (canvas)";
  col1.appendChild(rawCanvas); col1.appendChild(lb1);
  canvRow.appendChild(col1);
  card.appendChild(canvRow);

  // existing lines (now include A≠ via line())
  const st1 = document.createElement("div"); st1.className = "stat";
  st1.innerHTML = `RAW vs PNG (decoded) — ${line(sRawPng)}`; card.appendChild(st1);

  const st2 = document.createElement("div"); st2.className = "stat";
  st2.innerHTML = lastWhen
    ? `RAW vs Last RAW (${new Date(lastWhen).toLocaleString()}) — ${line(sRawLast)}`
    : `RAW vs Last RAW — no last session available`;
  card.appendChild(st2);

  const st3 = document.createElement("div"); st3.className = "stat";
  st3.innerHTML = lastWhen
    ? `PNG (decoded) vs Last PNG (decoded) (${new Date(lastWhen).toLocaleString()}) — ${line(sPngLast)}`
    : `PNG (decoded) vs Last PNG (decoded) — no last session available`;
  card.appendChild(st3);

  // new toDataURL pixel comparisons
  const st4 = document.createElement("div"); st4.className = "stat";
  st4.innerHTML = `RAW vs PNG toDataURL (decoded) — ${line(sRawVsDurl)}`;
  card.appendChild(st4);

  const st5 = document.createElement("div"); st5.className = "stat";
  st5.innerHTML = `PNG (decoded via toBlob) vs PNG toDataURL (decoded) — ${line(sPngVsDurl)}`;
  card.appendChild(st5);

  const st6 = document.createElement("div"); st6.className = "stat";
  st6.innerHTML = lastWhen
    ? `PNG toDataURL (decoded) vs Last PNG toDataURL (decoded) — ${line(sDurlLast)}`
    : `PNG toDataURL (decoded) vs Last PNG toDataURL (decoded) — no last session available`;
  card.appendChild(st6);

  $root.appendChild(card);
}

// ---------- main flow ----------
async function runCompare(){
  $run.disabled = true;
  try{
    clearRoot();

    // Load last session (server file)
    let last = await getLastSession().catch(() => null); // { when, rawMap, pngBlobMap, pngDURL } | null

    // 1) Render current RAW via frozen.js
    const rawMap = new Map();
    const viewMap = new Map(); // name -> raw canvas
    for (let k=0;k<TYPE_MAP_10.length;k++){
      const type = TYPE_MAP_10[k];
      const name = `S1_${type}_${k+1}`;
      const ctx = drawOne(type, name);
      rawMap.set(name, getPixelsFrom(ctx));
      viewMap.set(name, ctx.canvas);
    }

    // 2) Current PNG decoded pixels via toBlob (existing)
    const pngPixMap = new Map();
    for (const [name] of rawMap.entries()){
      const cv = viewMap.get(name);
      const pix = await roundTripPNGAndGetPixels(cv);
      pngPixMap.set(name, pix);
    }

    // 3) Current PNG toDataURL strings + decoded pixels
    const pngDURLMap = new Map();
    const durlPixMap = new Map();
    for (const [name] of rawMap.entries()){
      const cv = viewMap.get(name);
      const durl = cv.toDataURL("image/png");
      pngDURLMap.set(name, durl);
      const durlPix = await dataURLToPixels(durl, cv.width, cv.height);
      durlPixMap.set(name, durlPix);
    }

    // 4) Initialize last session on first run if missing
    last = await maybeInitLastSession(rawMap, pngPixMap, pngDURLMap, last);

    // 5) Per-image comparisons
    const perImage = {};
    const agg = {
      rawPng:  { total:0, changed:0, max:0, maxEx:0, alpha:0 },  // existing: RAW vs PNG(toBlob)
      rawLast: { total:0, changed:0, max:0, maxEx:0, alpha:0 },  // existing: RAW vs last RAW
      pngLast: { total:0, changed:0, max:0, maxEx:0, alpha:0 },  // existing: PNG(toBlob) vs last PNG(toBlob)
      rawDurl: { total:0, changed:0, max:0, maxEx:0, alpha:0 },  // NEW: RAW vs toDataURL(decoded)
      pngDurl: { total:0, changed:0, max:0, maxEx:0, alpha:0 },  // NEW: PNG(toBlob) vs toDataURL(decoded)
      durlLast:{ total:0, changed:0, max:0, maxEx:0, alpha:0 },  // NEW: toDataURL(decoded) vs last toDataURL(decoded)
    };
    const addAgg = (bucket, s) => {
      bucket.total  += s.totalPixels;
      bucket.changed+= s.changedPixels;
      bucket.max     = Math.max(bucket.max, s.maxDeviation);
      bucket.maxEx   = Math.max(bucket.maxEx, s.maxDeviationExcl255_254);
      bucket.alpha  += (s.alphaChanges || 0);
    };

    for (const [name, rawNow] of rawMap.entries()){
      const cv         = viewMap.get(name);
      const pngNow     = pngPixMap.get(name);   // decoded via toBlob
      const durlPixNow = durlPixMap.get(name);  // decoded from toDataURL

      // A) RAW current vs PNG(toBlob decoded) — existing
      const sRawPng = diffAll(rawNow, pngNow);
      console.groupCollapsed(`${name} — RAW vs PNG(toBlob decoded) — diffs: ${sRawPng.changedPixels}`); console.log(sRawPng.diffs); console.groupEnd();

      // B) RAW current vs RAW last — existing
      let sRawLast = {
        totalPixels: rawNow.length>>2, changedPixels:0, pctChanged:0,
        maxDeviation:0, maxDeviationExcl255_254:0, deviationHistogram:Array(256).fill(0),
        deviationDistribution:[], diffs:[], alphaChanges:0
      };
      if (last?.rawMap?.has(name)){
        const rawPrev = last.rawMap.get(name);
        sRawLast = diffAll(rawPrev, rawNow);
        console.groupCollapsed(`${name} — RAW vs Last RAW — diffs: ${sRawLast.changedPixels}`); console.log(sRawLast.diffs); console.groupEnd();
      } else { console.log(`${name} — RAW vs Last RAW — no previous RAW`); }

      // C) PNG(toBlob decoded) current vs PNG(toBlob decoded) last — existing
      let sPngLast = {
        totalPixels: pngNow.length>>2, changedPixels:0, pctChanged:0,
        maxDeviation:0, maxDeviationExcl255_254:0, deviationHistogram:Array(256).fill(0),
        deviationDistribution:[], diffs:[], alphaChanges:0
      };
      if (last?.pngBlobMap?.has(name)){
        const pngPrev = last.pngBlobMap.get(name);
        sPngLast = diffAll(pngPrev, pngNow);
        console.groupCollapsed(`${name} — PNG(toBlob decoded) vs Last — diffs: ${sPngLast.changedPixels}`); console.log(sPngLast.diffs); console.groupEnd();
      } else { console.log(`${name} — PNG(toBlob decoded) vs Last — no previous PNG(toBlob)`); }

      // D) NEW: RAW vs PNG(toDataURL decoded) — current
      const sRawVsDurl = diffAll(rawNow, durlPixNow);
      console.groupCollapsed(`${name} — RAW vs PNG(toDataURL decoded) — diffs: ${sRawVsDurl.changedPixels}`); console.log(sRawVsDurl.diffs); console.groupEnd();

      // E) NEW: PNG(toBlob decoded) vs PNG(toDataURL decoded) — current
      const sPngVsDurl = diffAll(pngNow, durlPixNow);
      console.groupCollapsed(`${name} — PNG(toBlob decoded) vs PNG(toDataURL decoded) — diffs: ${sPngVsDurl.changedPixels}`); console.log(sPngVsDurl.diffs); console.groupEnd();

      // F) NEW: PNG(toDataURL decoded) current vs last PNG(toDataURL decoded)
      let sDurlLast = {
        totalPixels: durlPixNow.length>>2, changedPixels:0, pctChanged:0,
        maxDeviation:0, maxDeviationExcl255_254:0, deviationHistogram:Array(256).fill(0),
        deviationDistribution:[], diffs:[], alphaChanges:0
      };
      if (last?.pngDURL?.has(name)){
        const durlPrev = last.pngDURL.get(name);
        const durlPixPrev = await dataURLToPixels(durlPrev, cv.width, cv.height);
        sDurlLast = diffAll(durlPixPrev, durlPixNow);
        console.groupCollapsed(`${name} — PNG(toDataURL decoded) vs Last — diffs: ${sDurlLast.changedPixels}`); console.log(sDurlLast.diffs); console.groupEnd();
      } else { console.log(`${name} — PNG(toDataURL decoded) vs Last — no previous toDataURL`); }

      // Aggregate buckets
      addAgg(agg.rawPng,  sRawPng);
      addAgg(agg.rawLast, sRawLast);
      addAgg(agg.pngLast, sPngLast);
      addAgg(agg.rawDurl, sRawVsDurl);
      addAgg(agg.pngDurl, sPngVsDurl);
      addAgg(agg.durlLast, sDurlLast);

      // Per-image details
      perImage[name] = {
        "raw_vs_png_toBlob_decoded": {
          totalPixels: sRawPng.totalPixels, changedPixels: sRawPng.changedPixels,
          pctChanged: (sRawPng.pctChanged*100).toFixed(2) + "%",
          maxDeviation: sRawPng.maxDeviation, maxDeviationExcl255_254: sRawPng.maxDeviationExcl255_254,
          alphaChanges: sRawPng.alphaChanges,
        },
        "raw_vs_last_raw": {
          totalPixels: sRawLast.totalPixels, changedPixels: sRawLast.changedPixels,
          pctChanged: (sRawLast.pctChanged*100).toFixed(2) + "%",
          maxDeviation: sRawLast.maxDeviation, maxDeviationExcl255_254: sRawLast.maxDeviationExcl255_254,
          alphaChanges: sRawLast.alphaChanges,
          comparedAgainst: last?.when || null,
        },
        "png_toBlob_decoded_vs_last_toBlob_decoded": {
          totalPixels: sPngLast.totalPixels, changedPixels: sPngLast.changedPixels,
          pctChanged: (sPngLast.pctChanged*100).toFixed(2) + "%",
          maxDeviation: sPngLast.maxDeviation, maxDeviationExcl255_254: sPngLast.maxDeviationExcl255_254,
          alphaChanges: sPngLast.alphaChanges,
          comparedAgainst: last?.when || null,
        },
        "raw_vs_png_toDataURL_decoded": {
          totalPixels: sRawVsDurl.totalPixels, changedPixels: sRawVsDurl.changedPixels,
          pctChanged: (sRawVsDurl.pctChanged*100).toFixed(2) + "%",
          maxDeviation: sRawVsDurl.maxDeviation, maxDeviationExcl255_254: sRawVsDurl.maxDeviationExcl255_254,
          alphaChanges: sRawVsDurl.alphaChanges,
        },
        "png_toBlob_decoded_vs_png_toDataURL_decoded": {
          totalPixels: sPngVsDurl.totalPixels, changedPixels: sPngVsDurl.changedPixels,
          pctChanged: (sPngVsDurl.pctChanged*100).toFixed(2) + "%",
          maxDeviation: sPngVsDurl.maxDeviation, maxDeviationExcl255_254: sPngVsDurl.maxDeviationExcl255_254,
          alphaChanges: sPngVsDurl.alphaChanges,
        },
        "png_toDataURL_decoded_vs_last_png_toDataURL_decoded": {
          totalPixels: sDurlLast.totalPixels, changedPixels: sDurlLast.changedPixels,
          pctChanged: (sDurlLast.pctChanged*100).toFixed(2) + "%",
          maxDeviation: sDurlLast.maxDeviation, maxDeviationExcl255_254: sDurlLast.maxDeviationExcl255_254,
          alphaChanges: sDurlLast.alphaChanges,
          comparedAgainst: last?.when || null,
        },
      };

      // Card
      addItemCard(
        name,
        viewMap.get(name).cloneNode(true),
        { sRawPng, sRawLast, sPngLast, sRawVsDurl, sPngVsDurl, sDurlLast },
        last?.when || null
      );
    }

    // 6) Summary — include Max, Max excl, and A≠ for ALL buckets
    const pct = (b)=> b.total ? ((b.changed/b.total)*100).toFixed(2) : "0.00";
    show(
      `Compared at <b>${nowStr()}</b>.<br/>
       RAW vs PNG(toBlob) — Overall: <b>${agg.rawPng.changed}</b> / ${agg.rawPng.total} (${pct(agg.rawPng)}%) · Max <b>${agg.rawPng.max}</b> · Max excl 255 & 254 <b>${agg.rawPng.maxEx}</b> · A≠ <b>${agg.rawPng.alpha}</b>.<br/>
       RAW vs Last RAW ${last?.when ? `(prev ${new Date(last.when).toLocaleString()})` : `(no prev)`} — Overall: <b>${agg.rawLast.changed}</b> / ${agg.rawLast.total} (${pct(agg.rawLast)}%) · Max <b>${agg.rawLast.max}</b> · Max excl 255 & 254 <b>${agg.rawLast.maxEx}</b> · A≠ <b>${agg.rawLast.alpha}</b>.<br/>
       PNG(toBlob) vs Last PNG(toBlob) ${last?.when ? `(prev ${new Date(last.when).toLocaleString()})` : `(no prev)`} — Overall: <b>${agg.pngLast.changed}</b> / ${agg.pngLast.total} (${pct(agg.pngLast)}%) · Max <b>${agg.pngLast.max}</b> · Max excl 255 & 254 <b>${agg.pngLast.maxEx}</b> · A≠ <b>${agg.pngLast.alpha}</b>.<br/>
       RAW vs PNG(toDataURL) — Overall: <b>${agg.rawDurl.changed}</b> / ${agg.rawDurl.total} (${pct(agg.rawDurl)}%) · Max <b>${agg.rawDurl.max}</b> · Max excl 255 & 254 <b>${agg.rawDurl.maxEx}</b> · A≠ <b>${agg.rawDurl.alpha}</b>.<br/>
       PNG(toBlob) vs PNG(toDataURL) — Overall: <b>${agg.pngDurl.changed}</b> / ${agg.pngDurl.total} (${pct(agg.pngDurl)}%) · Max <b>${agg.pngDurl.max}</b> · Max excl 255 & 254 <b>${agg.pngDurl.maxEx}</b> · A≠ <b>${agg.pngDurl.alpha}</b>.<br/>
       PNG(toDataURL) vs Last PNG(toDataURL) ${last?.when ? `(prev ${new Date(last.when).toLocaleString()})` : `(no prev)`} — Overall: <b>${agg.durlLast.changed}</b> / ${agg.durlLast.total} (${pct(agg.durlLast)}%) · Max <b>${agg.durlLast.max}</b> · Max excl 255 & 254 <b>${agg.durlLast.maxEx}</b> · A≠ <b>${agg.durlLast.alpha}</b>.`,
      perImage
    );

    // Keep current in memory (we DO NOT overwrite server here)
    CURRENT_RAW_MAP  = rawMap;
    CURRENT_PNG_PIX  = pngPixMap;
    CURRENT_PNG_DURL = pngDURLMap;
    CURRENT_DURL_PIX = durlPixMap;

  } catch (e){
    console.error(e);
    show("Error during compare. See console.", { error: String(e) });
  } finally { $run.disabled = false; }
}

// ---------- Replace last-session files ONLY when the button is clicked ----------
async function handleClearAndReplace(){
  try{
    if (!CURRENT_RAW_MAP || !CURRENT_PNG_PIX || !CURRENT_PNG_DURL){
      await runCompare(); // ensure maps are populated
    }
    const savedAt = await putLastSession(CURRENT_RAW_MAP, CURRENT_PNG_PIX, CURRENT_PNG_DURL);
    alert(`Last session files replaced with current session at ${new Date(savedAt).toLocaleString()}.`);
  } catch (e){
    console.error(e);
    alert("Failed to replace last session files. See console.");
  }
}

// ---- bind ----
if (!$run.__bound){ $run.addEventListener("click", runCompare); $run.__bound = true; }
if ($clr && !$clr.__bound){ $clr.addEventListener("click", handleClearAndReplace); $clr.__bound = true; }
