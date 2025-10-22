// server.js — static site from ./public + /baseline + flexible /last-session + /history
import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { constants as FS_CONST } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 80;

// ---- paths
const PUBLIC_DIR        = path.join(__dirname, 'public');
const BASELINE_FILE     = path.join(__dirname, 'baseline.json');
const LAST_SESSION_FILE = path.join(__dirname, 'last_session_v2.json');
const HISTORY_FILE      = path.join(__dirname, 'history.json');

// ---- middleware
app.use(express.json({ limit: '200mb' }));
app.use(express.static(PUBLIC_DIR, {
  etag: true,
  lastModified: true,
  setHeaders(res){ res.setHeader('Cache-Control', 'no-store'); }
}));

// optional: / -> public/index.html (if present)
app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// simple health check (non-breaking addition)
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ---- helpers
async function exists(p){ try { await fs.access(p, FS_CONST.F_OK); return true; } catch { return false; } }
async function readJson(p){
  try {
    const s = await fs.readFile(p, 'utf8');
    return JSON.parse(s);
  } catch (e) {
    console.error(`[readJson] ${p} error:`, e);
    throw e;
  }
}
async function writeJsonAtomic(p, obj){
  const tmp = p + '.tmp-' + Date.now();
  await fs.writeFile(tmp, JSON.stringify(obj), 'utf8');
  await fs.rename(tmp, p);
}
function isPlainObject(v){ return v && typeof v === 'object' && !Array.isArray(v); }

// ================= BASELINE =================
app.get('/baseline', async (_req, res) => {
  if (!(await exists(BASELINE_FILE))) return res.status(404).json({ error: 'no baseline' });
  res.json(await readJson(BASELINE_FILE));
});
app.put('/baseline', async (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object' || !incoming.pixels)
    return res.status(400).json({ error: 'invalid payload: require {pixels:{}, meta{}}' });
  await writeJsonAtomic(BASELINE_FILE, incoming);
  res.json({ ok: true });
});
app.delete('/baseline', async (_req, res) => {
  try { await fs.unlink(BASELINE_FILE); } catch {}
  res.json({ ok: true });
});

// =============== LAST SESSION (disk-backed, flexible schema) ===============
/*
Accepted PUT payloads (any of these):
  1) Legacy:
     { raw: {name: base64_pixels}, png: {name: base64_pixels}, meta? }
  2) New (recommended):
     { raw: {name: base64_pixels}, png_blob: {name: base64_pixels}, png_durl: {name: dataURL}, meta? }
*/
app.get('/last-session', async (_req, res) => {
  try {
    if (!(await exists(LAST_SESSION_FILE))) return res.status(404).json({ error: 'no last session' });
    const data = await readJson(LAST_SESSION_FILE);

    // Back-compat shim: if old file has "png" but no "png_blob", promote it
    if (isPlainObject(data.png) && !isPlainObject(data.png_blob)) {
      data.png_blob = data.png;
    }

    const ok =
      (isPlainObject(data.raw) || isPlainObject(data.png_blob) || isPlainObject(data.png_durl)) &&
      isPlainObject(data.meta);

    if (!ok) return res.status(500).json({ error: 'corrupted last-session file' });
    res.json(data);
  } catch (e) {
    console.error('[GET /last-session] error:', e);
    res.status(500).json({ error: 'failed to read last-session' });
  }
});

app.put('/last-session', async (req, res) => {
  try {
    const body = req.body || {};

    // Accept both old and new keys
    const raw       = isPlainObject(body.raw)       ? body.raw       : undefined;
    const png_blob  = isPlainObject(body.png_blob)  ? body.png_blob  : (isPlainObject(body.png) ? body.png : undefined);
    const png_durl  = isPlainObject(body.png_durl)  ? body.png_durl  : undefined;

    if (!raw && !png_blob && !png_durl) {
      return res.status(400).json({
        error: 'invalid payload: provide at least one of {raw, png/blob pixels, png_durl dataURLs}'
      });
    }

    const meta = isPlainObject(body.meta) ? body.meta : {};
    const savedAt = meta.savedAt || new Date().toISOString();

    const payload = {
      ...(raw      ? { raw }      : {}),
      ...(png_blob ? { png_blob } : {}),
      ...(png_durl ? { png_durl } : {}),
      meta: { savedAt }
    };

    await writeJsonAtomic(LAST_SESSION_FILE, payload);
    res.json({ ok: true, savedAt });
  } catch (e) {
    console.error('[PUT /last-session] error:', e);
    res.status(500).json({ error: 'failed to save last-session' });
  }
});

// ================= HISTORY (disk-backed, canvas diff history) =================
/*
Schema:
{
  runs: number,
  byImage: {
    [imageName]: {
      perRunChanged: number[],
      everChanged: number[],                 // list of pixel indices that changed at least once
      perPixel: {                            // pixelIndex -> stats
        [pixelIndex]: { n: number, patterns: { [ "dr,dg,db,da" ]: number } }
      }
    }
  }
}

Client options:
  A) GET /history → merge locally → PUT /history  (recommended, minimal API)
  B) PUT /history/append  { images: { [name]: { changedMap: { [pix]: [dr,dg,db,da] } } } }  (optional convenience)
  C) POST /history/put    same as PUT /history   (optional fallback if proxies block PUT)
*/
function emptyHistory(){ return { runs: 0, byImage: {} }; }
function normalizeHistory(h){
  if (!isPlainObject(h)) return emptyHistory();
  const out = { runs: Number(h.runs) || 0, byImage: {} };
  const src = isPlainObject(h.byImage) ? h.byImage : {};
  for (const [name, rec] of Object.entries(src)) {
    const perRunChanged = Array.isArray(rec?.perRunChanged) ? rec.perRunChanged.map(x => Number(x)||0) : [];
    const everChanged   = Array.isArray(rec?.everChanged)   ? rec.everChanged.map(x => Number(x)||0)   : [];
    const perPixelIn    = isPlainObject(rec?.perPixel) ? rec.perPixel : {};
    const perPixelOut   = {};
    for (const [pix, slot] of Object.entries(perPixelIn)) {
      const n = Number(slot?.n)||0;
      const patternsIn = isPlainObject(slot?.patterns) ? slot.patterns : {};
      const patternsOut = {};
      for (const [k,v] of Object.entries(patternsIn)) patternsOut[String(k)] = Number(v)||0;
      perPixelOut[pix] = { n, patterns: patternsOut };
    }
    out.byImage[name] = { perRunChanged, everChanged, perPixel: perPixelOut };
  }
  return out;
}
async function readHistory(){
  if (!(await exists(HISTORY_FILE))) return emptyHistory();
  return normalizeHistory(await readJson(HISTORY_FILE));
}
async function writeHistory(h){
  await writeJsonAtomic(HISTORY_FILE, normalizeHistory(h));
}

app.get('/history', async (_req, res) => {
  try {
    const h = await readHistory();
    res.json(h);
  } catch (e) {
    console.error('[GET /history] error:', e);
    res.status(500).json({ error: 'failed to read history' });
  }
});

app.put('/history', async (req, res) => {
  try {
    const body = normalizeHistory(req.body);
    await writeHistory(body);
    res.json({ ok: true });
  } catch (e) {
    console.error('[PUT /history] error:', e);
    res.status(500).json({ error: 'failed to write history' });
  }
});

// optional convenience: server-side append-merge
app.put('/history/append', async (req, res) => {
  try {
    const images = isPlainObject(req.body?.images) ? req.body.images : null;
    if (!images) return res.status(400).json({ error: 'invalid payload: expected { images: { [name]: { changedMap } } }' });

    const hist = await readHistory();
    hist.runs = (hist.runs || 0) + 1;
    hist.byImage = hist.byImage || {};

    for (const [name, recIn] of Object.entries(images)) {
      const changedMap = isPlainObject(recIn?.changedMap) ? recIn.changedMap : {};
      let rec = hist.byImage[name];
      if (!rec) rec = hist.byImage[name] = { perRunChanged: [], everChanged: [], perPixel: {} };

      const changedCount = Object.keys(changedMap).length;
      rec.perRunChanged.push(changedCount);

      // everChanged as set
      const evSet = new Set(rec.everChanged);
      for (const pix of Object.keys(changedMap)) evSet.add(Number(pix));
      rec.everChanged = Array.from(evSet);

      // perPixel stats
      for (const [pixStr, delta] of Object.entries(changedMap)) {
        const pix = Number(pixStr);
        const key = Array.isArray(delta) ? delta.join(',') : String(delta);
        if (!rec.perPixel[pix]) rec.perPixel[pix] = { n: 0, patterns: {} };
        rec.perPixel[pix].n += 1;
        rec.perPixel[pix].patterns[key] = (rec.perPixel[pix].patterns[key] || 0) + 1;
      }
    }

    await writeHistory(hist);
    res.json(hist);
  } catch (e) {
    console.error('[PUT /history/append] error:', e);
    res.status(500).json({ error: 'failed to append history' });
  }
});

// optional fallback if a proxy blocks PUT (non-breaking addition)
app.post('/history/put', async (req, res) => {
  try {
    const body = normalizeHistory(req.body);
    await writeHistory(body);
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /history/put] error:', e);
    res.status(500).json({ error: 'failed to write history via POST' });
  }
});

app.delete('/history', async (_req, res) => {
  try {
    if (await exists(HISTORY_FILE)) await fs.unlink(HISTORY_FILE);
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /history] error:', e);
    res.status(500).json({ error: 'failed to delete history' });
  }
});

// ---- start
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server on http://0.0.0.0:${PORT}`);
  console.log(`Static dir: ${PUBLIC_DIR}`);
  console.log(`Try: http://localhost:${PORT}/compare_png.html`);
});
