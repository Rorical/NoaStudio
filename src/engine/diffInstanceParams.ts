/**
 * Compare two snapshots of `instanceId → params[]` and emit the per-param
 * changes since the previous snapshot. Used by App.jsx to forward coordinator
 * param mutations into the engine via `engine.setParam`.
 *
 * Instances that appear only in `next` are skipped: they're new, and
 * `engine.loadPlugin`'s `initialParams` already covered their starting values.
 * Instances only in `prev` are also skipped — they've been unloaded.
 *
 * Length mismatches between prev and next (e.g. the manifest changed) are
 * compared by index up to the shorter length; extra indices are ignored.
 */
export interface InstanceParamChange {
  instanceId: string;
  paramIndex: number;
  value: number;
}

export function diffInstanceParams(
  prev: ReadonlyMap<string, readonly number[]>,
  next: ReadonlyMap<string, readonly number[]>,
): InstanceParamChange[] {
  const out: InstanceParamChange[] = [];
  for (const [instanceId, nextParams] of next) {
    const prevParams = prev.get(instanceId);
    if (!prevParams) continue;
    const n = Math.min(prevParams.length, nextParams.length);
    for (let i = 0; i < n; i++) {
      if (prevParams[i] !== nextParams[i]) {
        out.push({ instanceId, paramIndex: i, value: nextParams[i]! });
      }
    }
  }
  return out;
}
