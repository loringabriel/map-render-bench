import { Map as MapLibreMap } from 'maplibre-gl';
import type { GeoJSONSource, GeoJSONSourceDiff } from 'maplibre-gl';
import type { Sim } from '../sim';
import { arrowImageData } from '../icon';
import type { Engine, EngineHooks, EngineName, RenderMode } from './types';

const SRC = 'entities';

/**
 * MapLibre "native" path: a GeoJSON source fed with setData() (full replace) or
 * updateData() (partial diff). Either way the data goes to a worker, gets re-tiled by
 * geojson-vt, and each visible tile is rebuilt and re-uploaded to the GPU.
 */
export class MapLibreEngine implements Engine {
  readonly name: EngineName;
  private map!: MapLibreMap;
  private source!: GeoJSONSource;
  private mode: RenderMode = 'circles';
  private hooks!: EngineHooks;
  private partial: boolean;
  // generation bookkeeping (see README "how freshness is measured")
  private pending: { gen: number; t: number }[] = [];
  private inWorker: { gen: number; t: number } | null = null;
  private awaitingTiles: { gen: number; t: number } | null = null;
  private listeners: [string, (e: any) => void][] = [];

  constructor(partial: boolean) {
    this.partial = partial;
    this.name = partial ? 'maplibre-updatedata' : 'maplibre-setdata';
  }

  async init(map: MapLibreMap, sim: Sim, mode: RenderMode, hooks: EngineHooks): Promise<void> {
    this.map = map;
    this.mode = mode;
    this.hooks = hooks;

    map.addImage('bench-arrow', arrowImageData(), { sdf: true });
    map.addSource(SRC, {
      type: 'geojson',
      data: this.toGeoJSON(sim),
      // No spatial index niceties we don't need: keep it as cheap as MapLibre allows.
      buffer: 0,
      tolerance: 0,
      generateId: false,
    });
    this.source = map.getSource(SRC) as GeoJSONSource;

    if (mode === 'circles') {
      map.addLayer({
        id: 'entities-circle',
        type: 'circle',
        source: SRC,
        paint: {
          'circle-radius': 4,
          'circle-color': ['get', 'c'],
          'circle-stroke-width': 1,
          'circle-stroke-color': '#ffffff',
        },
      });
    } else {
      map.addLayer({
        id: 'entities-symbol',
        type: 'symbol',
        source: SRC,
        layout: {
          'icon-image': 'bench-arrow',
          'icon-size': 0.4,
          'icon-rotate': ['get', 'h'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          ...(mode === 'icons-labels'
            ? {
                'text-field': ['get', 'l'],
                'text-size': 11,
                'text-offset': [0, 1.2],
                'text-anchor': 'top',
                'text-allow-overlap': true,
                'text-ignore-placement': true,
              }
            : {}),
        },
        paint: {
          'icon-color': ['get', 'c'],
          ...(mode === 'icons-labels' ? { 'text-color': '#111', 'text-halo-color': '#fff', 'text-halo-width': 1 } : {}),
        },
      });
    }

    // --- freshness tracking -------------------------------------------------
    const on = (ev: string, fn: (e: any) => void) => {
      map.on(ev as any, fn);
      this.listeners.push([ev, fn]);
    };
    // fired when a (possibly coalesced) update is handed to the worker
    on('sourcedataloading', (e) => {
      if (e.sourceId !== SRC || !this.pending.length) return;
      const latest = this.pending[this.pending.length - 1];
      // everything queued before the dispatched one never reaches the screen
      if (this.pending.length > 1) this.hooks.onDropped(this.pending.length - 1);
      this.pending = [];
      this.inWorker = latest;
    });
    // worker finished re-indexing; tiles are now being rebuilt
    on('sourcedata', (e) => {
      if (e.sourceId !== SRC || e.sourceDataType !== 'content' || !this.inWorker) return;
      if (this.awaitingTiles) this.hooks.onDropped(1); // previous gen's tiles were superseded
      this.awaitingTiles = this.inWorker;
      this.inWorker = null;
    });
    on('sourcedataabort', (e) => {
      if (e.sourceId !== SRC || !this.inWorker) return;
      this.hooks.onDropped(1);
      this.inWorker = null;
    });
    // a frame was drawn: if all visible tiles of the awaited generation are loaded, it's on screen
    on('render', () => {
      if (!this.awaitingTiles) return;
      if (this.visibleTilesLoaded()) {
        this.hooks.onApplied(this.awaitingTiles.gen, performance.now() - this.awaitingTiles.t);
        this.awaitingTiles = null;
      }
    });

    await new Promise<void>((resolve) => {
      if (map.isSourceLoaded(SRC)) resolve();
      else map.once('idle', () => resolve());
    });
  }

  private visibleTilesLoaded(): boolean {
    try {
      const tm = (this.map as any).style?.tileManagers?.[SRC];
      if (!tm) return false;
      for (const tile of tm._inViewTiles.getAllTiles()) {
        if (tile.state !== 'loaded' && tile.state !== 'errored') return false;
      }
      return true;
    } catch {
      // private API changed: fall back to the public (stricter) check
      return this.map.isSourceLoaded(SRC);
    }
  }

  private toGeoJSON(sim: Sim): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = new Array(sim.n);
    const withHeading = this.mode !== 'circles';
    const withLabel = this.mode === 'icons-labels';
    for (let i = 0; i < sim.n; i++) {
      const props: Record<string, unknown> = { c: sim.colorHex[i] };
      if (withHeading) props.h = sim.heading[i];
      if (withLabel) props.l = sim.labels[i];
      features[i] = {
        type: 'Feature',
        id: i,
        properties: props,
        geometry: { type: 'Point', coordinates: [sim.pos[i * 3], sim.pos[i * 3 + 1]] },
      };
    }
    return { type: 'FeatureCollection', features };
  }

  private toDiff(sim: Sim): GeoJSONSourceDiff {
    const withHeading = this.mode !== 'circles';
    const update = new Array(sim.changedCount);
    for (let k = 0; k < sim.changedCount; k++) {
      const i = sim.changed[k];
      update[k] = {
        id: i,
        newGeometry: { type: 'Point', coordinates: [sim.pos[i * 3], sim.pos[i * 3 + 1]] },
        ...(withHeading ? { addOrUpdateProperties: [{ key: 'h', value: sim.heading[i] }] } : {}),
      };
    }
    return { update };
  }

  update(sim: Sim): void {
    this.pending.push({ gen: sim.generation, t: performance.now() });
    if (this.partial) this.source.updateData(this.toDiff(sim));
    else this.source.setData(this.toGeoJSON(sim));
  }

  destroy(): void {
    for (const [ev, fn] of this.listeners) this.map.off(ev as any, fn);
    this.listeners = [];
  }
}
