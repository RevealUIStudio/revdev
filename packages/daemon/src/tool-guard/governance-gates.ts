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
