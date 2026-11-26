export const CHART_WINDOW_MS = 60_000;

/** Build paths from real timestamps and leave a gap where samples could not be collected.
 * @param {{timestampMs: number, value: number | null}[]} samples
 * @param {number} end
 * @param {number} interval
 */
export function chartPath(samples, end, interval) {
  const start = end - CHART_WINDOW_MS;
  let lastTime = null;
  const commands = [];
  for (const { timestampMs, value } of samples) {
    if (timestampMs < start || timestampMs > end || value == null || !Number.isFinite(value)) {
      lastTime = null;
      continue;
    }
    const x = 2 + (timestampMs - start) / CHART_WINDOW_MS * 96;
    const y = 68 - Math.max(0, Math.min(100, value)) / 100 * 62;
    const point = `${x.toFixed(2)} ${y.toFixed(2)}`;
    const connected = lastTime != null && timestampMs > lastTime && timestampMs - lastTime <= interval * 2;
    commands.push(connected ? `L ${point}` : `M ${point} h 0`);
    lastTime = timestampMs;
  }
  return commands.join(" ");
}
