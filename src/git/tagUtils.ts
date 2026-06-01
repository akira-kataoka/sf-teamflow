/** Find the highest existing vMAJOR.MINOR.PATCH tuple, or undefined if none parse. */
function highestVersion(existing: string[]): [number, number, number] | undefined {
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
  return best;
}

/**
 * Suggest the next semver tag from existing ones: the highest vMAJOR.MINOR.PATCH
 * gets its patch bumped; if none match, start at v1.0.0. Pure & unit-tested.
 */
export function suggestNextTag(existing: string[]): string {
  const best = highestVersion(existing);
  if (!best) {
    return "v1.0.0";
  }
  return `v${best[0]}.${best[1]}.${best[2] + 1}`;
}

/** Next-tag suggestions for each semver bump level, plus the current highest. */
export interface NextTagSuggestions {
  /** Highest existing tag (normalized `vX.Y.Z`), or undefined if there are none yet. */
  current?: string;
  /** Bug fix: bump patch (`vX.Y.(Z+1)`). */
  patch: string;
  /** New feature: bump minor, reset patch (`vX.(Y+1).0`). */
  minor: string;
  /** Breaking change: bump major, reset minor/patch (`v(X+1).0.0`). */
  major: string;
}

/**
 * Compute patch/minor/major next-tag candidates from existing tags so the UI can
 * let the user pick the semver intent (fix vs feature vs breaking) instead of
 * always assuming a patch. When no tags exist yet, all three default to v1.0.0
 * and `current` is undefined. Pure & unit-tested.
 */
export function suggestNextTags(existing: string[]): NextTagSuggestions {
  const best = highestVersion(existing);
  if (!best) {
    return { patch: "v1.0.0", minor: "v1.0.0", major: "v1.0.0" };
  }
  const [maj, min, pat] = best;
  return {
    current: `v${maj}.${min}.${pat}`,
    patch: `v${maj}.${min}.${pat + 1}`,
    minor: `v${maj}.${min + 1}.0`,
    major: `v${maj + 1}.0.0`,
  };
}
