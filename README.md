# map-render-bench

Proof of concept to answer one question with numbers instead of opinions:

> For thousands of map elements that move every 10–30 ms, is MapLibre's native GeoJSON
> path good enough, or do we need deck.gl (rendered on top of MapLibre) for the dynamic layer?

Both candidates draw **the same simulation, in the same viewport, with the same sprite**.
Only the ingestion + rendering path differs.

| Engine | How updates reach the GPU |
| --- | --- |
| `maplibre-setdata` | `GeoJSONSource.setData(featureCollection)` every tick. MapLibre deep-copies the GeoJSON (`serialize`), structured-clones it to a worker, re-indexes it with geojson-vt, rebuilds every visible tile, then uploads the new tile buffers. While a load is in flight, newer `setData` calls overwrite the pending one (intermediate states are never drawn). |
| `maplibre-updatedata` | `GeoJSONSource.updateData({update: [...]})`: only the changed features cross to the worker, but the worker still re-indexes and re-tiles the whole source. |
| `deckgl` | `MapboxOverlay` + `ScatterplotLayer` / `IconLayer` (+ `TextLayer`) fed with typed arrays (`{length, attributes}`). No worker, no objects per feature, no tiling: the arrays are uploaded to GPU buffers on the next frame. |

## Run it

```bash
npm install
npm run dev            # http://localhost:5173 – interactive page
npm run bench:quick    # automated matrix in a real Chrome window (~7 min)
npm run bench          # full matrix (~30 min)
node bench/run.mjs --engines=deckgl,maplibre-setdata --n=20000 --interval=10 --modes=icons --pans=0,1
```

The runner writes `results/<timestamp>.json` and a markdown table in `results/<timestamp>.md`.
The interactive page keeps its results in the tab (`Copy JSON`, `Download CSV`) and has a
`Run full matrix` button that reloads the page between runs, so engines never share a WebGL
context or heap.

The runner uses **headed** Chrome on purpose: headless Chrome renders with SwiftShader, which
would turn a GPU comparison into a CPU comparison. Keep the window visible and don't use the
machine during a run.

## What is measured, and why these metrics

FPS alone is misleading here: MapLibre does its expensive work in a worker, so the main thread
can look idle at 60 fps while the elements on screen are 150 ms stale. The harness therefore
reports three families of metrics:

1. **Smoothness** – frame time p50/p95/p99, count of frames slower than 33 ms, long tasks (> 50 ms).
   This is what the user feels while panning.
2. **Main-thread cost of one update** – `feed ms` is the time from handing the data to the
   engine until the main thread is free again, including the microtask in which MapLibre
   serialises and posts to its worker (measured with a MessageChannel macrotask; samples where a
   frame was rendered in between are discarded). `busy %` is that cost scaled to the requested
   update rate. `ticks run/requested` shows whether the update timer itself is being starved.
3. **Freshness** – `drawn upd/s` is how many distinct data generations actually reached the
   screen per second (capped by the display refresh rate, 60 on most machines), `dropped` is how
   many ticks were superseded before ever being drawn, and `fresh p95` is the p95 latency from
   "data handed to the engine" to "that data is visible".

   - deck.gl: measured via `onAfterRender`; the generation drawn is the last one passed to `setProps`.
   - MapLibre: `sourcedataloading` marks which generation was actually dispatched to the worker,
     `sourcedata (content)` marks the worker finishing, and the first `render` where all in-view
     tiles of the source are in state `loaded` marks it visible. This reads private tile state
     (`style.tileManagers[id]._inViewTiles`); if that API changes it falls back to
     `map.isSourceLoaded`, which is stricter.

Heap size (Chrome only, `--enable-precise-memory-info`) is recorded at the start and end of the
measured window to catch allocation churn.

## Benchmark dimensions

| Dimension | Values | Why |
| --- | --- | --- |
| elements | 2 000 / 10 000 / 30 000 | find where each path breaks, not just one point |
| update interval | 50 / 20 / 10 ms | matches the 10–30 ms update rate in the original question |
| render mode | circles / rotated icons / icons + labels | symbol layers (icons, text) are MapLibre's most expensive bucket type; circles are the cheapest |
| camera | static / panning + zooming | tile reloading during interaction is where MapLibre's per-tile rebuild hurts most |
| moving share | 100 % / 20 % per tick | gives `updateData` its best case (fewer features per diff) |
| basemap | Liberty vector tiles / none | `none` isolates the overlay cost from basemap rendering |
| deck.gl mode | overlaid / interleaved | interleaved shares MapLibre's context (correct z-order with 3D/labels) but forces a full basemap redraw per frame |

Every run: 3 s warm-up (excluded), then 10 s measured. Same seed, so all engines see identical data.

## Interpreting results

- If `drawn upd/s` for MapLibre is far below `1000 / interval` (or below ~50 at 60 Hz) while
  fps is fine, the map is smooth but stale: users see jumps, not motion.
- `feed ms` × updates per second is the main-thread budget consumed before the app does anything
  else (Redux, DOM, WebSocket parsing). Above ~30 % the rest of the UI starts to jank.
- Panning results matter more than static ones for a fleet/tracking UI.
- `updateData` reduces transfer cost but not re-tiling cost; if it doesn't move the needle, the
  bottleneck is tiling, not serialisation.

## Fairness notes and caveats

- Collision detection is disabled in MapLibre (`icon-allow-overlap`, `icon-ignore-placement`) so
  it doesn't pay for placement work deck.gl doesn't do. Enable it if the product needs it.
- The MapLibre source uses `buffer: 0`, `tolerance: 0`, so no extra tile-overlap work is done.
- deck.gl positions are Float64 (`fp64` on) so precision matches MapLibre; colours are a static
  typed array (same reference every tick, so deck.gl skips the re-upload, which is the point of
  the architecture).
- The label mode uses deck.gl's `TextLayer` with object data and `updateTriggers`, which is the
  documented efficient path but still a JS accessor per element per tick.
- A third MapLibre option (a `CustomLayerInterface` writing raw WebGL) would perform like
  deck.gl because it *is* the same technique, minus the library. It is not implemented here; it
  is the "build it ourselves" alternative to adopting deck.gl.
- The simulation runs on the main thread like a WebSocket handler would. Its cost (`sim ms`) is
  reported separately and is identical for all engines.
- Results depend on GPU, DPR and Chrome version; the JSON records the user agent and DPR. Run on
  the lowest-end machine the product must support, not only on a MacBook Pro.

## Layout

```
src/sim.ts             deterministic moving-entity simulation (shared)
src/metrics.ts         frame timing, long tasks, feed cost, freshness
src/engines/maplibre.ts   setData / updateData paths + freshness tracking via source events
src/engines/deckgl.ts     MapboxOverlay + binary attributes
src/main.ts            UI, run loop, URL params, in-page matrix (sessionStorage queue)
bench/run.mjs          puppeteer-core matrix runner (uses the locally installed Chrome)
bench/debug.mjs        open one config with console output and a mid-run screenshot
```

## First results (MacBook, Chrome 153, DPR 2, 20 ms updates, quick grid)

See `results/2026-09-24T13-10-03.md` for the full table. Headline numbers:

| scenario | MapLibre setData | MapLibre updateData | deck.gl |
| --- | --- | --- | --- |
| 5 000 icons, panning: drawn upd/s · fresh p95 | 28 /s · 92 ms | 16 /s · 125 ms | 50 /s · 15 ms |
| 20 000 circles, panning: drawn upd/s · fresh p95 | 8 /s · 294 ms | 0.9 /s · 2 119 ms | 50 /s · 14 ms |
| 20 000 icons, panning: fps · p95 frame · drawn upd/s | 46 fps · 34 ms · 6.5 /s | 28 fps · 133 ms · 1.2 /s | 60 fps · 18 ms · 50 /s |
| 20 000 icons, panning: main thread busy feeding | 3 % (but 40 % of ticks starved) | 25 % | 0.8 % |

deck.gl drew every update the display could show (50/s at 60 Hz for a 20 ms feed) in every
configuration, with the main thread under 2 % busy. MapLibre kept 60 fps at 5 000 elements but
only showed 10–28 distinct updates per second with 70–125 ms of staleness, and at 20 000 icons
it dropped to 28–50 fps with 0.3–1.4 s of staleness. `updateData` was slower than `setData` at
these sizes because every feature changes each tick, so the diff is as large as the data and the
worker still re-tiles everything.
