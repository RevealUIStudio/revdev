import { spawnSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
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
  lockedNodeArtifact,
  nodeRecords,
  prepareTools,
  provenanceSource,
  publish,
  rustRecords,
  sourceLicenseFiles,
  verifiedNodeLicenseFiles,
  verifiedRustLicenseFiles,
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
    packages: [{ id: 'crate@1', name: 'crate', version: '1', source: 'registry' }],
    resolve: { nodes: [{ id: 'crate@1' }] },
  };
  expect(() => rustRecords(metadata, { licenses: [] }, 'NOTICE-ID crate v1\n')).toThrow('crate@1');
  expect(
    rustRecords(
      metadata,
      {
        licenses: [
          {
            id: 'MIT',
            source_path: '/synthetic/LICENSE',
            text: 'license text',
            used_by: [{ crate: { name: 'crate', version: '1' } }],
          },
        ],
      },
      'NOTICE-ID crate v1\n',
    ).get('crate@1'),
  ).toBe('MIT');
});
test('Rust attribution covers Cargo feature graph, not inactive optional metadata packages', () => {
  const metadata = {
    packages: [
      { id: 'active@1', name: 'active', version: '1', source: 'registry' },
      { id: 'inactive@1', name: 'inactive', version: '1', source: 'registry' },
    ],
    resolve: { nodes: [{ id: 'active@1' }, { id: 'inactive@1' }] },
  };
  const attribution = {
    licenses: [
      {
        id: 'MIT',
        text: 'Original text',
        source_path: '/synthetic/LICENSE',
        used_by: [{ crate: { name: 'active', version: '1' } }],
      },
    ],
  };
  expect([...rustRecords(metadata, attribution, 'NOTICE-ID active v1\n')]).toEqual([
    ['active@1', 'MIT'],
  ]);
  attribution.licenses[0].used_by.push({ crate: { name: 'inactive', version: '1' } });
  expect(() => rustRecords(metadata, attribution, 'NOTICE-ID active v1\n')).toThrow(
    'uninventoried attribution for inactive@1',
  );
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
            id: 'rustDep@2',
            name: 'rustDep',
            version: '2',
            source: 'registry',
            manifest_path: join(rustPath, 'Cargo.toml'),
          },
        ],
        resolve: { nodes: [{ id: 'rustDep@2' }] },
      });
    if (tool === 'cargo' && args[0] === 'tree') {
      expect(args).toContain('all');
      expect(args).toContain('NOTICE-ID {p}');
      return 'NOTICE-ID rustDep v2\n';
    }
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
function rustSourceFixture({ dirty = false, upstreamVersion = '2', relocatedReadme = false } = {}) {
  const dir = fixture();
  const name = 'rustDep';
  const version = '2';
  const key = `${name}@${version}`;
  const commit = 'a'.repeat(40);
  const repository = 'https://github.com/example/rust-workspace';
  const cratePath = 'crates/rustDep';
  const grant = 'Original Apache-2.0 grant\n';
  const manifest = `[package]\nname = "${name}"\nversion = "${version}"\nlicense = "Apache-2.0"\n${relocatedReadme ? 'readme = "../README.md"\n' : ''}`;
  const upstreamManifest = manifest.replace(
    `version = "${version}"`,
    `version = "${upstreamVersion}"`,
  );
  const code = 'pub fn original() {}\n';
  const index = 'index.crates.io-test';
  const sourceDir = join(
    dir,
    '.notice-tools',
    'cargo-home',
    'registry',
    'src',
    index,
    key.replace('@', '-'),
  );
  const cacheDir = join(dir, '.notice-tools', 'cargo-home', 'registry', 'cache', index);
  mkdirSync(join(sourceDir, 'src'), { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(sourceDir, '.cargo_vcs_info.json'),
    JSON.stringify({ git: { sha1: commit, dirty }, path_in_vcs: cratePath }),
  );
  writeFileSync(join(sourceDir, 'Cargo.toml'), manifest);
  writeFileSync(join(sourceDir, 'Cargo.toml.orig'), manifest);
  writeFileSync(join(sourceDir, 'src/lib.rs'), code);
  if (relocatedReadme) writeFileSync(join(sourceDir, 'README.md'), 'Workspace readme\n');
  const archive = join(cacheDir, `${name}-${version}.crate`);
  expect(
    spawnSync('tar', [
      '-czf',
      archive,
      '-C',
      join(cacheDir, '..', '..', 'src', index),
      `${name}-${version}/.cargo_vcs_info.json`,
      `${name}-${version}/Cargo.toml`,
      `${name}-${version}/Cargo.toml.orig`,
      `${name}-${version}/src/lib.rs`,
      ...(relocatedReadme ? [`${name}-${version}/README.md`] : []),
    ]).status,
  ).toBe(0);
  const checksum = createHash('sha256').update(readFileSync(archive)).digest('hex');
  const cargoManifest = join(dir, 'Cargo.toml');
  writeFileSync(cargoManifest, '[package]\nname = "fixture"\nversion = "1"\n');
  writeFileSync(
    join(dir, 'Cargo.lock'),
    `version = 4\n\n[[package]]\nname = "${name}"\nversion = "${version}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${checksum}"\n`,
  );
  mkdirSync(join(dir, 'scripts'));
  const policy = {
    repository,
    publishedRepository: repository,
    commit,
    cratePath,
    license: 'Apache-2.0',
    grants: [{ path: 'LICENSE.txt', sha256: createHash('sha256').update(grant).digest('hex') }],
  };
  const writePolicy = () =>
    writeFileSync(
      join(dir, 'scripts', 'notice-source-policy.json'),
      JSON.stringify({ rust: { [key]: policy } }),
    );
  writePolicy();
  const pkg = {
    name,
    version,
    source: 'registry+https://github.com/rust-lang/crates.io-index',
    manifest_path: join(sourceDir, 'Cargo.toml'),
    repository,
    license: 'Apache-2.0',
  };
  const source = new Map([
    [`${cratePath}/Cargo.toml`, upstreamManifest],
    [`${cratePath}/src/lib.rs`, code],
    ['LICENSE.txt', grant],
    ...(relocatedReadme ? [['crates/README.md', 'Workspace readme\n']] : []),
  ]);
  const run = (tool, args) => {
    expect(tool).toBe('git');
    if (args[0] === 'rev-parse') return commit;
    if (args[0] === 'ls-tree') {
      const path = args.at(-1);
      const text = source.get(path);
      if (text === undefined) return '';
      const bytes = Buffer.from(text);
      const oid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      return `100644 blob ${oid}\t${path}\n`;
    }
    if (args[0] === 'show') return source.get(args[1].slice(commit.length + 1));
    return '';
  };
  return {
    dir,
    key,
    pkg,
    cargoManifest,
    policy,
    writePolicy,
    source,
    run,
    checksum,
    sourceDir,
    archive,
  };
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

test('Rust canonical fallback text classifies a crate but cannot supply its original grant', () => {
  const metadata = {
    packages: [{ id: 'crate@1', name: 'crate', version: '1', source: 'registry' }],
    resolve: { nodes: [{ id: 'crate@1' }] },
  };
  expect(
    rustRecords(
      metadata,
      {
        licenses: [
          {
            id: 'MIT',
            text: 'canonical text',
            source_path: null,
            used_by: [{ crate: { name: 'crate', version: '1' } }],
          },
        ],
      },
      'NOTICE-ID crate v1\n',
    ).get('crate@1'),
  ).toBe('MIT');
  const { dir, run } = completeFixture();
  rmSync(join(dir, 'rust-dep', 'LICENSE'));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'scripts', 'notice-source-policy.json'), '{}');
  const canonicalOnly = (tool, args, ...rest) => {
    const result = run(tool, args, ...rest);
    if (tool === 'cargo-about' && args[0] === 'generate') {
      const data = JSON.parse(result);
      data.licenses[0].source_path = null;
      return JSON.stringify(data);
    }
    return result;
  };
  expect(() => generate(dir, canonicalOnly)).toThrow(
    'No authenticated Rust source policy: rustDep@2',
  );
  expect(readFileSync(join(dir, 'NOTICE.md'), 'utf8')).toBe('existing notice');
});
test('Rust grouped canonical text does not borrow one crate grant for another', () => {
  const { dir, run } = completeFixture();
  const second = join(dir, 'other-rust-dep');
  mkdirSync(second);
  writeFileSync(join(second, 'Cargo.toml'), '[package]\nname="otherRustDep"\nversion="3"\n');
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'scripts', 'notice-source-policy.json'), '{}');
  const grouped = (tool, args, ...rest) => {
    const result = run(tool, args, ...rest);
    if (tool === 'cargo' && args[0] === 'metadata') {
      const data = JSON.parse(result);
      data.packages.push({
        id: 'otherRustDep@3',
        name: 'otherRustDep',
        version: '3',
        source: 'registry',
        manifest_path: join(second, 'Cargo.toml'),
      });
      data.resolve.nodes.push({ id: 'otherRustDep@3' });
      return JSON.stringify(data);
    }
    if (tool === 'cargo' && args[0] === 'tree') return `${result}NOTICE-ID otherRustDep v3\n`;
    if (tool === 'cargo-about' && args[0] === 'generate') {
      const data = JSON.parse(result);
      data.licenses[0].source_path = null;
      data.licenses[0].used_by.push({ crate: { name: 'otherRustDep', version: '3' } });
      return JSON.stringify(data);
    }
    return result;
  };
  expect(() => generate(dir, grouped)).toThrow(
    'No authenticated Rust source policy: otherRustDep@3',
  );
  expect(readFileSync(join(dir, 'NOTICE.md'), 'utf8')).toBe('existing notice');
});
test('Rust local original license remains valid when cargo-about has no group source path', () => {
  const { dir, run } = completeFixture();
  const local = (tool, args, ...rest) => {
    const result = run(tool, args, ...rest);
    if (tool === 'cargo-about' && args[0] === 'generate') {
      const data = JSON.parse(result);
      data.licenses[0].source_path = null;
      return JSON.stringify(data);
    }
    return result;
  };
  generate(dir, local);
  const notice = readFileSync(join(dir, 'NOTICE.md'), 'utf8');
  expect(notice).toContain('Synthetic Rust license file');
  expect(notice).not.toContain('fixture license');
});
test('Rust attribution refuses malformed used-by records with an actionable license diagnostic', () => {
  const metadata = {
    packages: [{ id: 'crate@1', name: 'crate', version: '1', source: 'registry' }],
    resolve: { nodes: [{ id: 'crate@1' }] },
  };
  expect(() =>
    rustRecords(
      metadata,
      {
        licenses: [
          { id: 'MIT', text: 'verified text', source_path: '/synthetic/LICENSE', used_by: [{}] },
        ],
      },
      'NOTICE-ID crate v1\n',
    ),
  ).toThrow('Incomplete Rust attribution: MIT for unknown crates; missing used_by.crate');
});
test('Rust original grant requires a checksum-bound matching source tree', () => {
  const f = rustSourceFixture();
  const receipts = [];
  const files = verifiedRustLicenseFiles(
    f.dir,
    f.cargoManifest,
    f.pkg,
    'Apache-2.0',
    f.run,
    (receipt) => receipts.push(receipt),
  );
  expect(files).toEqual([
    {
      name: `${f.policy.repository}/blob/${f.policy.commit}/LICENSE.txt`,
      text: 'Original Apache-2.0 grant\n',
    },
  ]);
  expect(receipts).toMatchObject([
    {
      ecosystem: 'Rust',
      dependency: f.key,
      archiveSha256: f.checksum,
      dirty: false,
      comparedFiles: 1,
    },
  ]);
  f.source.set(`${f.policy.cratePath}/src/lib.rs`, 'different code');
  expect(() =>
    verifiedRustLicenseFiles(f.dir, f.cargoManifest, f.pkg, 'Apache-2.0', f.run),
  ).toThrow('packaged source differs');
});
test('Rust packaged workspace README must match its declared source path', () => {
  const f = rustSourceFixture({ relocatedReadme: true });
  const receipts = [];
  verifiedRustLicenseFiles(f.dir, f.cargoManifest, f.pkg, 'Apache-2.0', f.run, (receipt) =>
    receipts.push(receipt),
  );
  expect(receipts[0].comparedFiles).toBe(2);
  f.source.set('crates/README.md', 'Changed workspace readme\n');
  expect(() =>
    verifiedRustLicenseFiles(f.dir, f.cargoManifest, f.pkg, 'Apache-2.0', f.run),
  ).toThrow('packaged source differs');
});
test('Rust dirty source accepts only a package-version release delta with identical code', () => {
  const f = rustSourceFixture({ dirty: true, upstreamVersion: '1' });
  const receipts = [];
  verifiedRustLicenseFiles(f.dir, f.cargoManifest, f.pkg, 'Apache-2.0', f.run, (receipt) =>
    receipts.push(receipt),
  );
  expect(receipts[0].dirty).toBe(true);
  f.source.set(
    `${f.policy.cratePath}/Cargo.toml`,
    '[package]\nname = "rustDep"\nversion = "1"\nlicense = "MIT"\n',
  );
  expect(() =>
    verifiedRustLicenseFiles(f.dir, f.cargoManifest, f.pkg, 'Apache-2.0', f.run),
  ).toThrow('original manifest identity mismatch');
});
test('Rust original grant refuses a mismatched archive checksum or grant hash', () => {
  const f = rustSourceFixture();
  writeFileSync(f.archive, 'not the locked archive');
  expect(() =>
    verifiedRustLicenseFiles(f.dir, f.cargoManifest, f.pkg, 'Apache-2.0', f.run),
  ).toThrow('archive checksum mismatch');
  const g = rustSourceFixture();
  g.policy.grants[0].sha256 = 'b'.repeat(64);
  g.writePolicy();
  expect(() =>
    verifiedRustLicenseFiles(g.dir, g.cargoManifest, g.pkg, 'Apache-2.0', g.run),
  ).toThrow('grant hash mismatch');
});
test('Rust original grant refuses mismatched published repository provenance', () => {
  const f = rustSourceFixture();
  f.policy.publishedRepository = 'https://github.com/another/project';
  f.writePolicy();
  expect(() =>
    verifiedRustLicenseFiles(f.dir, f.cargoManifest, f.pkg, 'Apache-2.0', f.run),
  ).toThrow('policy identity mismatch');
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
  const wrapped = grant.replaceAll(' ', '\n');
  // Preserve normal Markdown heading syntax while wrapping grant words.
  const wrappedSource = wrapped.replace('##\nLicense', '## License');
  writeFileSync(join(dir, 'README.md'), wrappedSource);
  expect(licenseFiles(dir)).toContainEqual({ name: 'README.md', text: wrappedSource });
});

function provenanceFixture() {
  const installed = {
    name: 'example',
    version: '1.2.3',
    license: 'MIT',
    repository: 'git+https://github.com/drizzle-team/drizzle-orm.git',
  };
  const integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
  const policy = {
    repository: 'https://github.com/drizzle-team/drizzle-orm',
    manifest: 'package/package.json',
    licenses: ['LICENSE'],
  };
  const commit = 'a'.repeat(40);
  const statement = {
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: [
      { name: 'pkg:npm/example@1.2.3', digest: { sha512: Buffer.alloc(64, 1).toString('hex') } },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: { workflow: { repository: policy.repository } },
        resolvedDependencies: [
          { uri: `git+${policy.repository}@refs/heads/main`, digest: { gitCommit: commit } },
        ],
      },
    },
  };
  const report = () => ({
    invalid: [],
    missing: [],
    verified: [
      {
        name: installed.name,
        version: installed.version,
        registry: 'https://registry.npmjs.org/',
        attestationBundles: [
          {
            predicateType: statement.predicateType,
            bundle: {
              verificationMaterial: {
                certificate: {
                  rawBytes: new X509Certificate(
                    readFileSync(
                      new URL('./fixtures/notice-provenance-certificate.pem', import.meta.url),
                      'utf8',
                    ),
                  ).raw.toString('base64'),
                },
              },
              dsseEnvelope: {
                payloadType: 'application/vnd.in-toto+json',
                payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
              },
            },
          },
        ],
      },
    ],
  });
  return { installed, integrity, policy, commit, statement, report };
}
test('exact pnpm lock artifact binds a verified source and preserves original grant bytes', () => {
  const { installed, integrity, policy, report } = provenanceFixture();
  expect(
    lockedNodeArtifact({ packages: { 'example@1.2.3': { resolution: { integrity } } } }, installed),
  ).toBe(integrity);
  const source = provenanceSource(report(), installed, integrity, policy);
  const files = sourceLicenseFiles(installed, policy, source, (path) =>
    path === policy.manifest ? JSON.stringify(installed) : 'original copyright and grant\n',
  );
  expect(files).toEqual([
    {
      name: `${source.repository}/blob/${source.commit}/LICENSE`,
      text: 'original copyright and grant\n',
    },
  ]);
  expect(() => lockedNodeArtifact({ packages: {} }, installed)).toThrow('pnpm integrity');
});
test.each([
  'subject-name',
  'subject-digest',
  'repository',
  'commit',
  'ambiguous-commit',
  'predicate',
])('rejects provenance mismatch: %s', (failure) => {
  const { installed, integrity, policy, statement, report } = provenanceFixture();
  if (failure === 'subject-name') statement.subject[0].name = 'pkg:npm/other@1.2.3';
  if (failure === 'subject-digest') statement.subject[0].digest.sha512 = 'b'.repeat(128);
  if (failure === 'repository')
    statement.predicate.buildDefinition.externalParameters.workflow.repository =
      'https://github.com/attacker/example';
  if (failure === 'commit')
    statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = 'main';
  if (failure === 'ambiguous-commit')
    statement.predicate.buildDefinition.resolvedDependencies.push(
      statement.predicate.buildDefinition.resolvedDependencies[0],
    );
  if (failure === 'predicate') statement.predicateType = 'untrusted';
  expect(() => provenanceSource(report(), installed, integrity, policy)).toThrow();
});
test.each([
  'invalid',
  'missing',
  'name',
  'version',
  'registry',
  'empty',
  'duplicate',
])('rejects verifier failure or ambiguity: %s', (failure) => {
  const { installed, integrity, policy, report } = provenanceFixture();
  const result = report();
  if (failure === 'invalid' || failure === 'missing') result[failure].push({});
  if (failure === 'name' || failure === 'version' || failure === 'registry')
    result.verified[0][failure] = 'wrong';
  if (failure === 'empty') result.verified = [];
  if (failure === 'duplicate') result.verified.push(result.verified[0]);
  expect(() => provenanceSource(result, installed, integrity, policy)).toThrow();
});
test.each([
  'name',
  'version',
  'license',
  'repository',
  'blank',
  'unreadable',
  'missing',
  'traversal',
])('rejects invalid source: %s', (failure) => {
  const { installed, integrity, policy, report } = provenanceFixture();
  const source = provenanceSource(report(), installed, integrity, policy);
  const manifest = { ...installed };
  if (['name', 'version', 'license', 'repository'].includes(failure)) manifest[failure] = 'wrong';
  if (failure === 'traversal') policy.licenses = ['../LICENSE'];
  expect(() =>
    sourceLicenseFiles(installed, policy, source, (path) => {
      if (path === policy.manifest) return JSON.stringify(manifest);
      if (failure === 'missing') throw new Error('missing file');
      return failure === 'blank' ? ' ' : failure === 'unreadable' ? '\uFFFD' : 'original grant';
    }),
  ).toThrow();
});
test('normal generation uses verifier only, emits deterministic source text and preserves NOTICE on failure', () => {
  const { dir, run } = completeFixture();
  const { installed, integrity, policy, report, commit } = provenanceFixture();
  installed.name = 'nodeDep';
  installed.version = '1';
  const result = report();
  result.verified[0].name = installed.name;
  result.verified[0].version = installed.version;
  const envelope = result.verified[0].attestationBundles[0].bundle.dsseEnvelope;
  const statement = JSON.parse(Buffer.from(envelope.payload, 'base64'));
  statement.subject[0].name = 'pkg:npm/nodeDep@1';
  envelope.payload = Buffer.from(JSON.stringify(statement)).toString('base64');
  rmSync(join(dir, 'node_modules/nodeDep/LICENSE'));
  writeFileSync(join(dir, 'node_modules/nodeDep/package.json'), JSON.stringify(installed));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(
    join(dir, 'scripts/notice-source-policy.json'),
    JSON.stringify({ node: { nodeDep: policy } }),
  );
  writeFileSync(
    join(dir, 'pnpm-lock.yaml'),
    `packages:\n  nodeDep@1:\n    resolution:\n      integrity: ${integrity}\n`,
  );
  mkdirSync(join(dir, 'node_modules/npm'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/npm/package.json'), '{"version":"11.21.0"}');
  let fail = false;
  const calls = [];
  const sourceRun = (tool, args, ...rest) => {
    if (tool === process.execPath) {
      calls.push(args);
      expect(rest[1]).not.toHaveProperty('GITHUB_TOKEN');
      expect(rest[1]).not.toHaveProperty('NPM_TOKEN');
      expect(args.slice(1, 3)).toEqual(['audit', 'signatures']);
      const projectedLock = JSON.parse(readFileSync(join(rest[0], 'package-lock.json'), 'utf8'));
      expect(projectedLock.packages['node_modules/nodeDep'].integrity).toBe(integrity);
      expect(Object.keys(projectedLock.packages)).toEqual(['', 'node_modules/nodeDep']);
      expect(
        JSON.parse(readFileSync(join(rest[0], 'node_modules/nodeDep/package.json'), 'utf8')),
      ).toEqual({ name: 'nodeDep', version: '1' });
      if (fail === 'verifier') throw new Error('verifier rejected');
      return JSON.stringify(result);
    }
    if (tool === 'git') {
      if (args[0] === 'rev-parse') return fail === 'commit' ? 'b'.repeat(40) : commit;
      if (args[0] === 'ls-tree')
        return fail === 'missing'
          ? ''
          : `${fail === 'symlink' ? '120000' : '100644'} blob ${'b'.repeat(40)}\t${args.at(-1)}\n`;
      if (args[0] === 'show')
        return args[1].endsWith(policy.manifest)
          ? JSON.stringify(installed)
          : 'authenticated source grant\n';
      return '';
    }
    return run(tool, args, ...rest);
  };
  const receipts = [];
  generate(dir, sourceRun, false, (receipt) => receipts.push(receipt));
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({
    dependency: 'nodeDep@1',
    integrity,
    commit,
    repository: policy.repository,
  });
  expect(receipts[0].files[0]).toMatchObject({
    bytes: Buffer.byteLength('authenticated source grant\n'),
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(readFileSync(join(dir, 'NOTICE.md'), 'utf8')).toContain('authenticated source grant');
  expect(readFileSync(join(dir, 'NOTICE.md'), 'utf8')).toContain('Synthetic copyright notice');
  generate(dir, sourceRun, true);
  const notice = readFileSync(join(dir, 'NOTICE.md'), 'utf8');
  for (const failure of ['verifier', 'commit', 'missing', 'symlink']) {
    fail = failure;
    expect(() => generate(dir, sourceRun, false, (receipt) => receipts.push(receipt))).toThrow();
    expect(receipts).toHaveLength(1);
    expect(readFileSync(join(dir, 'NOTICE.md'), 'utf8')).toBe(notice);
  }
  expect(calls).toHaveLength(6);
});
test('is-node-process stays denied without an authenticated source policy', () => {
  const dir = fixture();
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'scripts/notice-source-policy.json'), '{}');
  expect(() =>
    verifiedNodeLicenseFiles(dir, { name: 'is-node-process', version: '1.2.0' }),
  ).toThrow('No authenticated source policy');
  expect(readFileSync(join(dir, 'NOTICE.md'), 'utf8')).toBe('existing notice');
});

test.each([
  '..',
  '.',
  '@scope/..',
  '../package',
])('rejects unsafe projected package name %s', (name) => {
  const installed = { name, version: '1.2.3' };
  expect(() => lockedNodeArtifact({ packages: {} }, installed)).toThrow(
    'Unsupported npm artifact identity',
  );
});

test('rejects a certified workflow from another repository even when every statement field agrees', () => {
  const { installed, integrity, policy, statement, report } = provenanceFixture();
  const repository = 'https://github.com/attacker/example';
  installed.repository = repository;
  policy.repository = repository;
  statement.predicate.buildDefinition.externalParameters.workflow.repository = repository;
  statement.predicate.buildDefinition.resolvedDependencies[0].uri = `git+${repository}@refs/heads/main`;
  expect(() => provenanceSource(report(), installed, integrity, policy)).toThrow(
    'signer repository mismatch',
  );
});
test.each(['absent', 'unreadable'])('rejects %s certified signer identity', (failure) => {
  const { installed, integrity, policy, report } = provenanceFixture();
  const result = report();
  const bundle = result.verified[0].attestationBundles[0].bundle;
  bundle.verificationMaterial =
    failure === 'absent' ? {} : { certificate: { rawBytes: 'not a certificate' } };
  expect(() => provenanceSource(result, installed, integrity, policy)).toThrow();
});

test('binds scoped npm subjects with complete package URL encoding', () => {
  const { installed, integrity, policy, statement, report } = provenanceFixture();
  installed.name = '@scope/example';
  statement.subject[0].name = 'pkg:npm/%40scope/example@1.2.3';
  expect(provenanceSource(report(), installed, integrity, policy).repository).toBe(
    policy.repository,
  );
  statement.subject[0].name = 'pkg:npm/@scope/example@1.2.3';
  expect(() => provenanceSource(report(), installed, integrity, policy)).toThrow(
    'subject mismatch',
  );
});

test('checks every installed source and fails closed with all grant errors', () => {
  const graph = [
    {
      dependencies: {
        first: { name: 'first', version: '1', path: '/first' },
        supported: { name: 'supported', version: '1', path: '/supported' },
        last: { name: 'last', version: '1', path: '/last' },
      },
    },
  ];
  const visited = [];
  expect(() =>
    nodeRecords(graph, {}, new Set(), (path) => {
      visited.push(path);
      if (path !== '/supported') throw new Error(`missing grant ${path}`);
      return { name: 'supported', version: '1', license: 'MIT' };
    }),
  ).toThrow('first@1: missing grant /first\nlast@1: missing grant /last');
  expect(visited).toEqual(['/first', '/supported', '/last']);
});
