import { getHeapStatistics } from "node:v8";
import { Semaphore } from "../util/async.js";

/**
 * Process-wide memory admission for all crawlers in one process. Production ran out of heap
 * repeatedly (5 crawlers x 4 jobs, bodies up to 20 MB, each copied several times while parsing).
 * Crawlers stop leasing new work above the high-water mark and resume below the low-water mark;
 * large bodies are parsed a few at a time. A memory spike becomes a short slowdown, not a crash.
 */
const HIGH = Number(process.env.CRAWL_HEAP_HIGH ?? 0.7);
const LOW = Number(process.env.CRAWL_HEAP_LOW ?? 0.55);
export const LARGE_BODY_BYTES = Number(process.env.CRAWL_LARGE_BODY_BYTES ?? 4 * 1024 * 1024);
const largeBodies = new Semaphore(Number(process.env.CRAWL_LARGE_BODY_SLOTS ?? 2), 1000);

let paused = false;
let pausedSince: number | null = null;
let pauses = 0;

export function heapPressure(): number {
  const s = getHeapStatistics();
  return s.used_heap_size / s.heap_size_limit;
}

/** True when a crawler may lease more work now (hysteresis between LOW and HIGH). */
let pressureSource: () => number = heapPressure;
export function admitWork(pressure = pressureSource()): boolean {
  if (paused) {
    if (pressure < LOW) {
      paused = false;
      pausedSince = null;
    }
  } else if (pressure > HIGH) {
    paused = true;
    pausedSince = Date.now();
    pauses++;
  }
  return !paused;
}

/** Run fn holding a large-body slot when the body is large; small bodies pass straight through. */
export function withBodyBudget<T>(bytes: number, fn: () => Promise<T>): Promise<T> {
  return bytes >= LARGE_BODY_BYTES ? largeBodies.run(fn) : fn();
}

export function memoryStatus() {
  return { heapPressure: Number(heapPressure().toFixed(3)), paused, pausedForMs: pausedSince ? Date.now() - pausedSince : 0, pauses, high: HIGH, low: LOW, largeBodies: largeBodies.stats };
}

/** Tests only. */
export function __setPressureSource(fn: (() => number) | null) {
  pressureSource = fn ?? heapPressure;
}
export function __resetMemoryGuard() {
  pressureSource = heapPressure;
  paused = false;
  pausedSince = null;
  pauses = 0;
}
