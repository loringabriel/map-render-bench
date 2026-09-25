import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
// MapLibre 6 resolves its worker relative to import.meta.url, which breaks once Vite bundles
// the library. Let Vite build the worker (and its shared chunk) and hand MapLibre the URL.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
setWorkerUrl(maplibreWorkerUrl);
import { Sim } from './sim';
import { Metrics, type Summary } from './metrics';
import { MapLibreEngine } from './engines/maplibre';
import { DeckGLEngine } from './engines/deckgl';
import type { Engine, EngineName, RenderMode } from './engines/types';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export interface RunConfig {
  engine: EngineName;
  n: number;
  interval: number;
  mode: RenderMode;
  pan: boolean;
  changeRatio: number;
  basemap: 'liberty' | 'none';
  interleaved: boolean;
  duration: number; // seconds measured
  warmup: number; // seconds ignored
}

export type RunResult = RunConfig & Summary & { ts: string; ua: string; dpr: number; runId?: string; error?: string };

const CENTER: [number, number] = [-3.7038, 40.4168]; // Madrid
const ZOOM = 12;
const HALF_EXTENT = 0.14;
const RESULTS_KEY = 'bench-results';
const QUEUE_KEY = 'bench-queue';
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function readForm(): RunConfig {
  return {
    engine: $<HTMLSelectElement>('engine').value as EngineName,
    n: +$<HTMLInputElement>('n').value,
    interval: +$<HTMLInputElement>('interval').value,
    mode: $<HTMLSelectElement>('mode').value as RenderMode,
    pan: $<HTMLSelectElement>('pan').value === '1',
    changeRatio: +$<HTMLSelectElement>('changeRatio').value,
    basemap: $<HTMLSelectElement>('basemap').value as RunConfig['basemap'],
    interleaved: $<HTMLSelectElement>('interleaved').value === '1',
    duration: +$<HTMLInputElement>('duration').value,
    warmup: 3,
  };
}

function writeForm(c: Partial<RunConfig>) {
  if (c.engine) $<HTMLSelectElement>('engine').value = c.engine;
  if (c.n) $<HTMLInputElement>('n').value = String(c.n);
  if (c.interval) $<HTMLInputElement>('interval').value = String(c.interval);
  if (c.mode) $<HTMLSelectElement>('mode').value = c.mode;
  if (c.pan !== undefined) $<HTMLSelectElement>('pan').value = c.pan ? '1' : '0';
  if (c.changeRatio) $<HTMLSelectElement>('changeRatio').value = String(c.changeRatio);
  if (c.basemap) $<HTMLSelectElement>('basemap').value = c.basemap;
  if (c.interleaved !== undefined) $<HTMLSelectElement>('interleaved').value = c.interleaved ? '1' : '0';
  if (c.duration) $<HTMLInputElement>('duration').value = String(c.duration);
}

function configFromURL(): Partial<RunConfig> & { auto: boolean } {
  const p = new URLSearchParams(location.search);
  const c: Partial<RunConfig> & { auto: boolean } = { auto: p.get('auto') === '1' };
  if (p.get('engine')) c.engine = p.get('engine') as EngineName;
  if (p.get('n')) c.n = +p.get('n')!;
  if (p.get('interval')) c.interval = +p.get('interval')!;
  if (p.get('mode')) c.mode = p.get('mode') as RenderMode;
  if (p.get('pan')) c.pan = p.get('pan') === '1';
  if (p.get('changeRatio')) c.changeRatio = +p.get('changeRatio')!;
  if (p.get('basemap')) c.basemap = p.get('basemap') as RunConfig['basemap'];
  if (p.get('interleaved')) c.interleaved = p.get('interleaved') === '1';
  if (p.get('duration')) c.duration = +p.get('duration')!;
  if (p.get('warmup')) c.warmup = +p.get('warmup')!;
  return c;
}

function toURL(c: RunConfig, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams({
    engine: c.engine, n: String(c.n), interval: String(c.interval), mode: c.mode, pan: c.pan ? '1' : '0',
    changeRatio: String(c.changeRatio), basemap: c.basemap, interleaved: c.interleaved ? '1' : '0',
    duration: String(c.duration), warmup: String(c.warmup), auto: '1', ...extra,
  });
  return `${location.pathname}?${p}`;
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
let map: MapLibreMap | null = null;

async function createMap(basemap: RunConfig['basemap']): Promise<MapLibreMap> {
  if (map) {
    map.remove();
    map = null;
  }
  const m = new MapLibreMap({
    container: 'map',
    style: basemap === 'none' ? { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#dfe6ee' } }] } : STYLE_URL,
    center: CENTER,
    zoom: ZOOM,
    attributionControl: false,
    fadeDuration: 0,
  });
  map = m;
  await new Promise<void>((resolve) => m.once('load', () => resolve()));
  // wait for basemap tiles so the measurement doesn't include initial tile loading
  await new Promise<void>((resolve) => {
    if (m.loaded()) resolve();
    else m.once('idle', () => resolve());
  });
  return m;
}

function makeEngine(name: EngineName): Engine {
  switch (name) {
    case 'maplibre-setdata': return new MapLibreEngine(false);
    case 'maplibre-updatedata': return new MapLibreEngine(true);
    case 'deckgl': return new DeckGLEngine();
  }
}

// ---------------------------------------------------------------------------
// Run loop
// ---------------------------------------------------------------------------
let stopRequested = false;

async function runOnce(cfg: RunConfig): Promise<RunResult> {
  const hud = (id: string, v: string | number) => ($(`hud-${id}`).textContent = String(v));
  const status = (s: string) => ($('status').textContent = s);
  hud('engine', cfg.engine);
  hud('n', cfg.n.toLocaleString());
  hud('phase', 'loading map');
  status(`Loading map for ${cfg.engine}…`);

  const m = await createMap(cfg.basemap);
  const sim = new Sim({ n: cfg.n, seed: 42, center: CENTER, halfExtent: HALF_EXTENT, speedScale: 8, changeRatio: cfg.changeRatio });
  const metrics = new Metrics();
  const engine = makeEngine(cfg.engine);
  await engine.init(m, sim, cfg.mode, {
    onApplied: (_gen, latency) => metrics.applied(latency),
    onDropped: (c) => metrics.droppedTick(c),
  }, { interleaved: cfg.interleaved ? '1' : '0' });

  metrics.start();
  hud('phase', 'warm-up');
  status(`Warm-up ${cfg.warmup}s…`);

  // A MessageChannel task runs right after the current task's microtasks drain, so
  // t3 - t1 covers everything the engine did for this update on the main thread.
  const channel = new MessageChannel();
  let pendingSample: { t0: number; t1: number; t2: number; frame: number } | null = null;
  channel.port1.onmessage = () => {
    if (!pendingSample) return;
    const { t0, t1, t2, frame } = pendingSample;
    pendingSample = null;
    const t3 = performance.now();
    const clean = metrics.frameCount === frame;
    metrics.tick(t1 - t0, t2 - t1, clean ? t3 - t1 : NaN);
  };
  const timer = setInterval(() => {
    const t0 = performance.now();
    sim.tick(cfg.interval);
    const t1 = performance.now();
    engine.update(sim);
    const t2 = performance.now();
    pendingSample = { t0, t1, t2, frame: metrics.frameCount };
    channel.port2.postMessage(null);
  }, cfg.interval);

  // camera animation: slow circle + gentle zoom breathing, driven per frame like a "follow" UI would
  let camRaf = 0;
  if (cfg.pan) {
    const t0 = performance.now();
    const loop = (t: number) => {
      const s = (t - t0) / 1000;
      m.jumpTo({
        center: [CENTER[0] + 0.04 * Math.cos(s * 0.5), CENTER[1] + 0.03 * Math.sin(s * 0.5)],
        zoom: ZOOM + 0.6 * Math.sin(s * 0.3),
      });
      camRaf = requestAnimationFrame(loop);
    };
    camRaf = requestAnimationFrame(loop);
  }

  const hudTimer = setInterval(() => {
    hud('fps', metrics.live.fps);
    hud('feed', metrics.live.feedMs.toFixed(2));
    hud('applied', metrics.live.appliedPerSec);
    hud('fresh', metrics.live.freshnessMs);
  }, 250);

  await sleep(cfg.warmup * 1000);
  metrics.reset();
  hud('phase', 'measuring');
  status(`Measuring ${cfg.duration}s…`);
  const endAt = performance.now() + cfg.duration * 1000;
  while (performance.now() < endAt && !stopRequested) await sleep(100);

  const summary = metrics.stop(cfg.interval);
  clearInterval(timer);
  channel.port1.close();
  clearInterval(hudTimer);
  cancelAnimationFrame(camRaf);
  engine.destroy();
  hud('phase', 'done');
  status('Done');
  return { ...cfg, ...summary, ts: new Date().toISOString(), ua: navigator.userAgent, dpr: devicePixelRatio, runId: new URLSearchParams(location.search).get('runId') || '' };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Results table / storage
// ---------------------------------------------------------------------------
function loadResults(): RunResult[] {
  try { return JSON.parse(sessionStorage.getItem(RESULTS_KEY) || '[]'); } catch { return []; }
}
function saveResult(r: RunResult) {
  const all = loadResults();
  all.push(r);
  sessionStorage.setItem(RESULTS_KEY, JSON.stringify(all));
  renderResults();
}
function cls(v: number, warn: number, bad: number, invert = false) {
  const x = invert ? -v : v, w = invert ? -warn : warn, b = invert ? -bad : bad;
  return x >= b ? 'bad' : x >= w ? 'warn' : 'good';
}
function renderResults() {
  const tb = $<HTMLTableSectionElement>('results').querySelector('tbody')!;
  tb.innerHTML = '';
  for (const r of loadResults()) {
    const tr = document.createElement('tr');
    if (r.error) { tr.innerHTML = `<td>${r.engine}</td><td colspan="13" class="bad">${r.error}</td>`; tb.appendChild(tr); continue; }
    tr.innerHTML = [
      `<td>${r.engine.replace('maplibre-', 'ml:')}</td>`, `<td>${r.mode}</td>`, `<td>${r.n}</td>`, `<td>${r.interval}</td>`, `<td>${r.pan ? 'pan' : 'fix'}</td>`,
      `<td class="${cls(r.fps, 50, 30, true)}">${r.fps}</td>`,
      `<td class="${cls(r.frameP95, 20, 34)}">${r.frameP95}</td>`,
      `<td class="${cls(r.slowFrames, 1, 10)}">${r.slowFrames}</td>`,
      `<td class="${cls(r.feedAvgMs, 4, 10)}">${r.feedAvgMs}</td>`,
      `<td class="${cls(r.feedBusyPct, 25, 60)}">${r.feedBusyPct}</td>`,
      `<td class="${cls(r.ticksRun / r.ticksRequested, 0.9, 0.6, true)}">${r.ticksRun}/${r.ticksRequested}</td>`,
      `<td class="${cls(r.appliedPerSec, 30, 15, true)}">${r.appliedPerSec}</td>`,
      `<td class="${cls(r.freshnessP95Ms, 50, 150)}">${r.freshnessP95Ms}</td>`,
      `<td class="${cls(r.longTasks, 1, 10)}">${r.longTasks}</td>`,
    ].join('');
    tb.appendChild(tr);
  }
}
function toCSV(rows: RunResult[]): string {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]).filter((k) => k !== 'ua');
  return [keys.join(','), ...rows.map((r) => keys.map((k) => JSON.stringify((r as any)[k] ?? '')).join(','))].join('\n');
}

// ---------------------------------------------------------------------------
// Matrix (each run in a fresh page load via sessionStorage queue)
// ---------------------------------------------------------------------------
export function buildMatrix(base: RunConfig): RunConfig[] {
  const engines: EngineName[] = ['maplibre-setdata', 'maplibre-updatedata', 'deckgl'];
  const out: RunConfig[] = [];
  for (const n of [2000, 10000, 30000])
    for (const interval of [50, 20, 10])
      for (const mode of ['circles', 'icons'] as RenderMode[])
        for (const pan of [false, true])
          for (const engine of engines) out.push({ ...base, engine, n, interval, mode, pan });
  return out;
}

function startQueue(queue: RunConfig[]) {
  sessionStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  nextInQueue();
}
function nextInQueue() {
  const queue: RunConfig[] = JSON.parse(sessionStorage.getItem(QUEUE_KEY) || '[]');
  if (!queue.length) {
    sessionStorage.removeItem(QUEUE_KEY);
    $('status').textContent = 'Matrix complete';
    return;
  }
  const next = queue.shift()!;
  sessionStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  location.href = toURL(next, { queue: '1' });
}

// ---------------------------------------------------------------------------
// Wire-up
// ---------------------------------------------------------------------------
async function runAndRecord(cfg: RunConfig): Promise<RunResult> {
  stopRequested = false;
  $<HTMLButtonElement>('run').disabled = true;
  $<HTMLButtonElement>('matrix').disabled = true;
  $<HTMLButtonElement>('stop').disabled = false;
  let result: RunResult;
  try {
    result = await runOnce(cfg);
  } catch (e: any) {
    console.error(e);
    result = { ...cfg, error: String(e?.message || e) } as RunResult;
    $('status').textContent = `Error: ${result.error}`;
  }
  saveResult(result);
  (window as any).__benchResult = result;
  $<HTMLButtonElement>('run').disabled = false;
  $<HTMLButtonElement>('matrix').disabled = false;
  $<HTMLButtonElement>('stop').disabled = true;
  return result;
}

$('run').addEventListener('click', () => runAndRecord(readForm()));
$('stop').addEventListener('click', () => { stopRequested = true; sessionStorage.removeItem(QUEUE_KEY); });
$('matrix').addEventListener('click', () => {
  const base = readForm();
  const m = buildMatrix(base);
  if (confirm(`Run ${m.length} configurations (~${Math.round((m.length * (base.duration + base.warmup + 4)) / 60)} min)? The page reloads between runs.`)) startQueue(m);
});
$('copy').addEventListener('click', () => navigator.clipboard.writeText(JSON.stringify(loadResults(), null, 2)));
$('csv').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([toCSV(loadResults())], { type: 'text/csv' }));
  a.download = `map-bench-${Date.now()}.csv`;
  a.click();
});
$('clear').addEventListener('click', () => { sessionStorage.removeItem(RESULTS_KEY); renderResults(); });

renderResults();
const urlCfg = configFromURL();
writeForm(urlCfg);
if (urlCfg.auto) {
  const cfg = { ...readForm(), warmup: urlCfg.warmup ?? 3 };
  runAndRecord(cfg).then(() => {
    if (new URLSearchParams(location.search).get('queue') === '1') nextInQueue();
  });
} else {
  // idle preview so the page isn't blank
  createMap('liberty').catch(console.error);
}
