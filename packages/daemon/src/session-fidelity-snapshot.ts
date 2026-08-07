/**
 * GAP-342 — five-section session fidelity snapshot shape + prune policy.
 *
 * Portable with the Claude-side /snapshot skill (GAP-317 five sections).
 * Store/serve is id-match only (never mtime heuristic).
 */

export const FIDELITY_SECTION_KEYS = [
  'resumeFromHere',
  'whatShipped',
  'activeConstraints',
  'doNotRepeat',
  'openLooseEnds',
] as const;

export type FidelitySectionKey = (typeof FIDELITY_SECTION_KEYS)[number];

export type FidelitySections = Record<FidelitySectionKey, string>;

/** Default retention for automatic prune (GAP-317 Step 5d parity). */
export const SNAPSHOT_RETENTION_DAYS = 7;

export function emptyFidelitySections(): FidelitySections {
  return {
    resumeFromHere: '',
    whatShipped: '',
    activeConstraints: '',
    doNotRepeat: '',
    openLooseEnds: '',
  };
}

/**
 * Normalize/validate sections object. Missing keys become empty strings.
 * Unknown keys are ignored (forward-compatible). Non-string values rejected.
 */
export function normalizeFidelitySections(input: unknown): FidelitySections {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('sections must be an object with the five fidelity fields');
  }
  const raw = input as Record<string, unknown>;
  const out = emptyFidelitySections();
  for (const key of FIDELITY_SECTION_KEYS) {
    if (!(key in raw)) continue;
    const v = raw[key];
    if (typeof v !== 'string') {
      throw new Error(`sections.${key} must be a string`);
    }
    out[key] = v;
  }
  // Require at least one non-empty section so empty writes fail loud
  const any = FIDELITY_SECTION_KEYS.some((k) => out[k].trim().length > 0);
  if (!any) {
    throw new Error('sections must include at least one non-empty fidelity field');
  }
  return out;
}

export function retentionCutoffIso(
  now: Date = new Date(),
  maxAgeDays: number = SNAPSHOT_RETENTION_DAYS,
): string {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    throw new Error('maxAgeDays must be a positive number');
  }
  const ms = maxAgeDays * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() - ms).toISOString();
}
