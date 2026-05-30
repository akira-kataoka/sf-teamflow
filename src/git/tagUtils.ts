/**
 * Suggest the next semver tag from existing ones: the highest vMAJOR.MINOR.PATCH
 * gets its patch bumped; if none match, start at v1.0.0. Pure & unit-tested.
 */
export function suggestNextTag(existing: string[]): string {
  let best: [number, number, number] | undefined;
  for (const t of existing) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(t.trim());
    if (!m) {
      continue;
    }
    const v: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (
      !best ||
      v[0] > best[0] ||
      (v[0] === best[0] && v[1] > best[1]) ||
      (v[0] === best[0] && v[1] === best[1] && v[2] > best[2])
    ) {
      best = v;
    }
  }
  if (!best) {
    return "v1.0.0";
  }
  return `v${best[0]}.${best[1]}.${best[2] + 1}`;
}
