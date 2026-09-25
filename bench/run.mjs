// Automated matrix runner. Drives the page in a real (headed) Chrome so the GPU path is
// the one users get; headless Chrome falls back to SwiftShader and skews GPU-bound numbers.
//
//   npm run bench            full grid  (~30 min)
//   npm run bench:quick      small grid (~7 min)
//   node bench/run.mjs --engines deckgl,maplibre-setdata --n 20000 --interval 10 --modes icons --pans 0,1
//
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { platform } from 'node:os';
import puppeteer from 'puppeteer-core';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const list = (s, map = String) => s.split(',').map((x) => map(x.trim()));

const URL = args.url || 'http://localhost:5173';
const duration = +(args.duration || 10);
const warmup = +(args.warmup || 3);
const quick = args.quick === 'true';

const grid = {
  engines: args.engines ? list(args.engines) : ['maplibre-setdata', 'maplibre-updatedata', 'deckgl'],
  n: args.n ? list(args.n, Number) : quick ? [5000, 20000] : [2000, 10000, 30000],
  interval: args.interval ? list(args.interval, Number) : quick ? [20] : [50, 20, 10],
  modes: args.modes ? list(args.modes) : ['circles', 'icons'],
  pans: args.pans ? list(args.pans) : ['0', '1'],
  basemap: args.basemap || 'liberty',
  changeRatio: args.changeRatio || '1',
  interleaved: args.interleaved || '0',
};

const configs = [];
for (const mode of grid.modes)
  for (const n of grid.n)
    for (const interval of grid.interval)
      for (const pan of grid.pans)
        for (const engine of grid.engines) configs.push({ engine, n, interval, mode, pan });

function chromePath() {
  if (args.chrome) return args.chrome;
  const p = platform();
  const candidates =
    p === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : p === 'win32'
        ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error('Chrome not found, pass --chrome=/path/to/chrome');
  return found;
}

async function ensureServer() {
  try {
    await fetch(URL);
    return null;
  } catch {
    console.log('starting vite dev server…');
    const child = spawn('npx', ['vite', '--port', new globalThis.URL(URL).port || '5173', '--strictPort'], { stdio: 'ignore', detached: false });
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 300));
      try { await fetch(URL); return child; } catch {}
    }
    child.kill();
    throw new Error('vite did not start');
  }
}

const fmt = (v) => (v === null || v === undefined ? '-' : typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(1)) : v);

function toMarkdown(results) {
  const head = ['mode', 'n', 'upd ms', 'cam', 'engine', 'fps', 'p95 frame', 'slow fr', 'feed ms', 'busy %', 'ticks run/req', 'drawn upd/s', 'fresh p95 ms', 'long tasks'];
  const rows = results.map((r) =>
    r.error
      ? [r.mode, r.n, r.interval, r.pan ? 'pan' : 'fix', r.engine, `ERROR: ${r.error}`]
      : [r.mode, r.n, r.interval, r.pan ? 'pan' : 'fix', r.engine, r.fps, r.frameP95, r.slowFrames, r.feedAvgMs, r.feedBusyPct, `${r.ticksRun}/${r.ticksRequested}`, r.appliedPerSec, r.freshnessP95Ms, r.longTasks].map(fmt),
  );
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

(async () => {
  const server = await ensureServer();
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: args.headless === 'true',
    defaultViewport: null,
    args: [
      '--window-size=1400,900',
      '--enable-precise-memory-info',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--ignore-gpu-blocklist',
    ],
  });
  const consoleErrors = [];

  const results = [];
  const started = new Date();
  console.log(`${configs.length} runs × ~${warmup + duration + 4}s each, output in results/`);
  for (const [i, c] of configs.entries()) {
    const runId = `${Date.now()}-${i}`;
    const q = new URLSearchParams({ ...c, n: String(c.n), interval: String(c.interval), pan: c.pan, duration: String(duration), warmup: String(warmup), basemap: grid.basemap, changeRatio: grid.changeRatio, interleaved: grid.interleaved, auto: '1', runId });
    consoleErrors.length = 0;
    // fresh tab per run: no leftover globals, no shared heap between engines
    const page = await browser.newPage();
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !(m.location()?.url || '').includes('favicon')) consoleErrors.push(m.text()); });
    process.stdout.write(`[${i + 1}/${configs.length}] ${c.engine} ${c.mode} n=${c.n} every ${c.interval}ms ${c.pan === '1' ? 'pan' : 'fix'} … `);
    try {
      await page.goto(`${URL}/?${q}`, { waitUntil: 'load' });
      await page.waitForFunction((id) => window.__benchResult && window.__benchResult.runId === id, { timeout: (warmup + duration + 90) * 1000, polling: 500 }, runId);
      const r = await page.evaluate(() => window.__benchResult);
      if (consoleErrors.length) r.consoleErrors = consoleErrors.slice(0, 5);
      results.push(r);
      console.log(r.error ? `ERROR ${r.error}` : `fps ${r.fps}  feed ${r.feedAvgMs}ms  drawn ${r.appliedPerSec}/s  fresh p95 ${r.freshnessP95Ms}ms`);
    } catch (e) {
      results.push({ ...c, pan: c.pan === '1', error: String(e.message || e), consoleErrors: consoleErrors.slice(0, 5) });
      console.log(`FAILED ${e.message}`);
    }
    await page.close();
  }
  await browser.close();
  server?.kill();

  mkdirSync('results', { recursive: true });
  const stamp = started.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const meta = { started: started.toISOString(), duration, warmup, grid, ua: results.find((r) => r.ua)?.ua, dpr: results.find((r) => r.dpr)?.dpr };
  writeFileSync(`results/${stamp}.json`, JSON.stringify({ meta, results }, null, 2));
  const md = `# Map render bench ${started.toISOString()}\n\nBrowser: ${meta.ua}\nDPR: ${meta.dpr}, measured ${duration}s after ${warmup}s warm-up, basemap ${grid.basemap}\n\n${toMarkdown(results)}\n`;
  writeFileSync(`results/${stamp}.md`, md);
  console.log(`\n${toMarkdown(results)}\n\nsaved results/${stamp}.json and .md`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
