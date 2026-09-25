// Shared simulation: N entities moving inside a bounding box.
// Both engines consume the SAME state each tick, so the only difference measured is how
// each rendering path ingests and draws it.

export interface SimOptions {
  n: number;
  seed: number;
  center: [number, number];
  /** half extent of the bbox in degrees */
  halfExtent: number;
  /** m/s multiplier so movement is visible in a short run */
  speedScale: number;
  /** fraction of entities that move on a given tick (1 = all) */
  changeRatio: number;
}

// Deterministic PRNG (mulberry32) so every run uses identical data.
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PALETTE: [number, number, number][] = [
  [230, 57, 70], [29, 161, 242], [46, 204, 113], [241, 196, 15],
  [155, 89, 182], [255, 127, 80], [26, 188, 156], [236, 64, 122],
];

export class Sim {
  readonly n: number;
  /** interleaved [lon, lat, 0] per entity, Float64 to avoid precision stalls at small dt */
  readonly pos: Float64Array;
  readonly heading: Float32Array; // degrees, clockwise from north
  readonly speed: Float32Array; // m/s
  readonly turnRate: Float32Array; // deg/s
  readonly color: Uint8Array; // rgb per entity (static)
  readonly colorHex: string[]; // static, for MapLibre data-driven styling
  readonly labels: string[]; // static
  readonly opts: SimOptions;
  /** monotonically increasing update counter */
  generation = 0;
  /** ids of entities changed in the last tick (only meaningful when changeRatio < 1) */
  changed: Int32Array;
  changedCount = 0;
  private rand: () => number;
  private readonly minLon: number;
  private readonly maxLon: number;
  private readonly minLat: number;
  private readonly maxLat: number;

  constructor(opts: SimOptions) {
    this.opts = opts;
    this.n = opts.n;
    this.rand = mulberry32(opts.seed);
    this.pos = new Float64Array(opts.n * 3);
    this.heading = new Float32Array(opts.n);
    this.speed = new Float32Array(opts.n);
    this.turnRate = new Float32Array(opts.n);
    this.color = new Uint8Array(opts.n * 3);
    this.colorHex = new Array(opts.n);
    this.labels = new Array(opts.n);
    this.changed = new Int32Array(opts.n);
    const [cx, cy] = opts.center;
    this.minLon = cx - opts.halfExtent;
    this.maxLon = cx + opts.halfExtent;
    this.minLat = cy - opts.halfExtent * 0.7;
    this.maxLat = cy + opts.halfExtent * 0.7;
    for (let i = 0; i < opts.n; i++) {
      this.pos[i * 3] = this.minLon + this.rand() * (this.maxLon - this.minLon);
      this.pos[i * 3 + 1] = this.minLat + this.rand() * (this.maxLat - this.minLat);
      this.pos[i * 3 + 2] = 0;
      this.heading[i] = this.rand() * 360;
      this.speed[i] = (5 + this.rand() * 25) * opts.speedScale;
      this.turnRate[i] = (this.rand() - 0.5) * 40;
      const c = PALETTE[i % PALETTE.length];
      this.color[i * 3] = c[0];
      this.color[i * 3 + 1] = c[1];
      this.color[i * 3 + 2] = c[2];
      this.colorHex[i] = `rgb(${c[0]},${c[1]},${c[2]})`;
      this.labels[i] = `V-${i.toString(36).toUpperCase()}`;
    }
  }

  /** Advance all (or a rotating subset of) entities by dtMs. */
  tick(dtMs: number): void {
    const dt = dtMs / 1000;
    const { pos, heading, speed, turnRate } = this;
    const stride = Math.max(1, Math.round(1 / this.opts.changeRatio));
    const phase = this.generation % stride;
    let changedCount = 0;
    for (let i = 0; i < this.n; i++) {
      if (stride > 1 && i % stride !== phase) continue;
      // when only a subset moves, move it as if dt covered the whole interval
      const d = dt * stride;
      let h = heading[i] + turnRate[i] * d;
      if (h < 0) h += 360;
      else if (h >= 360) h -= 360;
      const rad = (h * Math.PI) / 180;
      const dist = speed[i] * d; // meters
      const lat = pos[i * 3 + 1];
      const dLat = (dist * Math.cos(rad)) / 111320;
      const dLon = (dist * Math.sin(rad)) / (111320 * Math.cos((lat * Math.PI) / 180));
      let lon = pos[i * 3] + dLon;
      let nlat = lat + dLat;
      // bounce on bbox edges
      if (lon < this.minLon || lon > this.maxLon) {
        h = (360 - h) % 360;
        lon = Math.min(this.maxLon, Math.max(this.minLon, lon));
      }
      if (nlat < this.minLat || nlat > this.maxLat) {
        h = (180 - h + 360) % 360;
        nlat = Math.min(this.maxLat, Math.max(this.minLat, nlat));
      }
      pos[i * 3] = lon;
      pos[i * 3 + 1] = nlat;
      heading[i] = h;
      this.changed[changedCount++] = i;
    }
    this.changedCount = changedCount;
    this.generation++;
  }
}
