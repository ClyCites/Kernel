/**
 * Determinism for the adversarial seed. Work order D1.
 *
 * A seed corpus that differs between runs is not a fixture, it is noise: the
 * assertions in `seed.test.ts` would have to be loose enough to accommodate the
 * variation, and loose assertions are how fixture drift goes unnoticed. Same
 * seed, byte-identical documents.
 *
 * Nothing here reads the clock or `Math.random`. That includes the ids — a
 * UUIDv7 normally embeds the wall clock, and one generated from `Date.now()`
 * would change every run and take the whole corpus with it.
 */

/** The seed used when none is given. Written down so "same seed" means something. */
export const DEFAULT_SEED = 20260803;

/**
 * The instant the corpus is anchored to. Every generated timestamp is an offset
 * from here, so a run in 2027 produces the same season it produced in 2026.
 */
export const EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0);

/**
 * splitmix32. Chosen because it is four lines, has no state beyond a uint32,
 * and is trivially reimplementable in another language if the seed corpus ever
 * needs to be regenerated outside this repository.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x9e3779b9) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return ((z ^ (z >>> 15)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('cannot pick from an empty list');
    return items[this.int(0, items.length - 1)]!;
  }

  /** Box–Muller. Two uniforms in, one normal out; the second is discarded. */
  normal(mean: number, stddev: number): number {
    const u = Math.max(this.next(), Number.EPSILON);
    const v = this.next();
    return mean + stddev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** A normal draw clamped to a plausible range. Bag weights are never negative. */
  normalWithin(mean: number, stddev: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, this.normal(mean, stddev)));
  }

  /** Fisher–Yates, in place. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  }
}

const hex = (value: number, digits: number): string =>
  value.toString(16).padStart(digits, '0');

/**
 * UUIDv7 with the timestamp under our control.
 *
 * The counter goes into the millisecond field, so ids sort in generation order.
 * That matters beyond tidiness: the kernel pages on `(recorded_at, id)`, and a
 * corpus whose ids sort randomly makes every cursor test depend on insertion
 * timing. The random bits come from the same `Rng` as everything else.
 */
export class IdFactory {
  private counter = 0;

  constructor(private readonly rng: Rng) {}

  next(): string {
    const ms = EPOCH + this.counter;
    this.counter += 1;

    const stamp = hex(ms, 12);
    const randA = this.rng.int(0, 0x0fff);
    const randB1 = this.rng.int(0, 0x3fff) | 0x8000;
    const randB2 = this.rng.int(0, 0xffffffff);
    const randB3 = this.rng.int(0, 0xffff);

    return [
      stamp.slice(0, 8),
      stamp.slice(8, 12),
      hex(0x7000 | randA, 4),
      hex(randB1, 4),
      hex(randB2, 8) + hex(randB3, 4),
    ].join('-');
  }
}

/** An ISO-8601 timestamp in East Africa Time, offset from the fixed epoch. */
export function at(dayOffset: number, hour = 9, minute = 0): string {
  const ms = EPOCH + dayOffset * 86400000 + hour * 3600000 + minute * 60000;
  return `${new Date(ms).toISOString().slice(0, 19)}+03:00`;
}

/** Rounds to `places` decimals so the generated JSON has no float noise. */
export const round = (value: number, places = 2): number => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};
