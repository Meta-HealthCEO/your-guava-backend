const { monitorEventLoopDelay } = require('node:perf_hooks');

const MB = 1024 * 1024;
const LOOP_RESOLUTION_MS = 10;

/**
 * Runs `fn` and reports what it cost: wall time, V8 heap growth and the
 * longest event-loop stall seen while it ran. The BE-01 DoS budgets are
 * asserted on these numbers. Heap growth is heapUsed after minus before, so a
 * collection mid-run can make it negative; it bounds what the run kept, not
 * its peak. Buffers live outside the V8 heap and do not count.
 */
const measureBudget = async (fn) => {
  const loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  loop.enable();
  const heapBefore = process.memoryUsage().heapUsed;
  const started = process.hrtime.bigint();
  let result;
  let error;
  try {
    result = await fn();
  } catch (caught) {
    error = caught;
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const heapGrowthMb = (process.memoryUsage().heapUsed - heapBefore) / MB;
  // One more tick so a stall at the very end is sampled before we stop.
  await new Promise((resolve) => setTimeout(resolve, LOOP_RESOLUTION_MS * 2));
  loop.disable();
  const maxLoopDelayMs = loop.count > 0 ? loop.max / 1e6 : elapsedMs;
  return { result, error, elapsedMs, heapGrowthMb, maxLoopDelayMs };
};

module.exports = { measureBudget };
