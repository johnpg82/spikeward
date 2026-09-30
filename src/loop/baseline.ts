// Exponentially weighted requests-per-minute baselines: one per hour of week, plus a
// zone-wide fallback used while the hour-of-week buckets warm up.

export interface Ewma {
  v: number;
  n: number;
}

export const HOW_ALPHA = 0.05;
export const GLOBAL_ALPHA = 0.02;
const HOW_MIN_SAMPLES = 30;
const GLOBAL_MIN_SAMPLES = 10;

export function updateEwma(prev: Ewma | null, x: number, alpha: number): Ewma {
  if (!prev || prev.n === 0) return { v: x, n: 1 };
  return { v: prev.v + alpha * (x - prev.v), n: prev.n + 1 };
}

/** The rpm we'd expect right now, or null while there isn't enough history to judge. */
export function expectedRpm(how: Ewma | null, global: Ewma | null): number | null {
  if (how && how.n >= HOW_MIN_SAMPLES) return how.v;
  if (global && global.n >= GLOBAL_MIN_SAMPLES) return global.v;
  return null;
}

export function isSpike(rpm: number, expected: number | null, multiple: number, floor: number): boolean {
  if (expected === null) return false;
  return rpm >= Math.max(expected * multiple, floor);
}

export function hourOfWeek(date: Date): number {
  return date.getUTCDay() * 24 + date.getUTCHours();
}
