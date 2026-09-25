// Metrics harness. Everything is collected on the main thread.
// Frame timing comes from requestAnimationFrame deltas (what the user perceives).
// Long tasks come from PerformanceObserver (main-thread stalls > 50 ms).
// Per-update costs are reported by the orchestrator (sim cost vs. engine feed cost).
// Freshness / applied updates are reported by each engine via the Applied callbacks.

export interface Summary {
  fps: number;
  frameP50: number;
  frameP95: number;
  frameP99: number;
  frameMax: number;
  /** frames > 33 ms (i.e. below 30 fps) */
  slowFrames: number;
  frames: number;
  longTasks: number;
  longTaskMs: number;
  /** update ticks the scheduler asked for vs. actually ran (setInterval starves on a busy main thread) */
  ticksRequested: number;
  ticksRun: number;
  /** main-thread ms spent inside engine.update() per tick */
  feedAvgMs: number;
  feedP95Ms: number;
  feedMaxMs: number;
  /** main-thread ms inside engine.update() only (excludes worker serialisation microtasks) */
  feedSyncAvgMs: number;
  /** how many ticks produced a clean total-feed sample */
  feedSamples: number;
  /** main-thread ms spent moving entities per tick (shared cost, sanity check) */
  simAvgMs: number;
  /** share of wall time the main thread spent feeding the engine */
  feedBusyPct: number;
  /** distinct data generations that actually reached the screen per second */
  appliedPerSec: number;
  /** ticks that were superseded before ever being drawn */
  droppedTicks: number;
  /** ms from "data handed to the engine" to "that data is on screen" */
  freshnessAvgMs: number;
  freshnessP95Ms: number;
  freshnessMaxMs: number;
  heapStartMB: number | null;
  heapEndMB: number | null;
  durationMs: number;
}

function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

function heapMB(): number | null {
  const m = (performance as any).memory;
  return m ? Math.round((m.usedJSHeapSize / 1048576) * 10) / 10 : null;
}

export class Metrics {
  private frames: number[] = [];
  private feed: number[] = [];
  private feedSync: number[] = [];
  private sim: number[] = [];
  private freshness: number[] = [];
  private longTasks = 0;
  private longTaskMs = 0;
  private ticksRun = 0;
  private appliedCount = 0;
  private dropped = 0;
  private raf = 0;
  private lastFrame = 0;
  private startT = 0;
  private endT = 0;
  private observer: PerformanceObserver | null = null;
  private heapStart: number | null = null;
  recording = false;
  /** live view for the on-screen HUD */
  live = { fps: 0, feedMs: 0, freshnessMs: 0, appliedPerSec: 0 };
  private liveWindow: number[] = [];
  private liveApplied = 0;
  private liveT = 0;

  start(): void {
    this.recording = true;
    this.startT = performance.now();
    this.lastFrame = this.startT;
    this.liveT = this.startT;
    this.heapStart = heapMB();
    if ('PerformanceObserver' in window) {
      try {
        this.observer = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            this.longTasks++;
            this.longTaskMs += e.duration;
          }
        });
        this.observer.observe({ type: 'longtask', buffered: false });
      } catch {
        this.observer = null;
      }
    }
    const loop = (t: number) => {
      const dt = t - this.lastFrame;
      this.lastFrame = t;
      this.frameCount++;
      if (this.recording) this.frames.push(dt);
      this.liveWindow.push(dt);
      if (t - this.liveT > 500) {
        const sum = this.liveWindow.reduce((a, b) => a + b, 0);
        this.live.fps = Math.round((1000 * this.liveWindow.length) / sum);
        this.live.appliedPerSec = Math.round((1000 * this.liveApplied) / (t - this.liveT));
        this.liveWindow.length = 0;
        this.liveApplied = 0;
        this.liveT = t;
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Starts a fresh measurement window (used after warm-up). */
  reset(): void {
    this.frames = [];
    this.feed = [];
    this.feedSync = [];
    this.sim = [];
    this.freshness = [];
    this.longTasks = 0;
    this.longTaskMs = 0;
    this.ticksRun = 0;
    this.appliedCount = 0;
    this.dropped = 0;
    this.startT = performance.now();
    this.heapStart = heapMB();
  }

  /**
   * @param simMs   moving the entities (shared cost)
   * @param syncMs  time inside engine.update()
   * @param totalMs time until the next macrotask, i.e. including microtasks the engine
   *                queued (MapLibre serialises + posts to its worker there). NaN when a
   *                frame was rendered in between and the sample would be polluted.
   */
  tick(simMs: number, syncMs: number, totalMs: number): void {
    this.ticksRun++;
    this.sim.push(simMs);
    this.feedSync.push(syncMs);
    if (!Number.isNaN(totalMs)) this.feed.push(totalMs);
    this.live.feedMs = Math.round((Number.isNaN(totalMs) ? syncMs : totalMs) * 100) / 100;
  }

  /** number of animation frames rendered so far (used to detect polluted samples) */
  frameCount = 0;

  applied(latencyMs: number): void {
    this.appliedCount++;
    this.liveApplied++;
    this.freshness.push(latencyMs);
    this.live.freshnessMs = Math.round(latencyMs);
  }

  droppedTick(count = 1): void {
    this.dropped += count;
  }

  stop(intervalMs: number): Summary {
    this.recording = false;
    this.endT = performance.now();
    cancelAnimationFrame(this.raf);
    this.observer?.disconnect();
    const duration = this.endT - this.startT;
    const frames = [...this.frames].sort((a, b) => a - b);
    // if nearly every tick collided with a frame (very slow frames), fall back to the sync part
    const feedSource = this.feed.length >= Math.max(10, this.ticksRun * 0.1) ? this.feed : this.feedSync;
    const feed = [...feedSource].sort((a, b) => a - b);
    const fresh = [...this.freshness].sort((a, b) => a - b);
    const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const r = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
    return {
      fps: r((1000 * frames.length) / duration),
      frameP50: r(percentile(frames, 0.5)),
      frameP95: r(percentile(frames, 0.95)),
      frameP99: r(percentile(frames, 0.99)),
      frameMax: r(frames.length ? frames[frames.length - 1] : 0),
      slowFrames: frames.filter((f) => f > 33).length,
      frames: frames.length,
      longTasks: this.longTasks,
      longTaskMs: r(this.longTaskMs),
      ticksRequested: Math.round(duration / intervalMs),
      ticksRun: this.ticksRun,
      feedAvgMs: r(avg(feed), 2),
      feedP95Ms: r(percentile(feed, 0.95), 2),
      feedMaxMs: r(feed.length ? feed[feed.length - 1] : 0, 2),
      feedSyncAvgMs: r(avg(this.feedSync), 2),
      feedSamples: feed.length,
      simAvgMs: r(avg(this.sim), 2),
      // scale the clean-sample average to all ticks that ran
      feedBusyPct: r((100 * avg(feed) * this.ticksRun) / duration),
      appliedPerSec: r((1000 * this.appliedCount) / duration),
      droppedTicks: this.dropped,
      freshnessAvgMs: r(avg(fresh)),
      freshnessP95Ms: r(percentile(fresh, 0.95)),
      freshnessMaxMs: r(fresh.length ? fresh[fresh.length - 1] : 0),
      heapStartMB: this.heapStart,
      heapEndMB: heapMB(),
      durationMs: Math.round(duration),
    };
  }
}
