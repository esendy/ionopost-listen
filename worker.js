// worker.js — turns a timestamped audio stream into 15 s JS8 slots and decodes them.
//
// The page hands over raw audio at the AudioContext's rate, each chunk stamped with the wall-clock
// time of its first sample. This worker resamples to 6 kHz (webrx.c), keeps ~45 s in a ring, and
// as soon as a whole UTC slot (:00 :15 :30 :45, plus the clock offset) is in the ring, decodes it.
//
// ⚠ The audio clock and the wall clock drift apart (tens of ppm), so the mapping from a 6 kHz
//   sample index to UTC is re-estimated from every chunk's stamp, smoothed, and snapped when it
//   jumps — a jump means the stream stopped (screen lock, route change) and the ring is stale.
/* global WebRX */
importScripts("webrx.js");

const RATE6 = 6000, SLOT_MS = 15000, SLOT_N = 90000;
const RING = RATE6 * 45;
const CHUNK_MAX = 8192;

let M = null;                 // the WebAssembly module
let inPtr = 0, outPtr = 0;    // staging buffers inside the module's heap
let ready = false;
let inRate = 0;               // AudioContext rate
let offsetMs = 0;             // added to every slot boundary (positive: slots start later)

// stream state
let ring = new Float32Array(RING);
let K = 0;                    // 6 kHz samples produced since the stream (re)started
let I = 0;                    // input samples consumed since the stream (re)started
let base = null;              // estimated UTC ms of 6 kHz sample 0
let nextFrame = null;         // AudioContext frame we expect next
let nextSlot = null;          // UTC slot index (ms / 15000) to decode next

function post(type, body) { self.postMessage(Object.assign({ type }, body || {})); }

async function boot(band) {
  // print/printErr dropped: ft8_lib logs its buffer sizes to stderr on every slot.
  M = await WebRX({ locateFile: (p) => p, print: () => {}, printErr: () => {} });
  const res = await fetch("words.txt");
  if (!res.ok) throw new Error("words.txt: HTTP " + res.status);
  M.FS.writeFile("/words.txt", new Uint8Array(await res.arrayBuffer()));
  const words = M.ccall("wrx_dict_open", "number", ["string"], ["/words.txt"]);
  inPtr = M._malloc(CHUNK_MAX * 4);
  outPtr = M._malloc(CHUNK_MAX * 4);
  configure(band);
  M._wrx_reset();
  ready = true;
  post("ready", { words });
}

function configure(band) {
  if (band === "device") M._wrx_config(500, 1850, 2);   // the Cardputer's window
  else M._wrx_config(200, 2900, 2);                     // the whole passband
}

function restart(epoch) {
  M._wrx_resample_init(inRate);
  K = 0; I = 0; base = epoch; nextSlot = null;
}

function heapF32() { return new Float32Array(M.HEAPF32.buffer); }   // fresh view: memory can grow

function push(frame, epoch, data) {
  // A gap in frames, or a stamp far from where the clock mapping says this chunk belongs,
  // means the stream was interrupted. Start over rather than decode a slot with a hole in it.
  const predicted = base === null ? null : base + (I / inRate) * 1000;
  if (nextFrame === null || frame !== nextFrame || Math.abs(epoch - predicted) > 400) {
    if (nextFrame !== null) post("gap", { ms: predicted === null ? 0 : Math.round(epoch - predicted) });
    restart(epoch);
  } else {
    base += 0.02 * ((epoch - (I / inRate) * 1000) - base);   // slow follow of clock drift
  }
  nextFrame = frame + data.length;

  for (let off = 0; off < data.length; off += CHUNK_MAX) {
    const part = data.subarray(off, Math.min(off + CHUNK_MAX, data.length));
    heapF32().set(part, inPtr >> 2);
    const n = M._wrx_resample(inPtr, part.length, outPtr, CHUNK_MAX);
    if (n < 0) { restart(epoch); return; }
    const out = heapF32().subarray(outPtr >> 2, (outPtr >> 2) + n);
    for (let i = 0; i < n; i++) ring[(K + i) % RING] = out[i];
    K += n;
    I += part.length;
  }
  decodeReady();
}

function decodeReady() {
  const haveFrom = base, haveTo = base + (K / RATE6) * 1000;
  if (nextSlot === null) nextSlot = Math.ceil((haveFrom - offsetMs) / SLOT_MS);
  for (;;) {
    const start = nextSlot * SLOT_MS + offsetMs;
    if (start + SLOT_MS > haveTo) return;                 // not all here yet
    const ks = Math.round(((start - base) / 1000) * RATE6);
    if (ks < 0 || ks < K - RING) { nextSlot++; continue; } // fell out of the ring: skip it
    const buf = heapF32();
    const dst = M._wrx_slot_buffer() >> 2;
    for (let i = 0; i < SLOT_N; i++) buf[dst + i] = ring[(ks + i) % RING];
    const t0 = performance.now();
    const json = M.UTF8ToString(M._wrx_decode(SLOT_N, nextSlot));
    post("slot", { slot: nextSlot, ms: Math.round(performance.now() - t0), result: JSON.parse(json) });
    nextSlot++;
  }
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      inRate = m.rate; offsetMs = m.offsetMs || 0;
      if (!ready) await boot(m.band); else { configure(m.band); post("ready", {}); }
      nextFrame = null; base = null;
    } else if (m.type === "audio" && ready) {
      push(m.frame, m.epoch, m.data);
    } else if (m.type === "config" && ready) {
      if (m.band) configure(m.band);
      if (typeof m.offsetMs === "number") offsetMs = m.offsetMs;   // takes effect from the next slot
    } else if (m.type === "stop") {
      nextFrame = null; base = null;
    }
  } catch (err) {
    post("error", { message: String(err && err.message || err) });
  }
};
