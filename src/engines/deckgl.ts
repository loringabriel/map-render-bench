import type { Map as MapLibreMap } from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer, IconLayer, TextLayer } from '@deck.gl/layers';
import type { Sim } from '../sim';
import { makeArrowCanvas, ICON_SIZE } from '../icon';
import type { Engine, EngineHooks, EngineName, RenderMode } from './types';

/**
 * deck.gl path: layers read typed arrays straight into GPU buffers. No worker, no
 * re-tiling, no per-feature objects. Each tick we hand deck a fresh copy of the arrays
 * (ping-pong buffers) and it re-uploads them on the next frame.
 */
export class DeckGLEngine implements Engine {
  readonly name: EngineName = 'deckgl';
  private overlay!: MapboxOverlay;
  private map!: MapLibreMap;
  private mode: RenderMode = 'circles';
  private hooks!: EngineHooks;
  private iconAtlas = '';
  // ping-pong buffers: deck skips the upload if it sees the same typed array reference
  private posBufs: [Float64Array, Float64Array] | null = null;
  private headBufs: [Float32Array, Float32Array] | null = null;
  private flip = 0;
  private labelData: { i: number }[] = [];
  private sentGen = -1;
  private sentT = 0;
  private drawnGen = -1;

  async init(map: MapLibreMap, sim: Sim, mode: RenderMode, hooks: EngineHooks, options: Record<string, string>): Promise<void> {
    this.map = map;
    this.mode = mode;
    this.hooks = hooks;
    this.iconAtlas = makeArrowCanvas().toDataURL();
    this.posBufs = [new Float64Array(sim.n * 3), new Float64Array(sim.n * 3)];
    this.headBufs = [new Float32Array(sim.n), new Float32Array(sim.n)];
    this.labelData = Array.from({ length: sim.n }, (_, i) => ({ i }));

    this.overlay = new MapboxOverlay({
      interleaved: options.interleaved === '1',
      layers: this.buildLayers(sim),
      onAfterRender: () => {
        // a frame with the most recently fed generation just hit the screen
        if (this.sentGen !== this.drawnGen) {
          const superseded = this.sentGen - this.drawnGen - 1;
          if (this.drawnGen >= 0 && superseded > 0) this.hooks.onDropped(superseded);
          this.drawnGen = this.sentGen;
          this.hooks.onApplied(this.sentGen, performance.now() - this.sentT);
        }
      },
    });
    map.addControl(this.overlay as any);
    this.sentGen = sim.generation;
    this.sentT = performance.now();
    await new Promise((r) => setTimeout(r, 200));
  }

  private buildLayers(sim: Sim) {
    // copy sim state into the "other" buffer so deck sees a new reference
    const b = this.flip ^= 1;
    const pos = this.posBufs![b];
    pos.set(sim.pos);
    const n = sim.n;
    const layers: any[] = [];

    if (this.mode === 'circles') {
      layers.push(
        new ScatterplotLayer({
          id: 'entities-circle',
          data: {
            length: n,
            attributes: {
              getPosition: { value: pos, size: 3 },
              getFillColor: { value: sim.color, size: 3 }, // static: same reference every tick => no re-upload
            },
          },
          radiusUnits: 'pixels',
          getRadius: 4,
          stroked: true,
          lineWidthUnits: 'pixels',
          getLineWidth: 1,
          getLineColor: [255, 255, 255],
        }),
      );
    } else {
      const head = this.headBufs![b];
      // MapLibre icon-rotate is clockwise; deck getAngle is counter-clockwise
      for (let i = 0; i < n; i++) head[i] = -sim.heading[i];
      layers.push(
        new IconLayer({
          id: 'entities-icon',
          data: {
            length: n,
            attributes: {
              getPosition: { value: pos, size: 3 },
              getAngle: { value: head, size: 1 },
              getColor: { value: sim.color, size: 3 },
            },
          },
          iconAtlas: this.iconAtlas,
          iconMapping: { arrow: { x: 0, y: 0, width: ICON_SIZE, height: ICON_SIZE, mask: true } },
          getIcon: () => 'arrow',
          sizeUnits: 'pixels',
          getSize: ICON_SIZE * 0.4,
          billboard: false,
        }),
      );
      if (this.mode === 'icons-labels') {
        layers.push(
          new TextLayer({
            id: 'entities-label',
            data: this.labelData,
            getPosition: (d: { i: number }) => [pos[d.i * 3], pos[d.i * 3 + 1]],
            getText: (d: { i: number }) => sim.labels[d.i],
            getSize: 11,
            sizeUnits: 'pixels',
            getPixelOffset: [0, 14],
            getColor: [17, 17, 17],
            outlineWidth: 1,
            outlineColor: [255, 255, 255],
            fontSettings: { sdf: true },
            characterSet: 'V-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
            // only re-evaluate positions, text/colour stay cached
            updateTriggers: { getPosition: sim.generation },
          }),
        );
      }
    }
    return layers;
  }

  update(sim: Sim): void {
    this.sentGen = sim.generation;
    this.sentT = performance.now();
    this.overlay.setProps({ layers: this.buildLayers(sim) });
  }

  destroy(): void {
    try {
      this.map.removeControl(this.overlay as any);
    } catch {
      /* map may already be gone */
    }
  }
}
