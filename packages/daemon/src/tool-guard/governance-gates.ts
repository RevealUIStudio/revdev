/**
 * GAP-375 — RevDev-native governance gates (provider-agnostic).
 *
 * In-loop pair of Claude PreToolUse sec-review-audit-gate + disposition-actions.
 * Pure, sync, no IO. Wired from evaluateToolAction for `command` actions.
 *
 * Control-layer SSOT for the same pure API lives in
 * `@revealui/harnesses/gates` (sec-review-label-gate + disposition-command-gate).
 * This module is the daemon-side consumer copy so the daemon does not take a
 * hard runtime dep on harnesses publish lag; keep semantics lockstep with
 * harnesses tests.
 *
 * Zero authored regex.
 */

export const SEC_REVIEW_APPROVED_LABEL = 'sec-review:approved';

function shellSegments(command: string): string[] {
  const out: string[] = [];
  let buf = '';
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      i += 1;
      continue;
    }
    if (ch === '\n' || ch === ';' || ch === '|') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function tokenize(s: string): string[] {
  const parts: string[] = [];
  let cur = '';
  for (const ch of s) {
    if (ch === ' ' || ch === '\t') {
      if (cur) {
        parts.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

function isAllDigits(s: string): boolean {
  if (s.length === 0) return false;
  for (const ch of s) {
    if (ch < '0' || ch > '9') return false;
  }
  return true;
}

function segmentIsLabelAdd(s: string): boolean {
  if (!s.includes('pr') || !s.includes('edit')) return false;
  const parts = tokenize(s);
  let sawGh = false;
  let sawPr = false;
  let sawEdit = false;
  let sawAddLabel = false;
  for (const p of parts) {
    if (p === 'gh') sawGh = true;
    else if (sawGh && p === 'pr') sawPr = true;
    else if (sawPr && p === 'edit') sawEdit = true;
    else if (p === '--add-label' || p.startsWith('--add-label=')) sawAddLabel = true;
  }
  if (!(sawGh && sawPr && sawEdit && sawAddLabel)) return false;
  return s.includes(SEC_REVIEW_APPROVED_LABEL);
}

export function isSecReviewApprovedLabelAdd(command: string): boolean {
  if (typeof command !== 'string' || command.length === 0) return false;
  for (const seg of shellSegments(command)) {
    let candidate = seg.trim();
    const ghSpace = candidate.indexOf(' gh ');
    if (ghSpace >= 0 && !candidate.startsWith('gh ') && !candidate.startsWith('gh\t')) {
      candidate = candidate.slice(ghSpace + 1).trim();
    }
    if (segmentIsLabelAdd(candidate)) return true;
  }
  return false;
}

function segmentIsGhPrMerge(s: string): boolean {
  const parts = tokenize(s);
  let sawGh = false;
  let sawPr = false;
  for (const p of parts) {
    if (p === 'gh') sawGh = true;
    else if (sawGh && p === 'pr') sawPr = true;
    else if (sawPr && p === 'merge') return true;
  }
  return false;
}

export function isGhPrMergeCommand(command: string): boolean {
  if (typeof command !== 'string' || command.length === 0) return false;
  for (const seg of shellSegments(command)) {
    const s = seg.trim();
    if (segmentIsGhPrMerge(s)) return true;
    const ghIdx = s.indexOf(' gh ');
    if (ghIdx >= 0 && segmentIsGhPrMerge(s.slice(ghIdx + 1).trim())) return true;
  }
  return false;
}

export function isSecuritySelfClearCommand(command: string): boolean {
  if (typeof command !== 'string' || command.length === 0) return false;
  const lower = command.toLowerCase();
  if (
    lower.includes('gh') &&
    lower.includes('pr') &&
    lower.includes('review') &&
    lower.includes('dismiss')
  ) {
    return true;
  }
  if (
    lower.includes('gh') &&
    lower.includes('pr') &&
    lower.includes('edit') &&
    lower.includes('--remove-label') &&
    lower.includes('sec-review')
  ) {
    return true;
  }
  return false;
}

export interface GovernanceVerdict {
  allowed: boolean;
  rule?: string;
  reason?: string;
}

/**
 * Evaluate agent shell command against disposition + sec-review label policy.
 * Fail-closed on sec-review:approved label-add (no live check rollup in the
 * sync tool-guard path — owner/override must clear). Matches Claude gate
 * fail-closed when audit cannot be verified.
 */
export function evaluateGovernanceCommand(command: string): GovernanceVerdict {
  if (isGhPrMergeCommand(command)) {
    return {
      allowed: false,
      rule: 'disposition-no-merge',
      reason:
        'Agents propose; the owner disposes merges (disposition-actions). Do not run `gh pr merge` from an agent tool path.',
    };
  }
  if (isSecuritySelfClearCommand(command)) {
    return {
      allowed: false,
      rule: 'disposition-no-self-clear',
      reason:
        'Agents must not dismiss security reviews or remove sec-review labels. Owner disposes gate-clearing actions.',
    };
  }
  if (isSecReviewApprovedLabelAdd(command)) {
    if (process.env.SEC_REVIEW_AUDIT_OVERRIDE === '1') {
      return { allowed: true };
    }
    return {
      allowed: false,
      rule: 'sec-review-label-withhold',
      reason:
        'sec-review:approved withheld on agent tool path until security audit is verified green (or SEC_REVIEW_AUDIT_OVERRIDE=1). Prefer CI required checks + owner label apply.',
    };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Async path: live gh statusCheckRollup for label-add (GAP-375 residual)
// ---------------------------------------------------------------------------

export interface StatusCheckLike {
  name?: string | null;
  conclusion?: string | null;
  state?: string | null;
}

const REQUIRED_SECURITY_AUDIT_CHECKS = [
  'Security Gate',
  'CodeQL',
  'Secret Scanning (Gitleaks)',
  'Dependency Review',
] as const;

const FAILING = new Set([
  'FAILURE',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'ERROR',
  'CANCELLED',
]);

/** Parse PR number + optional -R repo from a gh pr edit command (no authored regex). */
export function parseGhPrEditTarget(command: string): {
  pr: string | null;
  repo: string | null;
  cwd: string | null;
} {
  let repo: string | null = null;
  let pr: string | null = null;
  let cwd: string | null = null;

  const parts = tokenize(command);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] as string;
    if (p === 'cd' && parts[i + 1]) {
      cwd = (parts[i + 1] as string).replace(/^~/, process.env.HOME ?? '');
    }
    if ((p === '-R' || p === '--repo') && parts[i + 1]) {
      repo = parts[i + 1] as string;
    }
    if (p.startsWith('--repo=')) {
      repo = p.slice('--repo='.length);
    }
    if (p === 'edit') {
      for (let j = i + 1; j < parts.length; j++) {
        const t = parts[j] as string;
        if (isAllDigits(t)) {
          pr = t;
          break;
        }
        // pull/N URL fragment
        const marker = '/pull/';
        const idx = t.indexOf(marker);
        if (idx >= 0) {
          const rest = t.slice(idx + marker.length);
          let num = '';
          for (const ch of rest) {
            if (ch >= '0' && ch <= '9') num += ch;
            else break;
          }
          if (num) {
            pr = num;
            break;
          }
        }
      }
    }
  }
  return { pr, repo, cwd };
}

export function evaluateSecurityAuditRollup(
  rollup: readonly StatusCheckLike[] | null | undefined,
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const list = rollup ?? [];
  for (const name of REQUIRED_SECURITY_AUDIT_CHECKS) {
    const entries = list.filter((c) => c && c.name === name);
    if (entries.length === 0) {
      problems.push(`${name}: missing`);
      continue;
    }
    const bad = entries.find(
      (c) => FAILING.has(c.conclusion ?? '') || FAILING.has(c.state ?? ''),
    );
    if (bad) {
      problems.push(`${name}: ${bad.conclusion || bad.state || 'failing'}`);
      continue;
    }
    const success = entries.some(
      (c) =>
        (c.conclusion === 'SUCCESS' || c.state === 'SUCCESS') &&
        !FAILING.has(c.conclusion ?? '') &&
        !FAILING.has(c.state ?? ''),
    );
    if (!success) problems.push(`${name}: not green`);
  }
  return { ok: problems.length === 0, problems };
}

export type FetchPrStatusRollup = (args: {
  pr: string;
  repo: string | null;
  cwd: string | null;
}) => Promise<StatusCheckLike[] | null>;

/**
 * Async governance evaluation. For sec-review:approved label-add, optionally
 * fetches live statusCheckRollup (default: `gh pr view --json statusCheckRollup`)
 * and allows the command when audit is green.
 */
export async function evaluateGovernanceCommandAsync(
  command: string,
  options: {
    fetchRollup?: FetchPrStatusRollup;
    override?: boolean;
  } = {},
): Promise<GovernanceVerdict> {
  // Disposition blocks remain sync / unconditional
  if (isGhPrMergeCommand(command)) {
    return evaluateGovernanceCommand(command);
  }
  if (isSecuritySelfClearCommand(command)) {
    return evaluateGovernanceCommand(command);
  }

  if (!isSecReviewApprovedLabelAdd(command)) {
    return evaluateGovernanceCommand(command);
  }

  const override = options.override ?? process.env.SEC_REVIEW_AUDIT_OVERRIDE === '1';
  if (override) {
    return { allowed: true };
  }

  const { pr, repo, cwd } = parseGhPrEditTarget(command);
  if (!pr) {
    return {
      allowed: false,
      rule: 'sec-review-label-withhold',
      reason:
        'sec-review audit gate: could not parse PR number from sec-review:approved command. Fail-closed.',
    };
  }

  const fetchRollup =
    options.fetchRollup ??
    (async ({ pr: prNum, repo: r, cwd: dir }) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      const args = ['pr', 'view', prNum, '--json', 'statusCheckRollup'];
      if (r) args.push('-R', r);
      try {
        const { stdout } = await execFileAsync('gh', args, {
          timeout: 8000,
          cwd: !r && dir ? dir : undefined,
          maxBuffer: 2 * 1024 * 1024,
        });
        const parsed = JSON.parse(stdout) as { statusCheckRollup?: StatusCheckLike[] };
        return parsed.statusCheckRollup ?? [];
      } catch {
        return null;
      }
    });

  const rollup = await fetchRollup({ pr, repo, cwd });
  if (rollup == null) {
    return {
      allowed: false,
      rule: 'sec-review-label-withhold',
      reason: `sec-review audit gate: could not verify security audit for PR #${pr} (gh unavailable). Fail-closed. Override with SEC_REVIEW_AUDIT_OVERRIDE=1.`,
    };
  }

  const { ok, problems } = evaluateSecurityAuditRollup(rollup);
  if (!ok) {
    return {
      allowed: false,
      rule: 'sec-review-label-withhold',
      reason:
        `sec-review audit gate — PR #${pr} security audit is NOT green; label withheld:\n  ` +
        problems.join('\n  '),
    };
  }

  return { allowed: true };
}
