// frozen.js — draw exactly 10 canvases for a single subsession, no watermark at all
// OPAQUE MODE: ctx is created with { alpha:false } and we flatten around draws.

function clearOpaque(ctx){
  const {width:w, height:h} = ctx.canvas;
  ctx.save();
  ctx.globalCompositeOperation = "copy";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}


const CANVAS_WIDTH = 100, CANVAS_HEIGHT = 100;
const __root = ensureRoot();

function ensureRoot(){
  let r = document.getElementById("canvas-root");
  if(!r){
    r = document.createElement("div");
    r.id = "canvas-root";
    r.style.display = "flex";
    r.style.flexWrap = "wrap";
    r.style.gap = "8px";
    r.style.maxWidth = "1080px";
    document.body.appendChild(r);
  }
  return r;
}

function createCanvas(name){
  const box = document.createElement("div"); box.className = "pp-canvas-item";
  const cv  = document.createElement("canvas"); cv.width = CANVAS_WIDTH; cv.height = CANVAS_HEIGHT;
  const lb  = document.createElement("div"); lb.className = "pp-label"; lb.textContent = String(name);
  box.appendChild(cv); box.appendChild(lb); __root.appendChild(box);

  // IMPORTANT: alpha:false creates an opaque drawing buffer
  const ctx = cv.getContext("2d", { willReadFrequently: true, alpha: false });

  // Pre-flatten to an opaque background using copy (ensures A=255 everywhere)
  ctx.save();
  ctx.globalCompositeOperation = "copy";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.restore();

  return ctx;
}

// Finalize: guarantee opacity even if renderers used semi-transparent paints
function finalizeOpaque(ctx){
  const { width:w, height:h } = ctx.canvas;
  ctx.save();
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

// very lightweight seeded pseudo-random
function rng(seed = 1){
  let s = seed | 0;
  return () => ((s = (s * 1664525 + 1013904223) | 0) >>> 0) / 4294967296;
}

// --------- renderers (no watermark writes) ----------
export function drawEmoji(category, name){
  const ctx = createCanvas(name);
  clearOpaque(ctx)
  const gridSize = 6, cell = CANVAS_WIDTH / gridSize;
  const emjs = {
    faces:  ["😀","😃","😄","😁","😆","😅","🙂","🙃","😉","😊","😇","🥲","🤪","😵","😎","🤠","😔","😬","😧","🙄","🫠","🫤"],
    persons:["👩","👨","🧑","👧","👦","👮","🧑‍🎄","🧞","🧛","🤺","🧘","👯","🧑‍🏫","🦸","🧑‍🔧","👩‍💼"],
    travel: ["🏰","🏙","🌋","⛰","🌉","🚇","🚕","🎿","⏱","✂","📦","💡","🥁","🧻"],
    flags:  ["🇺🇸","🇯🇵","🇩🇪","🇫🇷","🇬🇧","🇮🇳","🇰🇭","🇵🇭","🇿🇦","🇰🇷","🇨🇦","🇧🇷"],
    hands:  ["👍","👎","👌","✊","🤚","🖐","👏","🙌","🫶","🤌","👉","👊"]
  }[category] || ["•"];
  const random = rng(name.length);
  let idx = 0;

  // Use fully opaque fill to avoid introducing semi-transparent edges
  ctx.fillStyle = "#141414";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  for (let r = 0; r < gridSize; r++){
    for (let c = 0; c < gridSize; c++){
      const ch = emjs[idx % emjs.length]; idx++;
      const size = Math.floor(cell * (0.55 + 0.25 * random()));
      ctx.font = `${size}px Arial`;
      const x = c * cell + 2 + random() * 4;
      const y = r * cell + size + random() * 2 - 1;
      ctx.fillText(ch, x, y);
    }
  }

  finalizeOpaque(ctx);
  return ctx;
}

export function randomFont(name){
  const ctx = createCanvas(name);
  clearOpaque(ctx)
  const lines = [
    { font:"Menlo",           size:11, y:15,  text:"∀ ∑ λ Ω € ₿" },
    { font:"Georgia",         size:12, y:30,  text:"ß ψ ≠ ≈ ± ∞" },
    { font:"Arial",           size:11, y:46,  text:"$ £ ¢ ₽ 1 2 3 4 5" },
    { font:"Helvetica",       size:10, y:64,  text:"→ ⇑ ⇓ ◎ ○ ◉ ▲ ▼" },
    { font:"Courier New",     size:11, y:79,  text:"{ } [ ] ( ) < >" },
    { font:"Times New Roman", size:12, y:95,  text:"é ñ ü å ø æ" },
  ];
  ctx.fillStyle = "#141414"; // opaque text color
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  for (const L of lines){
    ctx.font = `${L.size}px ${L.font}`;
    ctx.fillText(L.text, 6, L.y);
  }
  finalizeOpaque(ctx);
  return ctx;
}

export function drawMoirePatternWatermarked(name = "moire"){
  const ctx = createCanvas(name);
  const { width:w, height:h } = ctx.canvas;
  clearOpaque(ctx)
  ctx.globalCompositeOperation = "source-over";
  ctx.strokeStyle = "#000000";  // opaque
  ctx.lineWidth = 1;
  for (let y = 0; y < h; y += 4){ ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  ctx.strokeStyle = "#555555";   // opaque mid-gray
  for (let x = 0; x < w; x += 5){ ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  finalizeOpaque(ctx);
  return ctx;
}

export function gradQuantSteps(name = "gradQuantSteps"){
  const ctx = createCanvas(name);
  const { width:w, height:h } = ctx.canvas;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0,   "#000000");
  g.addColorStop(0.6, "#777777");
  g.addColorStop(1,   "#ffffff");
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  finalizeOpaque(ctx);
  return ctx;
}

export function shadowBlurProbe(name = "shadowBlurProbe"){
  const ctx = createCanvas(name);
  const { width:w, height:h } = ctx.canvas;
  clearOpaque(ctx)
  const random = rng(name.length);
  for (let i = 0; i < 6; i++){
    ctx.save();
    // Opaque shadow color; alpha:false still blends, but final buffer stays opaque
    ctx.shadowColor = "#000000";
    ctx.shadowBlur  = 2 + 16 * random();
    ctx.fillStyle   = "#000000";
    const x = 10 + random() * (w - 20);
    const y = 10 + random() * (h - 20);
    const s = 6  + random() * 24;
    const shape = random() < 0.33 ? "circle" : (random() < 0.5 ? "rect" : "diamond");
    ctx.beginPath();
    if (shape === "circle"){ ctx.arc(x, y, s, 0, Math.PI * 2); }
    else if (shape === "rect"){ ctx.rect(x - s, y - s, s * 2, s * 2); }
    else { ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y); ctx.closePath(); }
    ctx.fill();
    ctx.restore();
  }
  finalizeOpaque(ctx);
  return ctx;
}

export function arandomString(name = "a-randomString"){
  const ctx = createCanvas(name);
  clearOpaque(ctx);
  ctx.fillStyle = "#6135DC";   // opaque instead of rgba(97,53,220,0.65)
  ctx.font = "12px monospace";
  const random = rng(12345);
  for (let i = 0; i < 5; i++){
    const y = 16 + i * 18;
    const line = Array.from({ length: 18 }, () => String.fromCharCode(0x2500 + Math.floor(random() * 60))).join('');
    ctx.fillText(line, 4, y);
  }
  finalizeOpaque(ctx);
  return ctx;
}

// convenience for index_fixed.js
export const TYPE_MAP_10 = [
  "faces","persons","travel","flags","hands",
  "randomFont","moire","a-randomString","gradQuantSteps","shadowBlurProbe",
];

export function drawOne(type, name){
  switch (type){
    case "faces":
    case "persons":
    case "travel":
    case "flags":
    case "hands":
      return drawEmoji(type, name);
    case "randomFont":      return randomFont(name);
    case "moire":           return drawMoirePatternWatermarked(name);
    case "a-randomString":  return arandomString(name);
    case "gradQuantSteps":  return gradQuantSteps(name);
    case "shadowBlurProbe": return shadowBlurProbe(name);
    default: return null;
  }
}
