// Headless page driver for scripts/validate_td.py (docs/VALIDATION.md, option 1).
//
// Drives the REAL web page (the master's URL with token + editor id) in Playwright Chromium, from web/node_modules, so the page
// talks to TouchDesigner's server exactly like a user's browser. Protocol: one JSON object per line on stdin, one reply per line
// on stdout, in order:   -> {"id": 1, "cmd": "eval", ...}      <- {"id": 1, "ok": true, "result": ...} | {"id": 1, "ok": false, "error": "..."}
//
// Commands (page coordinates are CSS px, origin top-left):
//   goto {url}                       reload {}                       viewport {w, h}
//   eval {expr}                      -> JSON of the expression (promises awaited; undefined -> null)
//   exec {code}                      run statements (a function body); no result
//   mouse {op: move|down|up|click|dblclick|wheel, x, y, button?, dx?, dy?}
//   path {points: [[x, y], ...], delay?}   press at the first point, move through the others (delay ms between), release at the last
//   key {key}                        press, e.g. "b", "Meta+z", "Escape"      keydown/keyup {key}      type {text, delay?}
//   wait {selector? | fn?, timeout?}  wait for a CSS selector / a JS expression to be truthy
//   screenshot {path? | clip? | raw?}  -> {png: base64} | {path} | (raw) {w, h, rgba: base64 straight RGBA}
//   console {}                       -> buffered page console / page errors since the last call
//   url {}                           -> current URL        close {}
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', 'web', 'package.json'));
const { chromium } = require('playwright-core');

const viewport = { width: Number(process.env.PAGE_W || 1280), height: Number(process.env.PAGE_H || 800) };
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
const page = await context.newPage();
const logs = [];
page.on('console', (m) => { if (logs.length < 500) logs.push(`[${m.type()}] ${m.text()}`.slice(0, 400)); });
page.on('pageerror', (e) => { if (logs.length < 500) logs.push(`[pageerror] ${String(e)}`.slice(0, 400)); });


// 8-bit RGB/RGBA non-interlaced PNG -> {w, h, rgba: Buffer}
function decodePng(png) {
  let pos = 8, w = 0, h = 0, ch = 4; const idat = [];
  while (pos < png.length) {
    const n = png.readUInt32BE(pos), kind = png.toString('latin1', pos + 4, pos + 8);
    if (kind === 'IHDR') { w = png.readUInt32BE(pos + 8); h = png.readUInt32BE(pos + 12); ch = png[pos + 17] === 6 ? 4 : 3; }
    else if (kind === 'IDAT') idat.push(png.subarray(pos + 8, pos + 8 + n));
    pos += 12 + n;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch, out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? out[dst + i - ch] : 0, b = y ? out[up + i] : 0, c = y && i >= ch ? out[up + i - ch] : 0;
      let p = 0;
      if (f === 1) p = a; else if (f === 2) p = b; else if (f === 3) p = (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[dst + i] = (raw[src + i] + p) & 255;
    }
  }
  if (ch === 4) return { w, h, rgba: out };
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = out[i * 3]; rgba[i * 4 + 1] = out[i * 3 + 1]; rgba[i * 4 + 2] = out[i * 3 + 2]; rgba[i * 4 + 3] = 255; }
  return { w, h, rgba };
}
const handlers = {
  async goto({ url, ms }) { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: ms || 30000 }); return page.url(); },
  async reload() { await page.reload({ waitUntil: 'domcontentloaded' }); return page.url(); },
  async viewport({ w, h }) { await page.setViewportSize({ width: w, height: h }); return true; },
  async url() { return page.url(); },
  async eval({ expr }) {
    const wrapped = `(async()=>{var __v=await (${expr}); return JSON.stringify(__v === undefined ? null : __v);})()`;
    const s = await page.evaluate(wrapped);
    return s === undefined ? null : JSON.parse(s);
  },
  async exec({ code }) {   // statements (a function body), result ignored: what Web Render's executeJavaScript did
    await page.evaluate(`(function(){${code}\n})()`);
    return true;
  },
  async mouse({ op, x, y, button, dx, dy }) {
    const b = button || 'left';
    if (x !== undefined && op !== 'wheel') await page.mouse.move(x, y);
    if (op === 'down') await page.mouse.down({ button: b });
    else if (op === 'up') await page.mouse.up({ button: b });
    else if (op === 'click') await page.mouse.click(x, y, { button: b });
    else if (op === 'dblclick') await page.mouse.dblclick(x, y, { button: b });
    else if (op === 'wheel') { if (x !== undefined) await page.mouse.move(x, y); await page.mouse.wheel(dx || 0, dy || 0); }
    return true;
  },
  async path({ points, delay }) {
    const [x0, y0] = points[0];
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (const [x, y] of points.slice(1)) {
      await page.mouse.move(x, y);
      if (delay) await new Promise((r) => setTimeout(r, delay));
    }
    await page.mouse.up();
    return true;
  },
  async key({ key }) { await page.keyboard.press(key); return true; },
  async keydown({ key }) { await page.keyboard.down(key); return true; },
  async keyup({ key }) { await page.keyboard.up(key); return true; },
  async type({ text, delay }) { await page.keyboard.type(text, { delay: delay || 0 }); return true; },
  async wait({ selector, fn, ms }) {
    const t = ms || 10000;
    try {
      if (selector) await page.waitForSelector(selector, { timeout: t });
      else if (fn) await page.waitForFunction(fn, null, { timeout: t });
      return true;
    } catch { return false; }
  },
  async screenshot({ path: p, clip, raw }) {
    const buf = await page.screenshot({ type: 'png', clip: clip ? { x: clip[0], y: clip[1], width: clip[2], height: clip[3] } : undefined, path: p });
    if (raw) { const d = decodePng(buf); return { w: d.w, h: d.h, rgba: d.rgba.toString('base64') }; }
    return p ? { path: p } : { png: buf.toString('base64') };
  },
  async console() { const l = logs.splice(0, logs.length); return l; },
  async close() { await browser.close(); setTimeout(() => process.exit(0), 10); return true; },
};

const rl = readline.createInterface({ input: process.stdin });
let chain = Promise.resolve();
rl.on('line', (line) => {
  chain = chain.then(async () => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    let reply;
    try {
      const h = handlers[msg.cmd];
      if (!h) throw new Error(`unknown cmd ${msg.cmd}`);
      reply = { id: msg.id, ok: true, result: await h(msg) };
    } catch (e) {
      reply = { id: msg.id, ok: false, error: String(e && e.message || e).slice(0, 2000) };
    }
    process.stdout.write(JSON.stringify(reply) + '\n');
  });
});
// stdin closed: let the queued command finish (at most 5 s), then close the browser (at most 5 s) and exit whatever happens
const timeout = (ms) => new Promise((r) => setTimeout(r, ms));
rl.on('close', async () => {
  await Promise.race([chain, timeout(5000)]);
  await Promise.race([browser.close().catch(() => {}), timeout(5000)]);
  process.exit(0);
});
process.stdout.write(JSON.stringify({ id: 0, ok: true, result: 'ready' }) + '\n');
