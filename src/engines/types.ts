import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Sim } from '../sim';

export type EngineName = 'maplibre-setdata' | 'maplibre-updatedata' | 'deckgl';
export type RenderMode = 'circles' | 'icons' | 'icons-labels';

export interface EngineHooks {
  /** a data generation is now on screen; latencyMs = time since it was handed to the engine */
  onApplied(generation: number, latencyMs: number): void;
  /** generations that were superseded before ever being drawn */
  onDropped(count: number): void;
}

export interface Engine {
  readonly name: EngineName;
  init(map: MapLibreMap, sim: Sim, mode: RenderMode, hooks: EngineHooks, options: Record<string, string>): Promise<void>;
  /** Feed the current sim state to the engine. Measured on the main thread. */
  update(sim: Sim): void;
  destroy(): void;
}
