/**
 * Locks the signature-enforcement set against drift (zero-9P security review).
 *
 * Every file/git method that WRITES or returns file CONTENT must be in
 * MUTATING_OR_CONTENT_METHODS so the dispatch loop requires a valid signature
 * (-32003 otherwise). Adding a new content/mutation handler without adding it
 * here would silently let an unsigned caller invoke it — this test fails the
 * build in that case. The Rust client's `requires_signature` set
 * (apps/studio/src-tauri/src/signing.rs) must be kept in lockstep with this
 * list.
 */

import { describe, expect, it } from 'vitest';
import { MUTATING_OR_CONTENT_METHODS } from '../server.js';

const SIGNED = [
  'file.read',
  'file.write',
  'file.delete',
  'file.stat',
  'git.stageFile',
  'git.unstageFile',
  'git.discardFile',
  'git.createBranch',
  'git.switchBranch',
  'git.deleteBranch',
  'git.commit',
  'git.push',
  'git.pull',
  'git.diffFile',
  'git.diffContent',
  'git.readBlobAtHead',
  'git.readBlobAtIndex',
  // Root registration: signature-required so the root is recorded under the
  // verified signer (per-agent root scoping), not a spoofable param.
  'project.open',
  // git metadata reads: signature-required so they are scoped to the verified
  // signer (no cross-agent branch/history/dirty-path leak — review B-1).
  'git.status',
  'git.listBranches',
  'git.log',
  // worktree mutations: shell `git worktree add/remove` as the daemon UID, so
  // signature-required (B-WT). Handlers live in filegit.ts behind requireRoot.
  'worktree.create',
  'worktree.remove',
  // Key rotation: PoP — signed by the current key, paramsHash binds new key.
  'identity.rotate',
  // Grant/revoke cross-agent root access: owner-only, signature-required.
  'project.grant',
  'project.revoke',
  // agent.* PTY/exec surface: agent.spawn forks a caller-supplied command as the
  // daemon UID (unsigned-RCE) and stop/input/resize/output drive another agent's
  // live PTY. Signature-required so the actor is the verified signer, not a
  // spoofable actorAgentId (2026-06-29 Part B findings).
  'agent.spawn',
  'agent.stop',
  'agent.input',
  'agent.resize',
  'agent.output',
  // session.end evicts the target's roots and kills its PTYs, and is self-scoped
  // to the verified signer. Signature-required so the signer IS the target.
  'session.end',
];

// Only payload-free, repo-agnostic coordination methods stay signature-OPTIONAL.
const OPTIONAL = ['ping', 'session.list'];

describe('signature-required method set (zero-9P)', () => {
  for (const m of SIGNED) {
    it(`requires a signature for "${m}"`, () => {
      expect(MUTATING_OR_CONTENT_METHODS.has(m)).toBe(true);
    });
  }

  for (const m of OPTIONAL) {
    it(`does not require a signature for "${m}"`, () => {
      expect(MUTATING_OR_CONTENT_METHODS.has(m)).toBe(false);
    });
  }

  it('is EXACTLY the enumerated set (no silent additions)', () => {
    expect([...MUTATING_OR_CONTENT_METHODS].sort()).toEqual([...SIGNED].sort());
  });
});
