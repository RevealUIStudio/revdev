import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  csv,
  generate,
  goRecords,
  license,
  nodeRecords,
  publish,
  rustRecords,
} from './generate-notice.mjs';

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'notice-test-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'NOTICE.md'), 'existing notice');
  return dir;
}
test('missing tools preserve an existing notice', () => {
  const dir = fixture();
  expect(() =>
    generate(dir, () => {
      throw new Error('missing tool');
    }),
  ).toThrow('missing tool');
  expect(readFileSync(join(dir, 'NOTICE.md'), 'utf8')).toBe('existing notice');
});
test('all production Node workspace graphs must be attributed, including transitive optional dependencies', () => {
  const graph = [
    {
      dependencies: {
        a: { from: 'a', version: '1', optionalDependencies: { b: { name: 'b', version: '2' } } },
      },
    },
    { dependencies: { c: { name: 'c', version: '3' } } },
  ];
  const grouped = {
    MIT: [
      { name: 'a', versions: ['1'] },
      { name: 'b', versions: ['2'] },
    ],
  };
  expect(() => nodeRecords(graph, grouped, new Set())).toThrow('c@3');
  grouped.MIT.push({ name: 'c', versions: ['3'] });
  expect(nodeRecords(graph, grouped, new Set()).size).toBe(3);
});
test.each([
  '',
  'UNKNOWN',
  'UNLICENSED',
  '(see go.sum)',
  'MIT*',
])('rejects placeholder license %s', (value) => expect(() => license(value)).toThrow());
test('Rust metadata inventory cannot silently disappear from cargo-about output', () => {
  const metadata = {
    packages: [{ name: 'crate', version: '1', source: 'registry' }],
    resolve: { nodes: [] },
  };
  expect(() => rustRecords(metadata, { licenses: [] })).toThrow('crate@1');
  expect(
    rustRecords(metadata, {
      licenses: [
        { id: 'MIT', text: 'license text', used_by: [{ crate: { name: 'crate', version: '1' } }] },
      ],
    }).get('crate@1'),
  ).toBe('MIT');
});
test('Go requires every external imported package to have a license root', () => {
  const packages = [{ ImportPath: 'example.org/lib/sub', Module: { Path: 'example.org/lib' } }];
  expect(() => goRecords(packages, '')).toThrow('example.org/lib/sub');
  expect(
    goRecords(packages, 'example.org/lib,https://example.org/LICENSE,MIT\n').get('example.org/lib'),
  ).toBe('MIT');
  expect(() => goRecords(packages, 'example.org/lib,,MIT\n')).toThrow();
});
test('CSV quoted commas do not shift license columns', () =>
  expect(csv('a,"https://example.org/a,b",MIT\n')).toEqual([
    ['a', 'https://example.org/a,b', 'MIT'],
  ]));
test('check mode refuses stale notices without modifying them; publication leaves no temp artifacts', () => {
  const dir = fixture();
  expect(() => publish(dir, 'verified', true)).toThrow('stale');
  expect(readFileSync(join(dir, 'NOTICE.md'), 'utf8')).toBe('existing notice');
  publish(dir, 'verified');
  expect(readFileSync(join(dir, 'NOTICE.md'), 'utf8')).toBe('verified');
  publish(dir, 'verified', true);
});

test('a successful tool with incomplete output still preserves the current notice', () => {
  const dir = fixture();
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'workspace', dependencies: { missing: '1' } }),
  );
  const run = (_tool, args) => {
    if (args[0] === 'list')
      return JSON.stringify([
        {
          name: 'workspace',
          path: dir,
          dependencies: { missing: { name: 'missing', version: '1' } },
        },
      ]);
    if (args[0] === 'licenses') return '{}';
    return '';
  };
  expect(() => generate(dir, run)).toThrow('missing@1');
  expect(readFileSync(join(dir, 'NOTICE.md'), 'utf8')).toBe('existing notice');
});

function completeFixture(lateFailure = false, junk = false) {
  const dir = fixture();
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'workspace', dependencies: { nodeDep: '1' } }),
  );
  writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname="fixture"\n');
  writeFileSync(join(dir, 'go.mod'), 'module example.org/app\n');
  const run = (tool, args) => {
    if (tool === 'pnpm' && args[0] === 'list')
      return JSON.stringify([
        {
          name: 'workspace',
          path: dir,
          dependencies: { nodeDep: { from: 'nodeDep', version: '1' } },
        },
      ]);
    if (tool === 'pnpm' && args[0] === 'licenses')
      return JSON.stringify({ MIT: [{ name: 'nodeDep', versions: ['1'] }] });
    if (tool === 'cargo' && args[0] === 'metadata')
      return JSON.stringify({
        packages: [{ name: 'rustDep', version: '2', source: 'registry' }],
        resolve: { nodes: [] },
      });
    if (tool === 'cargo-about' && args[0] === 'generate') {
      expect(args).toContain('--fail');
      expect(args).toContain('--locked');
      return JSON.stringify({
        licenses: [
          {
            id: 'Apache-2.0',
            text: 'fixture license',
            used_by: [{ crate: { name: 'rustDep', version: '2' } }],
          },
        ],
      });
    }
    if (tool === 'go' && args[0] === 'list')
      return (
        JSON.stringify({
          ImportPath: 'example.org/goDep/sub',
          Module: { Path: 'example.org/goDep' },
        }) + (junk ? 'trailing junk' : '')
      );
    if (tool === 'go-licenses' && args[0] === 'report')
      return lateFailure ? '' : 'example.org/goDep,https://example.org/LICENSE,BSD-3-Clause\n';
    return '';
  };
  return { dir, run };
}
test('complete all-language synthetic generation publishes deterministic attribution and passes check', () => {
  const { dir, run } = completeFixture();
  generate(dir, run);
  const notice = readFileSync(join(dir, 'NOTICE.md'), 'utf8');
  expect(notice).toContain('| nodeDep@1 | MIT |');
  expect(notice).toContain('| rustDep@2 | Apache-2.0 |');
  expect(notice).toContain('| example.org/goDep | BSD-3-Clause |');
  generate(dir, run, true);
});
test('late Go omissions cannot publish otherwise complete Node and Rust output', () => {
  const { dir, run } = completeFixture(true);
  expect(() => generate(dir, run)).toThrow('missing attribution');
  expect(readFileSync(join(dir, 'NOTICE.md'), 'utf8')).toBe('existing notice');
});
test('Go inventory trailing junk cannot pass completeness', () => {
  const { dir, run } = completeFixture(false, true);
  expect(() => generate(dir, run)).toThrow('Incomplete Go JSON');
  expect(readFileSync(join(dir, 'NOTICE.md'), 'utf8')).toBe('existing notice');
});
