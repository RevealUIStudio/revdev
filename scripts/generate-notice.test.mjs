import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  csv,
  GO_RELEASE_TARGETS,
  generate,
  goRecords,
  license,
  licenseFiles,
  nodeRecords,
  prepareTools,
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
        {
          id: 'MIT',
          source_path: '/synthetic/LICENSE',
          text: 'license text',
          used_by: [{ crate: { name: 'crate', version: '1' } }],
        },
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
    if (_tool === 'cargo-about' && args[0] === '--version') return 'cargo-about 0.9.2';
    if (_tool === 'go' && args.includes('-m')) return 'github.com/google/go-licenses/v2\tv2.0.1';
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
  const nodePath = join(dir, 'node_modules/nodeDep');
  mkdirSync(nodePath, { recursive: true });
  writeFileSync(
    join(nodePath, 'package.json'),
    JSON.stringify({ name: 'nodeDep', version: '1', license: 'MIT' }),
  );
  writeFileSync(join(nodePath, 'LICENSE'), 'Synthetic Node license text');
  writeFileSync(join(nodePath, 'NOTICE'), 'Synthetic copyright notice');
  const rustPath = join(dir, 'rust-dep');
  mkdirSync(rustPath);
  writeFileSync(join(rustPath, 'Cargo.toml'), '');
  writeFileSync(join(rustPath, 'LICENSE'), 'Synthetic Rust license file');
  const goPath = join(dir, 'go-dep');
  mkdirSync(goPath);
  writeFileSync(join(goPath, 'LICENSE'), 'Synthetic Go license text');
  const run = (tool, args) => {
    if (tool === 'cargo-about' && args[0] === '--version') return 'cargo-about 0.9.2';
    if (tool === 'go' && args.includes('-m')) return 'github.com/google/go-licenses/v2\tv2.0.1';
    if (tool === 'pnpm' && args[0] === 'list')
      return JSON.stringify([
        {
          name: 'workspace',
          path: dir,
          dependencies: { nodeDep: { from: 'nodeDep', version: '1', path: nodePath } },
        },
      ]);
    if (tool === 'pnpm' && args[0] === 'licenses')
      return JSON.stringify({ MIT: [{ name: 'nodeDep', versions: ['1'] }] });
    if (tool === 'cargo' && args[0] === 'metadata')
      return JSON.stringify({
        packages: [
          {
            name: 'rustDep',
            version: '2',
            source: 'registry',
            manifest_path: join(rustPath, 'Cargo.toml'),
          },
        ],
        resolve: { nodes: [] },
      });
    if (tool === 'cargo-about' && args[0] === 'generate') {
      expect(args).toContain('--fail');
      expect(args).toContain('--locked');
      return JSON.stringify({
        licenses: [
          {
            id: 'Apache-2.0',
            source_path: join(rustPath, 'LICENSE'),
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
    if (tool === 'go-licenses' && args.includes('--template'))
      return JSON.stringify([
        {
          name: 'example.org/goDep',
          license: 'BSD-3-Clause',
          text: 'Synthetic Go license text',
          path: join(goPath, 'LICENSE'),
        },
      ]);
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
  expect(notice).toContain('Synthetic Node license text');
  expect(notice).toContain('Synthetic copyright notice');
  expect(notice).toContain('Synthetic Go license text');
  expect(notice).toContain('fixture license');
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

test('omitted platform scanner records require verified installed package metadata', () => {
  const graph = [
    { dependencies: { platform: { from: 'platform', version: '1', path: '/fixture/platform' } } },
  ];
  expect(
    nodeRecords(graph, {}, new Set(), () => ({
      name: 'platform',
      version: '1',
      license: 'MIT',
    })).get('platform@1'),
  ).toBe('MIT');
  expect(() =>
    nodeRecords(graph, {}, new Set(), () => {
      throw new Error('not installed');
    }),
  ).toThrow('not installed');
  expect(() =>
    nodeRecords(graph, {}, new Set(), () => ({ name: 'different', version: '1', license: 'MIT' })),
  ).toThrow('identity');
});
test('installed license files preserve copyright notices and reject declaration-only attribution', () => {
  const dir = fixture();
  expect(() => licenseFiles(dir)).toThrow('Missing installed license files');
  writeFileSync(join(dir, 'LICENSE'), 'Synthetic license');
  writeFileSync(join(dir, 'NOTICE'), 'Copyright synthetic');
  expect(licenseFiles(dir).map((file) => file.name)).toEqual(['LICENSE', 'NOTICE', 'NOTICE.md']);
});
test('pinned tool preparation installs only into the maintained workspace tool directory', () => {
  const dir = fixture();
  const calls = [];
  prepareTools(dir, (tool, args, cwd, env) => {
    calls.push({ tool, args, cwd, env });
    return '';
  });
  calls.splice(0, 2);
  expect(calls[0].args).toContain('0.9.2');
  expect(calls[0].args).toContain('--locked');
  expect(calls[0].args).toContain('--features');
  expect(calls[0].args).toContain('cli');
  expect(calls[0].args.at(-1)).toBe(join(dir, '.notice-tools'));
  expect(calls[1].args).toContain('github.com/google/go-licenses/v2@v2.0.1');
  for (const call of calls)
    for (const name of ['CARGO_HOME', 'GOBIN', 'GOPATH', 'GOCACHE'])
      expect(call.env[name]).toContain(join(dir, '.notice-tools'));
});

test('Rust canonical fallback text cannot satisfy verified source attribution', () => {
  const metadata = {
    packages: [{ name: 'crate', version: '1', source: 'registry' }],
    resolve: { nodes: [] },
  };
  expect(() =>
    rustRecords(metadata, {
      licenses: [
        {
          id: 'MIT',
          text: 'canonical text',
          source_path: null,
          used_by: [{ crate: { name: 'crate', version: '1' } }],
        },
      ],
    }),
  ).toThrow('Incomplete Rust');
});
test('Go multi-license rows preserve every license obligation', () => {
  const records = goRecords(
    [{ ImportPath: 'example.org/lib/sub', Module: { Path: 'example.org/lib' } }],
    'example.org/lib,https://example.org/LICENSE,MIT\nexample.org/lib,https://example.org/LICENSE,Apache-2.0\n',
  );
  expect(records.get('example.org/lib')).toBe('MIT AND Apache-2.0');
});
test('missing Go license text after successful inventory never replaces NOTICE', () => {
  const { dir, run } = completeFixture();
  const incomplete = (tool, args, ...rest) =>
    tool === 'go-licenses' && args.includes('--template') ? '[]' : run(tool, args, ...rest);
  expect(() => generate(dir, incomplete)).toThrow('Go text');
  expect(readFileSync(join(dir, 'NOTICE.md'), 'utf8')).toBe('existing notice');
});
test('all released Go target inventories use the matching report environment', () => {
  const { dir, run } = completeFixture();
  const seen = new Set();
  generate(dir, (tool, args, cwd, env) => {
    if (tool === 'go' && args[0] === 'list') seen.add(`${env.GOOS}/${env.GOARCH}`);
    if (tool === 'go-licenses' && args[0] === 'report')
      expect(seen.has(`${env.GOOS}/${env.GOARCH}`)).toBe(true);
    return run(tool, args, cwd, env);
  });
  expect([...seen]).toEqual([
    'linux/amd64',
    'linux/arm64',
    'darwin/amd64',
    'darwin/arm64',
    'windows/amd64',
  ]);
});
test('fictitious Rust source path cannot publish complete-looking output', () => {
  const { dir, run } = completeFixture();
  const fictitious = (tool, args, ...rest) => {
    const result = run(tool, args, ...rest);
    if (tool === 'cargo-about' && args[0] === 'generate') {
      const data = JSON.parse(result);
      data.licenses[0].source_path = join(dir, 'absent');
      return JSON.stringify(data);
    }
    return result;
  };
  expect(() => generate(dir, fictitious)).toThrow('ENOENT');
  expect(readFileSync(join(dir, 'NOTICE.md'), 'utf8')).toBe('existing notice');
});

test('Go attribution target policy covers the maintained console release matrix', () => {
  const release = readFileSync(
    new URL('../.github/workflows/console-release.yml', import.meta.url),
    'utf8',
  );
  const targets = [...release.matchAll(/goos: ([a-z]+)\s+goarch: ([a-z0-9]+)/g)].map((match) => [
    match[1],
    match[2],
  ]);
  expect(targets.length).toBeGreaterThan(0);
  expect(GO_RELEASE_TARGETS).toEqual(targets);
});

test('attribution tool caches do not become additional product module roots', () => {
  const { dir, run } = completeFixture();
  const cache = join(dir, '.notice-tools/go/module');
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, 'go.mod'), 'module tool-dependency');
  let inventories = 0;
  generate(dir, (tool, args, ...rest) => {
    if (tool === 'go' && args[0] === 'list') inventories++;
    return run(tool, args, ...rest);
  });
  expect(inventories).toBe(5);
});

test('nested Rust crate retains its source-backed workspace license without a crate-local copy', () => {
  const { dir, run } = completeFixture();
  const crateDir = join(dir, 'rust-dep', 'crates', 'core');
  mkdirSync(crateDir, { recursive: true });
  writeFileSync(join(crateDir, 'Cargo.toml'), '[package]\nlicense.workspace = true\n');
  const nested = (tool, args, ...rest) => {
    const result = run(tool, args, ...rest);
    if (tool === 'cargo' && args[0] === 'metadata') {
      const data = JSON.parse(result);
      data.packages[0].manifest_path = join(crateDir, 'Cargo.toml');
      return JSON.stringify(data);
    }
    return result;
  };
  generate(dir, nested);
  const notice = readFileSync(join(dir, 'NOTICE.md'), 'utf8');
  expect(notice).toContain('Synthetic Rust license file');
  expect(notice).toContain('../../LICENSE');
  generate(dir, nested, true);
});

test('explicit package license_file reads the installed source and refuses an absent source', () => {
  const dir = fixture();
  const crateDir = join(dir, 'crate');
  mkdirSync(crateDir);
  const source = join(dir, 'custom-license-text');
  writeFileSync(source, 'Verified declared license text');
  // A declared source need not use a conventional filename.
  expect(licenseFiles(crateDir, [source])).toEqual([
    { name: '../custom-license-text', text: 'Verified declared license text' },
  ]);
  expect(() => licenseFiles(crateDir, [join(dir, 'absent-license')])).toThrow('ENOENT');
});

test('nested Rust source license cannot replace missing crate identity attribution', () => {
  const { dir, run } = completeFixture();
  const crateDir = join(dir, 'rust-dep', 'crates', 'core');
  mkdirSync(crateDir, { recursive: true });
  writeFileSync(join(crateDir, 'Cargo.toml'), '');
  const unrelated = (tool, args, ...rest) => {
    const result = run(tool, args, ...rest);
    if (tool === 'cargo' && args[0] === 'metadata') {
      const data = JSON.parse(result);
      data.packages[0].manifest_path = join(crateDir, 'Cargo.toml');
      return JSON.stringify(data);
    }
    if (tool === 'cargo-about' && args[0] === 'generate') {
      const data = JSON.parse(result);
      data.licenses[0].used_by[0].crate.name = 'unrelatedCrate';
      return JSON.stringify(data);
    }
    return result;
  };
  expect(() => generate(dir, unrelated)).toThrow('missing attribution for rustDep@2');
  expect(readFileSync(join(dir, 'NOTICE.md'), 'utf8')).toBe('existing notice');
});

test('installed README grant text is retained while heading, declaration and link alone fail', () => {
  const dir = fixture();
  for (const text of [
    '## License\nMIT',
    '## License\nhttps://example.org/LICENSE',
    '## License\n',
  ]) {
    writeFileSync(join(dir, 'README.md'), text);
    expect(() => licenseFiles(dir)).toThrow('Missing installed license files');
  }
  const grant = `# Package documentation

## License
Copyright (c) fixture author
Permission is hereby granted, free of charge, to any person obtaining a copy.
The above copyright notice and this permission notice shall be included in all copies.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM.

## Usage
Preserved surrounding package documentation.
`;
  writeFileSync(join(dir, 'README.md'), grant);
  expect(licenseFiles(dir)).toContainEqual({ name: 'README.md', text: grant });
});
