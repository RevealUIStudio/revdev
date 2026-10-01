import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hasExemptLabel,
  indicatesNoWorkDone,
  isForkSafePromotionSkip,
  isWorkspaceRootPackage,
  parseLabels,
  typescriptRunArgs,
  verifyProveRedException,
} from './prove-red-lib.mjs';

// Regression lock for the GAP-393 review remediation
// (https://github.com/RevealUIStudio/revdev/pull/325#issuecomment-5080422951,
// https://github.com/RevealUIStudio/revdev/pull/327#issuecomment-5080489570):
// exact-match label semantics, a JSON-array PR_LABELS transport that never
// throws on malformed/absent input, a promotion-skip predicate that fires
// only for a same-repo test -> main PR and fails closed otherwise, and the
// TypeScript planner's root-vs-workspace-member routing plus the
// no-work-done detector that catches a silently-scored no-op filter match.

describe('parseLabels', () => {
  it('parses a JSON array of label names', () => {
    expect(parseLabels('["bug","verify:no-behavior-change"]')).toEqual([
      'bug',
      'verify:no-behavior-change',
    ]);
  });

  it('trims whitespace around each label', () => {
    expect(parseLabels('[" bug ", " verify:no-behavior-change "]')).toEqual([
      'bug',
      'verify:no-behavior-change',
    ]);
  });

  it('returns an empty array for an empty JSON array', () => {
    expect(parseLabels('[]')).toEqual([]);
  });

  it('returns an empty array when PR_LABELS is unset (undefined)', () => {
    expect(parseLabels(undefined)).toEqual([]);
  });

  it('returns an empty array for an empty string', () => {
    expect(parseLabels('')).toEqual([]);
  });

  it('does not throw and returns an empty array on malformed JSON', () => {
    expect(() => parseLabels('not json')).not.toThrow();
    expect(parseLabels('not json')).toEqual([]);
  });

  it('does not throw and returns an empty array on the legacy comma-joined transport', () => {
    // The workflows now send a JSON array (GAP-393 remediation); a plain
    // comma-joined string is not valid JSON and must degrade safely rather
    // than silently mis-parse.
    expect(() => parseLabels('bug,verify:no-behavior-change')).not.toThrow();
    expect(parseLabels('bug,verify:no-behavior-change')).toEqual([]);
  });

  it('returns an empty array when the JSON value is not an array', () => {
    expect(parseLabels('{"not":"an array"}')).toEqual([]);
    expect(parseLabels('"just a string"')).toEqual([]);
    expect(parseLabels('42')).toEqual([]);
  });

  it('drops empty-string entries after trimming', () => {
    expect(parseLabels('["", "  ", "bug"]')).toEqual(['bug']);
  });
});

describe('hasExemptLabel', () => {
  const EXEMPT = 'verify:no-behavior-change';

  it('matches an exact label', () => {
    expect(hasExemptLabel(['bug', EXEMPT, 'ci'], EXEMPT)).toBe(true);
  });

  it('does not match a near-miss superstring label', () => {
    expect(hasExemptLabel([`${EXEMPT}-not`], EXEMPT)).toBe(false);
  });

  it('does not match a prefix of the label', () => {
    expect(hasExemptLabel(['verify:no-behavior'], EXEMPT)).toBe(false);
  });

  it('does not match a case variant', () => {
    expect(hasExemptLabel(['Verify:No-Behavior-Change'], EXEMPT)).toBe(false);
  });

  it('does not match when the label list is empty', () => {
    expect(hasExemptLabel([], EXEMPT)).toBe(false);
  });
});

describe('isForkSafePromotionSkip', () => {
  const SAME_REPO = 'RevealUIStudio/revdev';
  const FORK_REPO = 'someone-else/revdev';

  it('fires for a same-repo test -> main PR', () => {
    expect(
      isForkSafePromotionSkip({
        headRef: 'test',
        baseRef: 'main',
        headRepo: SAME_REPO,
        baseRepo: SAME_REPO,
      }),
    ).toBe(true);
  });

  it('does not fire when the head repo is a fork (branch named "test" but different repo)', () => {
    expect(
      isForkSafePromotionSkip({
        headRef: 'test',
        baseRef: 'main',
        headRepo: FORK_REPO,
        baseRepo: SAME_REPO,
      }),
    ).toBe(false);
  });

  it('does not fire when the repo signal is entirely absent (e.g. a push event)', () => {
    expect(
      isForkSafePromotionSkip({
        headRef: undefined,
        baseRef: undefined,
        headRepo: undefined,
        baseRepo: undefined,
      }),
    ).toBe(false);
  });

  it('does not fire when head/base ref match but the repo env vars were never wired', () => {
    expect(
      isForkSafePromotionSkip({
        headRef: 'test',
        baseRef: 'main',
        headRepo: undefined,
        baseRepo: undefined,
      }),
    ).toBe(false);
  });

  it('does not fire for a feature branch into test', () => {
    expect(
      isForkSafePromotionSkip({
        headRef: 'fix/x',
        baseRef: 'test',
        headRepo: SAME_REPO,
        baseRepo: SAME_REPO,
      }),
    ).toBe(false);
  });

  it('does not fire for test -> test', () => {
    expect(
      isForkSafePromotionSkip({
        headRef: 'test',
        baseRef: 'test',
        headRepo: SAME_REPO,
        baseRepo: SAME_REPO,
      }),
    ).toBe(false);
  });

  it('does not fire when only the base ref matches (head ref is not "test")', () => {
    expect(
      isForkSafePromotionSkip({
        headRef: 'fix/renamed-to-main-by-mistake',
        baseRef: 'main',
        headRepo: SAME_REPO,
        baseRepo: SAME_REPO,
      }),
    ).toBe(false);
  });
});

// GAP-393 review remediation follow-up (#327): planTypescript resolved a
// root-owned test file's package to "revdev", which is not a pnpm workspace
// member (pnpm-workspace.yaml scopes to apps/*, packages/*). `pnpm --filter
// revdev exec vitest ...` matches nothing, prints "No projects matched the
// filters", and exits 0 — silently scored as a passing test that never ran.
describe('isWorkspaceRootPackage', () => {
  const REPO_ROOT = '/repo';

  it('is true when the package dir is the repo root', () => {
    expect(isWorkspaceRootPackage(REPO_ROOT, REPO_ROOT)).toBe(true);
  });

  it('is false for a workspace-member package dir', () => {
    expect(isWorkspaceRootPackage(`${REPO_ROOT}/packages/daemon`, REPO_ROOT)).toBe(false);
  });
});

describe('typescriptRunArgs', () => {
  const REPO_ROOT = '/repo';

  it('routes a workspace-member package through `pnpm --filter <name>`', () => {
    expect(
      typescriptRunArgs({
        pkgDir: `${REPO_ROOT}/packages/daemon`,
        pkgName: '@revdev/daemon',
        repoRoot: REPO_ROOT,
        relFile: 'src/foo.test.ts',
      }),
    ).toEqual({
      cmd: 'pnpm',
      args: [
        '--filter',
        '@revdev/daemon',
        'exec',
        'vitest',
        'run',
        '--no-coverage',
        'src/foo.test.ts',
      ],
    });
  });

  it('routes the workspace ROOT package through a filter-less root-level `pnpm exec`', () => {
    expect(
      typescriptRunArgs({
        pkgDir: REPO_ROOT,
        pkgName: 'revdev',
        repoRoot: REPO_ROOT,
        relFile: 'scripts/ci/prove-red-lib.test.mjs',
      }),
    ).toEqual({
      cmd: 'pnpm',
      args: ['exec', 'vitest', 'run', '--no-coverage', 'scripts/ci/prove-red-lib.test.mjs'],
    });
  });

  it('the root-level args never contain --filter, regardless of package name', () => {
    const { args } = typescriptRunArgs({
      pkgDir: REPO_ROOT,
      pkgName: 'revdev',
      repoRoot: REPO_ROOT,
      relFile: 'scripts/x.test.mjs',
    });
    expect(args.includes('--filter')).toBe(false);
  });
});

describe('indicatesNoWorkDone', () => {
  it('detects the pnpm no-match-filter message', () => {
    expect(indicatesNoWorkDone('No projects matched the filters in "/repo"\n')).toBe(true);
  });

  it('detects the marker as a substring within larger output', () => {
    expect(
      indicatesNoWorkDone(
        'some preamble\nNo projects matched the filters in "..."\nsome trailer\n',
      ),
    ).toBe(true);
  });

  it('does not fire on real vitest passing output', () => {
    expect(indicatesNoWorkDone('Test Files  1 passed (1)\n     Tests  21 passed (21)\n')).toBe(
      false,
    );
  });

  it('does not fire on real vitest failing output', () => {
    expect(
      indicatesNoWorkDone('Test Files  1 failed (1)\n     Tests  1 failed | 20 passed\n'),
    ).toBe(false);
  });

  it('does not throw and returns false for empty or absent output', () => {
    expect(() => indicatesNoWorkDone('')).not.toThrow();
    expect(indicatesNoWorkDone('')).toBe(false);
    expect(indicatesNoWorkDone(undefined)).toBe(false);
  });
});

describe('owner-signed prove-red exception boundary', () => {
  const event = {
    repository: { full_name: 'RevealUIStudio/revdev' },
    pull_request: {
      number: 270,
      head: { sha: 'a'.repeat(40) },
      base: { repo: { full_name: 'RevealUIStudio/revdev' } },
      labels: [{ name: 'verify:no-behavior-change' }],
    },
  };
  const comments = [{ body: 'signed fixture', url: 'https://github.com/comment/1' }];
  const base = {
    event,
    allowedSigners: 'owner@revealui.com ssh-ed25519 public',
    readComments: async () => comments,
  };
  it('a label alone cannot grant an exception without a trust anchor', async () => {
    let called = false;
    const result = await verifyProveRedException({
      ...base,
      allowedSigners: '',
      loadVerifier: async () => {
        called = true;
      },
    });
    expect(result).toEqual({ ok: false, reason: 'missing-owner-trust-anchor' });
    expect(called).toBe(false);
  });
  it('absence of the request does not load the package or fetch comments', async () => {
    const result = await verifyProveRedException({
      ...base,
      event: { ...event, pull_request: { ...event.pull_request, labels: [] } },
      loadVerifier: async () => {
        throw new Error('must not load');
      },
    });
    expect(result).toEqual({ ok: false, reason: 'no-request-label' });
  });
  it('reconstructs exact gate context from the event and preserves grant receipt', async () => {
    const result = await verifyProveRedException({
      ...base,
      readComments: async (repo, pr) => {
        expect(repo).toBe('RevealUIStudio/revdev');
        expect(pr).toBe(270);
        return comments;
      },
      loadVerifier: async () => (input) => {
        expect(input).toEqual({
          comments,
          allowedSigners: base.allowedSigners,
          expected: {
            repo: 'RevealUIStudio/revdev',
            pr: 270,
            head: 'a'.repeat(40),
            gate: 'prove-red',
          },
        });
        return { ok: true, url: comments[0].url };
      },
    });
    expect(result).toEqual({ ok: true, url: comments[0].url });
  });
  it('accepts a synthetic owner signature through the installed shared package and rejects another head', async () => {
    const {
      OWNER_OVERRIDE_IDENTITY,
      OWNER_OVERRIDE_NAMESPACE,
      buildOwnerOverrideComment,
      buildOwnerOverridePayload,
    } = await import('@revealui/harnesses/gates');
    const root = mkdtempSync(join(tmpdir(), 'revdev-prove-red-signature-'));
    const keyPath = join(root, 'fixture-key');
    const payloadPath = join(root, 'payload');
    try {
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath]);
      const publicKey = readFileSync(`${keyPath}.pub`, 'utf8').trim().split(/\s+/);
      const allowedSigners =
        `${OWNER_OVERRIDE_IDENTITY} namespaces="${OWNER_OVERRIDE_NAMESPACE}" ` +
        `${publicKey[0]} ${publicKey[1]}`;
      const expected = {
        repo: 'RevealUIStudio/revdev',
        pr: 270,
        head: 'a'.repeat(40),
        gate: 'prove-red',
      };
      const payload = buildOwnerOverridePayload(expected, '2099-12-31');
      writeFileSync(payloadPath, payload);
      execFileSync(
        'ssh-keygen',
        ['-Y', 'sign', '-f', keyPath, '-n', OWNER_OVERRIDE_NAMESPACE, payloadPath],
        { cwd: root },
      );
      const signature = readFileSync(`${payloadPath}.sig`, 'utf8').trimEnd();
      const signedComment = buildOwnerOverrideComment(payload, signature);
      const actual = await verifyProveRedException({
        ...base,
        allowedSigners,
        readComments: async () => [
          { body: signedComment, url: 'https://github.com/comment/signed' },
        ],
      });
      expect(actual).toEqual({ ok: true, url: 'https://github.com/comment/signed' });

      const wrongHead = await verifyProveRedException({
        ...base,
        event: {
          ...event,
          pull_request: { ...event.pull_request, head: { sha: 'b'.repeat(40) } },
        },
        allowedSigners,
        readComments: async () => [{ body: signedComment }],
      });
      expect(wrongHead).toEqual({ ok: false, reason: 'wrong-context' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each([
    'stale-head',
    'forged-signature',
    'wrong-gate',
    'expired',
  ])('propagates shared rejection: %s', async (reason) => {
    expect(
      await verifyProveRedException({
        ...base,
        loadVerifier: async () => () => ({ ok: false, reason }),
      }),
    ).toEqual({ ok: false, reason });
  });
  it('missing published shared verifier fails closed', async () => {
    expect(await verifyProveRedException({ ...base, loadVerifier: async () => undefined })).toEqual(
      { ok: false, reason: 'shared-verifier-unavailable' },
    );
  });
  it('API or package failure fails closed', async () => {
    expect(
      await verifyProveRedException({
        ...base,
        loadVerifier: async () => {
          throw new Error('unpublished package');
        },
      }),
    ).toEqual({ ok: false, reason: 'shared-verifier-or-comments-unavailable' });
  });
  it('rejects inconsistent base-repository event context', async () => {
    expect(
      await verifyProveRedException({
        ...base,
        event: { ...event, repository: { full_name: 'attacker/fork' } },
      }),
    ).toEqual({ ok: false, reason: 'invalid-pull-request-context' });
  });
});

// A synthetic pnpm transport runs the fixture's real Node assertion. This
// checks the gate's subprocess order without compiling Studio or downloading
// a toolchain; it never enters the product or operational dependency path.
describe('prove-red script ordering', () => {
  it.each([
    ['red', 2, 0],
    ['inert', 1, 1],
  ])(
    '%s tests run despite the request label',
    (kind, expected, exit) => {
      const root = mkdtempSync(join(tmpdir(), 'revdev-prove-red-order-'));
      try {
        const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
        git('init', '-q');
        git('config', 'user.email', 'fixture@example.invalid');
        git('config', 'user.name', 'Fixture');
        writeFileSync(join(root, 'package.json'), '{"name":"fixture"}');
        writeFileSync(join(root, 'value.js'), 'module.exports = 1;');
        git('add', '.');
        git('commit', '-qm', 'base');
        const baseSha = git('rev-parse', 'HEAD').trim();
        writeFileSync(join(root, 'value.js'), 'module.exports = 2;');
        writeFileSync(
          join(root, 'value.test.js'),
          `require('node:assert/strict').equal(require('./value.js'), ${expected});`,
        );
        git('add', '.');
        git('commit', '-qm', kind);
        mkdirSync(join(root, 'bin'));
        writeFileSync(
          join(root, 'bin/pnpm'),
          '#!/usr/bin/env node\n' +
            'if(process.env.GH_TOKEN||process.env.GITHUB_TOKEN||process.env.REVFLEET_OVERRIDE_SIGNERS)process.exit(91);\n' +
            'const {spawnSync}=require("node:child_process");\n' +
            'const r=spawnSync(process.execPath,["value.test.js"],{stdio:"inherit"});process.exitCode=r.status;\n',
          { mode: 0o755 },
        );
        const result = spawnSync(
          process.execPath,
          [new URL('./prove-red.mjs', import.meta.url).pathname],
          {
            cwd: root,
            encoding: 'utf8',
            timeout: 20000,
            env: {
              ...process.env,
              PATH: `${join(root, 'bin')}:${process.env.PATH}`,
              BASE_REF: baseSha,
              GH_TOKEN: 'read-only-fixture-token',
              GITHUB_TOKEN: 'read-only-fixture-token',
              PROVE_RED_LANGS: 'typescript',
              PR_LABELS: '["verify:no-behavior-change"]',
              GITHUB_EVENT_PATH: '',
              REVFLEET_OVERRIDE_SIGNERS: 'fixture-owner-anchor',
            },
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(exit);
        expect(result.stdout).toContain('running fixture (root, not a workspace member)');
        if (exit === 0)
          expect(result.stdout).toContain('all active languages carry failing-first evidence');
        else expect(result.stderr).toContain('no trusted pull-request event');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30000,
  );
});
