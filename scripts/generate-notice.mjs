import { spawnSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TOOL_VERSIONS = { cargoAbout: '0.9.2', goLicenses: 'v2.0.1' };
export const GO_RELEASE_TARGETS = [
  ['linux', 'amd64'],
  ['linux', 'arm64'],
  ['darwin', 'amd64'],
  ['darwin', 'arm64'],
  ['windows', 'amd64'],
];
const toolsDir = join(root, '.notice-tools');
const compareText = (a, b) => (a > b) - (a < b);
export function command(tool, args, cwd, env = process.env) {
  const localTool = join(toolsDir, 'bin', tool);
  const executable = existsSync(localTool) ? localTool : tool;
  const toolEnv =
    tool === 'go' || tool === 'go-licenses'
      ? { ...env, GOPATH: join(toolsDir, 'go'), GOCACHE: join(toolsDir, 'go-cache') }
      : tool === 'cargo' || tool === 'cargo-about'
        ? { ...env, CARGO_HOME: join(toolsDir, 'cargo-home') }
        : env;
  const result = spawnSync(executable, args, {
    cwd,
    env: toolEnv,
    encoding: 'utf8',
    // Public provenance/source operations must terminate on an unavailable service.
    timeout: tool === process.execPath || tool === 'git' ? 180_000 : undefined,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const details = [result.error?.message, result.stderr?.trim()].filter(Boolean).join('\n');
    throw new Error(
      `${tool} failed: ${details || `exit ${result.status}, signal ${result.signal}`}`,
    );
  }
  return result.stdout;
}
export function prepareTools(rootDir = root, run = command) {
  run('go', ['version'], rootDir);
  run('cargo', ['--version'], rootDir);
  const destination = join(rootDir, '.notice-tools');
  mkdirSync(join(destination, 'bin'), { recursive: true });
  const env = {
    ...process.env,
    CARGO_HOME: join(destination, 'cargo-home'),
    GOBIN: join(destination, 'bin'),
    GOPATH: join(destination, 'go'),
    GOCACHE: join(destination, 'go-cache'),
  };
  run(
    'cargo',
    [
      'install',
      'cargo-about',
      '--version',
      TOOL_VERSIONS.cargoAbout,
      '--locked',
      '--features',
      'cli',
      '--root',
      destination,
    ],
    rootDir,
    env,
  );
  run(
    'go',
    ['install', `github.com/google/go-licenses/v2@${TOOL_VERSIONS.goLicenses}`],
    rootDir,
    env,
  );
}
export function licenseFiles(packageDir, sourcePaths = [], requireGrant = true) {
  const files = [];
  let embeddedGrant = false;
  const visit = (dir, depth) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git'].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (
        entry.isFile() &&
        /^(licen[cs]e|copying|notice|copyright)([._-]|$)/i.test(entry.name)
      ) {
        const text = readFileSync(path, 'utf8');
        if (!text.trim() || text.includes('\uFFFD'))
          throw new Error(`Unreadable license text: ${path}`);
        files.push({ name: path.slice(packageDir.length + 1), text });
      } else if (entry.isFile() && /^readme([._-]|$)/i.test(entry.name)) {
        const text = readFileSync(path, 'utf8');
        // Some published packages include the complete grant in their README
        // rather than a standalone LICENSE. Preserve that actual source file;
        // a declaration, heading or upstream link alone cannot replace it.
        const section = text.match(
          /^#{1,6}\s+licen[cs]e\s*\r?\n([\s\S]*?)(?=^#{1,6}\s|$(?![\s\S]))/im,
        )?.[1];
        const grant = section?.replace(/\s+/g, ' ');
        if (
          grant &&
          /copyright/i.test(grant) &&
          /permission is hereby granted, free of charge/i.test(grant) &&
          /the above copyright notice and this permission notice shall be included/i.test(grant) &&
          /the software is provided ["“]as is["”]/i.test(grant) &&
          /in no event shall the authors or copyright holders be liable/i.test(grant)
        ) {
          if (text.includes('\uFFFD')) throw new Error(`Unreadable license text: ${path}`);
          embeddedGrant = true;
          files.push({ name: path.slice(packageDir.length + 1), text });
        }
      }
    }
  };
  visit(packageDir, 0);
  // Cargo metadata and cargo-about may identify a workspace license outside
  // the crate directory. Read only these explicit source-backed files; never
  // guess an ancestor license or substitute canonical license text.
  for (const source of new Set(sourcePaths.map((path) => resolve(path)))) {
    const text = readFileSync(source, 'utf8');
    if (!text.trim() || text.includes('\uFFFD'))
      throw new Error(`Unreadable license text: ${source}`);
    const name = relative(packageDir, source);
    if (!files.some((file) => file.name === name)) files.push({ name, text });
  }
  if (
    requireGrant &&
    sourcePaths.length === 0 &&
    !embeddedGrant &&
    !files.some((file) => /^(licen[cs]e|copying)([._-]|$)/i.test(file.name.split('/').at(-1)))
  )
    throw new Error(`Missing installed license files: ${packageDir}`);
  return files.sort((a, b) => compareText(a.name, b.name));
}
const json = (value) => JSON.parse(value);
export function license(value) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    /unknown|unlicensed|see |not available|\*/i.test(value)
  ) {
    throw new Error(`Unverified license: ${value}`);
  }
  return value;
}
export function requireCoverage(expected, records, label) {
  for (const key of expected)
    if (!records.has(key)) throw new Error(`${label}: missing attribution for ${key}`);
}
function manifests(dir, name) {
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.notice-tools', 'target', 'dist', '.next'].includes(entry.name))
      continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...manifests(path, name));
    else if (entry.name === name) result.push(path);
  }
  return result.sort();
}
// npm is a pinned signature verifier only. This projection never installs or
// resolves dependencies; every entry comes from the existing pnpm lock.
export function lockedNodeArtifact(lock, installed) {
  if (
    !/^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(installed.name ?? '') ||
    installed.name.split('/').some((part) => part === '.' || part === '..') ||
    !/^[0-9]+(?:\.[0-9]+){0,2}(?:-[A-Za-z0-9.-]+)?$/.test(installed.version ?? '')
  )
    throw new Error('Unsupported npm artifact identity');
  const key = `${installed.name}@${installed.version}`;
  const integrity = lock.packages?.[key]?.resolution?.integrity;
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity ?? ''))
    throw new Error(`Missing exact pnpm integrity: ${key}`);
  return integrity;
}
function githubRepository(value) {
  const url = typeof value === 'object' ? value?.url : value;
  const normalized = url?.replace(/^git\+/, '').replace(/\.git$/, '');
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized ?? ''))
    throw new Error('Unsupported source repository');
  return normalized;
}
export function provenanceSource(report, installed, integrity, policy) {
  const key = `${installed.name}@${installed.version}`;
  if (
    !Array.isArray(report.invalid) ||
    report.invalid.length ||
    !Array.isArray(report.missing) ||
    report.missing.length ||
    !Array.isArray(report.verified) ||
    report.verified.length !== 1
  )
    throw new Error(`Unverified npm provenance: ${key}`);
  const verified = report.verified[0];
  if (
    verified.name !== installed.name ||
    verified.version !== installed.version ||
    verified.registry !== 'https://registry.npmjs.org/'
  )
    throw new Error(`Provenance identity mismatch: ${key}`);
  const bundles = verified.attestationBundles?.filter(
    (entry) => entry.predicateType === 'https://slsa.dev/provenance/v1',
  );
  if (bundles?.length !== 1) throw new Error(`Missing unique SLSA provenance: ${key}`);
  const envelope = bundles[0].bundle?.dsseEnvelope;
  if (envelope?.payloadType !== 'application/vnd.in-toto+json')
    throw new Error('Unsupported provenance envelope');
  const statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
  if (
    statement.predicateType !== 'https://slsa.dev/provenance/v1' ||
    statement.subject?.length !== 1 ||
    statement.subject[0].name !==
      `pkg:npm/${installed.name.split('/').map(encodeURIComponent).join('/')}@${installed.version}` ||
    statement.subject[0].digest?.sha512 !==
      Buffer.from(integrity.slice(7), 'base64').toString('hex')
  )
    throw new Error(`Provenance subject mismatch: ${key}`);
  const definition = statement.predicate?.buildDefinition;
  const repository = githubRepository(definition?.externalParameters?.workflow?.repository);
  if (
    repository !== githubRepository(installed.repository) ||
    repository !== githubRepository(policy.repository)
  )
    throw new Error(`Provenance repository mismatch: ${key}`);
  // npm has already cryptographically verified the bundle. Bind its certified
  // GitHub workflow identity as well as its signed statement to this repository.
  const certificate = bundles[0].bundle?.verificationMaterial?.certificate?.rawBytes;
  if (typeof certificate !== 'string' || !certificate)
    throw new Error(`Missing certified provenance signer: ${key}`);
  const identity = new X509Certificate(Buffer.from(certificate, 'base64')).subjectAltName;
  const workflowPrefix = `URI:${repository}/.github/workflows/`;
  if (
    !identity?.startsWith(workflowPrefix) ||
    !/^[A-Za-z0-9_./-]+@refs\/[A-Za-z0-9_./-]+$/.test(identity.slice(workflowPrefix.length))
  )
    throw new Error(`Provenance signer repository mismatch: ${key}`);
  const dependencies = definition?.resolvedDependencies;
  if (
    dependencies?.length !== 1 ||
    !dependencies[0].uri?.startsWith(`git+${repository}@`) ||
    !/^[a-f0-9]{40}$/.test(dependencies[0].digest?.gitCommit ?? '')
  )
    throw new Error(`Missing immutable source commit: ${key}`);
  return { repository, commit: dependencies[0].digest.gitCommit };
}
export function sourceLicenseFiles(installed, policy, source, readSource) {
  const safePath = (path) => {
    if (
      typeof path !== 'string' ||
      !path ||
      path.startsWith('/') ||
      path.split('/').some((part) => !part || part === '.' || part === '..') ||
      !/^[A-Za-z0-9_./-]+$/.test(path)
    )
      throw new Error('Unsafe source path');
    return path;
  };
  const manifest = JSON.parse(readSource(safePath(policy.manifest)));
  if (
    manifest.name !== installed.name ||
    manifest.version !== installed.version ||
    license(manifest.license) !== license(installed.license) ||
    githubRepository(manifest.repository) !== source.repository
  )
    throw new Error('Source package identity/license mismatch');
  if (
    !Array.isArray(policy.licenses) ||
    !policy.licenses.length ||
    new Set(policy.licenses).size !== policy.licenses.length
  )
    throw new Error('Missing unique source license paths');
  return policy.licenses
    .map((path) => {
      const text = readSource(safePath(path));
      if (
        typeof text !== 'string' ||
        !text.trim() ||
        text.includes('\uFFFD') ||
        text.includes('\0')
      )
        throw new Error(`Unreadable source license: ${path}`);
      return { name: `${source.repository}/blob/${source.commit}/${path}`, text };
    })
    .sort((a, b) => compareText(a.name, b.name));
}
export function verifiedNodeLicenseFiles(rootDir, installed, run = command, onVerified = () => {}) {
  // Explicit maintained paths, never inferred ancestor grants or canonical text.
  const policies = json(readFileSync(join(rootDir, 'scripts/notice-source-policy.json'), 'utf8'));
  const policy = policies[installed.name];
  if (!policy)
    throw new Error(`No authenticated source policy: ${installed.name}@${installed.version}`);
  const integrity = lockedNodeArtifact(
    parseYaml(readFileSync(join(rootDir, 'pnpm-lock.yaml'), 'utf8')),
    installed,
  );
  const npmDir = join(rootDir, 'node_modules/npm');
  if (json(readFileSync(join(npmDir, 'package.json'), 'utf8')).version !== '11.21.0')
    throw new Error('Expected npm signature verifier 11.21.0');
  const temp = mkdtempSync(join(rootDir, '.notice-source-'));
  try {
    const { name, version } = installed;
    const manifest = {
      name: 'notice-signature-verification',
      version: '0.0.0',
      dependencies: { [name]: version },
    };
    writeFileSync(join(temp, 'package.json'), JSON.stringify(manifest));
    // audit signatures loads an actual tree. Project only installed metadata;
    // do not run npm install or let npm select any dependency versions.
    const projectedPackage = join(temp, 'node_modules', name);
    mkdirSync(projectedPackage, { recursive: true });
    writeFileSync(join(projectedPackage, 'package.json'), JSON.stringify({ name, version }));

    writeFileSync(
      join(temp, 'package-lock.json'),
      JSON.stringify({
        name: manifest.name,
        version: manifest.version,
        lockfileVersion: 3,
        packages: {
          '': manifest,
          [`node_modules/${name}`]: {
            version,
            integrity,
            resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,
          },
        },
      }),
    );
    // Do not expose operator credentials or machine npm configuration to the
    // public verifier. Separate empty config files avoid npm double-loading.
    writeFileSync(join(temp, 'user.npmrc'), '');
    writeFileSync(join(temp, 'global.npmrc'), '');
    const publicEnv = Object.fromEntries(
      ['PATH', 'SystemRoot', 'TMPDIR', 'TEMP', 'TMP']
        .filter((key) => process.env[key])
        .map((key) => [key, process.env[key]]),
    );
    const report = json(
      run(
        process.execPath,
        [
          join(npmDir, 'bin/npm-cli.js'),
          'audit',
          'signatures',
          '--json',
          '--include-attestations',
          '--loglevel=verbose',
          '--ignore-scripts',
          '--fetch-retries=0',
          '--fetch-timeout=30000',
          '--registry=https://registry.npmjs.org/',
          `--userconfig=${join(temp, 'user.npmrc')}`,
          `--globalconfig=${join(temp, 'global.npmrc')}`,
          `--cache=${join(temp, 'npm-cache')}`,
        ],
        temp,
        publicEnv,
      ),
    );
    const source = provenanceSource(report, installed, integrity, policy);
    const gitEnv = {
      ...publicEnv,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    };
    const git = (args, cwd) => run('git', args, cwd, gitEnv);
    git(['init', '--bare', 'source.git'], temp);
    const repositoryDir = join(temp, 'source.git');
    git(
      [
        '-c',
        'core.hooksPath=/dev/null',
        'fetch',
        '--depth=1',
        '--no-tags',
        `${source.repository}.git`,
        source.commit,
      ],
      repositoryDir,
    );
    if (git(['rev-parse', 'FETCH_HEAD'], repositoryDir).trim() !== source.commit)
      throw new Error('Fetched source commit mismatch');
    const files = sourceLicenseFiles(installed, policy, source, (path) => {
      // Refuse symlinks/submodules: read a regular blob from the exact tree.
      const entry = git(['ls-tree', source.commit, '--', path], repositoryDir).trim();
      if (!/^100644 blob [a-f0-9]{40}\t/.test(entry) || entry.split('\t')[1] !== path)
        throw new Error(`Missing regular source file: ${path}`);
      return git(['show', `${source.commit}:${path}`], repositoryDir);
    });
    onVerified({
      dependency: `${installed.name}@${installed.version}`,
      integrity,
      ...source,
      files: files.map(({ name, text }) => ({
        name,
        bytes: Buffer.byteLength(text),
        sha256: createHash('sha256').update(text).digest('hex'),
      })),
    });
    return files;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
export function nodeRecords(graph, grouped, workspaceNames, loadMetadata) {
  if (!Array.isArray(graph) || !graph.length) throw new Error('Empty Node workspace inventory');
  const expected = new Set();
  const sources = new Map();
  const visit = (tree) => {
    for (const [dependencyName, dep] of Object.entries(tree ?? {})) {
      const name = dep.name ?? dep.from ?? dependencyName;
      if (dep.missing || !name || !dep.version)
        throw new Error('Incomplete installed Node dependency graph');
      if (!workspaceNames.has(name)) {
        const key = `${name}@${dep.version}`;
        expected.add(key);
        if (!sources.has(key)) sources.set(key, dep);
      }
      visit(dep.dependencies);
      visit(dep.optionalDependencies);
    }
  };
  for (const project of graph) {
    visit(project.dependencies);
    visit(project.optionalDependencies);
  }
  const records = new Map();
  for (const [kind, packages] of Object.entries(grouped)) {
    if (!Array.isArray(packages)) throw new Error('Malformed pnpm license output');
    for (const pkg of packages) {
      if (!pkg.name || !Array.isArray(pkg.versions) || !pkg.versions.length)
        throw new Error('Malformed Node license record');
      if (!workspaceNames.has(pkg.name))
        for (const version of pkg.versions) records.set(`${pkg.name}@${version}`, license(kind));
    }
  }
  if (loadMetadata) {
    const errors = [];
    for (const [key, dep] of sources) {
      try {
        if (!dep.path) throw new Error(`Missing installed metadata path: ${key}`);
        const installed = loadMetadata(dep.path, key);
        if (`${installed.name}@${installed.version}` !== key)
          throw new Error(`Installed identity mismatch: ${key}`);
        const kind = license(installed.license);
        if (records.has(key) && records.get(key) !== kind)
          throw new Error(`Conflicting license: ${key}`);
        records.set(key, kind);
      } catch (error) {
        errors.push(`${key}: ${error.message}`);
      }
    }
    if (errors.length) throw new Error(`Node attribution failed:\n${errors.join('\n')}`);
  }
  requireCoverage(expected, records, 'Node');
  for (const key of records.keys())
    if (!expected.has(key)) throw new Error(`Node: uninventoried attribution for ${key}`);
  return records;
}
export function rustRecords(metadata, attribution) {
  if (!Array.isArray(metadata.packages) || !metadata.resolve?.nodes)
    throw new Error('Incomplete Cargo metadata');
  const external = metadata.packages.filter((pkg) => pkg.source !== null);
  const expected = new Set(external.map((pkg) => `${pkg.name}@${pkg.version}`));
  const records = new Map();
  if (!Array.isArray(attribution.licenses)) throw new Error('Malformed cargo-about output');
  for (const item of attribution.licenses) {
    const kind = license(item.id);
    if (
      !Array.isArray(item.used_by) ||
      !item.text?.trim() ||
      typeof item.source_path !== 'string' ||
      !item.source_path
    )
      throw new Error('Incomplete Rust attribution');
    for (const { crate } of item.used_by) {
      const key = `${crate.name}@${crate.version}`;
      const prior = records.get(key);
      records.set(key, prior && prior !== kind ? `${prior} AND ${kind}` : kind);
    }
  }
  requireCoverage(expected, records, 'Rust');
  return records;
}
// RFC 4180 parser: quoted commas/newlines must never shift license columns.
export function csv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n')) {
      row.push(value.replace(/\r$/, ''));
      value = '';
      if (c === '\n') {
        rows.push(row);
        row = [];
      }
    } else value += c;
  }
  if (quoted) throw new Error('Unterminated CSV quote');
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}
export function goRecords(packages, report) {
  const records = new Map();
  for (const row of csv(report)) {
    if (row.length !== 3 || !row[0] || !/^https?:\/\//.test(row[1]))
      throw new Error('Incomplete Go attribution');
    const kind = license(row[2]);
    const prior = records.get(row[0]);
    records.set(
      row[0],
      prior && !prior.split(' AND ').includes(kind) ? `${prior} AND ${kind}` : (prior ?? kind),
    );
  }
  for (const pkg of packages) {
    if (pkg.Error || pkg.DepsErrors) throw new Error('Incomplete Go package inventory');
    if (pkg.Standard || pkg.Module?.Main) continue;
    if (!pkg.Module || !pkg.ImportPath) throw new Error('Missing Go module identity');
    const matching = [...records.keys()].filter(
      (key) => pkg.ImportPath === key || pkg.ImportPath.startsWith(`${key}/`),
    );
    if (!matching.length) throw new Error(`Go: missing attribution for ${pkg.ImportPath}`);
  }
  return records;
}
function jsonStream(text) {
  return json(text);
}
export function publish(rootDir, content, check = false) {
  const output = join(rootDir, 'NOTICE.md');
  if (check) {
    if (readFileSync(output, 'utf8') !== content)
      throw new Error('NOTICE.md is stale; regenerate verified attribution');
    return;
  }
  const temp = mkdtempSync(join(rootDir, '.notice-'));
  try {
    const path = join(temp, 'NOTICE.md');
    writeFileSync(path, content);
    renameSync(path, output);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
export function generate(rootDir = root, run = command, check = false, onVerified = () => {}) {
  // Preflight before inventory or any write; no implicit package installation.
  for (const tool of ['pnpm', 'cargo']) run(tool, ['--version'], rootDir);
  const aboutVersion = run('cargo-about', ['--version'], rootDir).trim();
  if (aboutVersion !== `cargo-about ${TOOL_VERSIONS.cargoAbout}`)
    throw new Error(`Expected cargo-about ${TOOL_VERSIONS.cargoAbout}; run notice:prepare-tools`);
  const goLicenseBuild = run(
    'go',
    ['version', '-m', join(rootDir, '.notice-tools/bin/go-licenses')],
    rootDir,
  );
  if (!goLicenseBuild.includes(`github.com/google/go-licenses/v2\t${TOOL_VERSIONS.goLicenses}`))
    throw new Error('Unverified go-licenses tool version; run notice:prepare-tools');
  run('go', ['version'], rootDir);
  run('go-licenses', ['--help'], rootDir);
  const graph = json(
    run(
      'pnpm',
      [
        'list',
        '--recursive',
        '--include-workspace-root',
        '--prod',
        '--depth',
        'Infinity',
        '--json',
      ],
      rootDir,
    ),
  );
  if (!Array.isArray(graph) || !graph.length) throw new Error('Empty workspace inventory');
  const workspaceNames = new Set(graph.map((pkg) => pkg.name));
  for (const project of graph) {
    if (!project.path) throw new Error('Missing workspace path');
    const manifest = json(readFileSync(join(project.path, 'package.json'), 'utf8'));
    for (const name of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    })) {
      if (!project.dependencies?.[name] && !project.optionalDependencies?.[name])
        throw new Error(`Missing installed dependency: ${name}`);
    }
  }
  const grouped = json(run('pnpm', ['licenses', 'list', '--prod', '--json'], rootDir));
  const texts = [];
  const nodes = nodeRecords(graph, grouped, workspaceNames, (path, key) => {
    const installed = json(readFileSync(join(path, 'package.json'), 'utf8'));
    if (`${installed.name}@${installed.version}` !== key)
      throw new Error(`Installed identity mismatch: ${key}`);
    let files;
    try {
      files = licenseFiles(path);
    } catch (error) {
      if (!error.message.startsWith('Missing installed license files:')) throw error;
      files = [
        ...licenseFiles(path, [], false),
        ...verifiedNodeLicenseFiles(rootDir, installed, run, onVerified),
      ];
    }
    texts.push({ ecosystem: 'Node.js', dependency: key, files });
    return installed;
  });
  const rust = new Map();
  const rustManifests = manifests(rootDir, 'Cargo.toml');
  if (!rustManifests.length) throw new Error('Missing Rust manifest inventory');
  for (const manifest of rustManifests) {
    const metadata = json(
      run(
        'cargo',
        ['metadata', '--locked', '--format-version', '1', '--manifest-path', manifest],
        rootDir,
      ),
    );
    const attribution = json(
      run(
        'cargo-about',
        [
          'generate',
          '--locked',
          '--fail',
          '--format',
          'json',
          '--manifest-path',
          manifest,
          '--config',
          join(rootDir, 'apps/studio/src-tauri/about.toml'),
        ],
        rootDir,
      ),
    );
    for (const [key, value] of rustRecords(metadata, attribution)) rust.set(key, value);
    for (const pkg of metadata.packages.filter((pkg) => pkg.source !== null)) {
      if (!pkg.manifest_path) throw new Error(`Missing installed Cargo manifest: ${pkg.name}`);
      texts.push({
        ecosystem: 'Rust',
        dependency: `${pkg.name}@${pkg.version}`,
        files: licenseFiles(dirname(pkg.manifest_path), [
          ...(pkg.license_file ? [resolve(dirname(pkg.manifest_path), pkg.license_file)] : []),
          ...attribution.licenses
            .filter((item) =>
              item.used_by.some(
                ({ crate }) => crate.name === pkg.name && crate.version === pkg.version,
              ),
            )
            .map((item) => item.source_path),
        ]),
      });
    }
    for (const item of attribution.licenses) {
      const sourceText = readFileSync(item.source_path, 'utf8');
      if (!sourceText.trim() || sourceText.includes('\uFFFD'))
        throw new Error(`Unreadable Rust source text: ${item.source_path}`);
      texts.push({
        ecosystem: 'Rust',
        dependency: item.used_by
          .map(({ crate }) => `${crate.name}@${crate.version}`)
          .sort()
          .join(', '),
        files: [
          { name: item.id, text: item.text },
          { name: `${item.id} source`, text: sourceText },
        ],
      });
    }
  }
  const go = new Map();
  const goManifests = manifests(rootDir, 'go.mod');
  if (!goManifests.length) throw new Error('Missing Go manifest inventory');
  for (const manifest of goManifests) {
    for (const [goos, goarch] of GO_RELEASE_TARGETS) {
      const goEnv = {
        ...process.env,
        GOOS: goos,
        GOARCH: goarch,
        CGO_ENABLED: '0',
        GOFLAGS: '-mod=readonly',
      };
      const cwd = dirname(manifest);
      const stream = run('go', ['list', '-mod=readonly', '-deps', '-json', './...'], cwd, goEnv);
      // Split at top-level object boundaries without trusting brace characters in strings.
      let depth = 0;
      let quoted = false;
      let escaped = false;
      let start = 0;
      let end = 0;
      const packages = [];
      for (let i = 0; i < stream.length; i++) {
        const c = stream[i];
        if (quoted) {
          if (escaped) escaped = false;
          else if (c === '\\') escaped = true;
          else if (c === '"') quoted = false;
        } else if (c === '"') quoted = true;
        else if (c === '{') {
          if (depth++ === 0) {
            if (stream.slice(end, i).trim()) throw new Error('Unexpected Go JSON content');
            start = i;
          }
        } else if (c === '}' && --depth === 0) {
          packages.push(jsonStream(stream.slice(start, i + 1)));
          end = i + 1;
        }
      }
      if (depth || quoted || stream.slice(end).trim() || !packages.length)
        throw new Error('Incomplete Go JSON inventory');
      const report = run('go-licenses', ['report', './...'], cwd, goEnv);
      const verified = goRecords(packages, report);
      const attribution = json(
        run(
          'go-licenses',
          ['report', './...', '--template', join(rootDir, 'scripts/go-notice.tmpl')],
          cwd,
          goEnv,
        ),
      );
      if (!Array.isArray(attribution)) throw new Error('Malformed Go text attribution');
      const withText = new Map();
      for (const item of attribution) {
        if (
          !item.name ||
          !item.text?.trim() ||
          typeof item.path !== 'string' ||
          !item.path ||
          !verified.get(item.name)?.split(' AND ').includes(license(item.license))
        )
          throw new Error('Incomplete Go license text');
        if (readFileSync(item.path, 'utf8') !== item.text)
          throw new Error(`Go license text differs from source: ${item.name}`);
        const prior = withText.get(item.name);
        withText.set(
          item.name,
          prior && !prior.split(' AND ').includes(item.license)
            ? `${prior} AND ${item.license}`
            : (prior ?? item.license),
        );
        texts.push({
          ecosystem: 'Go',
          dependency: item.name,
          files: licenseFiles(dirname(item.path)),
        });
      }
      requireCoverage(verified.keys(), withText, 'Go text');
      for (const [name, kind] of verified)
        if (withText.get(name) !== kind) throw new Error(`Missing Go license text: ${name}`);
      for (const [key, value] of verified) go.set(key, value);
    }
  }
  const escapeCell = (value) => value.replaceAll('|', '&#124;').replaceAll('\n', ' ');
  let content =
    '# Third-Party Notices\n\nAuto-generated from verified dependency inventories. Regenerate with `bash scripts/generate-notice.sh`.\n';
  for (const [title, records] of [
    ['Node.js', nodes],
    ['Rust', rust],
    ['Go', go],
  ]) {
    content += `\n## ${title} Dependencies\n\n| Dependency | License |\n|---|---|\n`;
    for (const [key, value] of [...records].sort(([a], [b]) => compareText(a, b)))
      content += `| ${escapeCell(key)} | ${escapeCell(value)} |\n`;
  }
  content += '\n## License texts and notices\n';
  const emitted = new Set();
  for (const item of texts.sort((a, b) =>
    compareText(`${a.ecosystem}:${a.dependency}`, `${b.ecosystem}:${b.dependency}`),
  )) {
    const identity = JSON.stringify(item);
    if (emitted.has(identity)) continue;
    emitted.add(identity);
    content += `\n### ${escapeCell(item.ecosystem)}: ${escapeCell(item.dependency)}\n`;
    for (const file of item.files) {
      const fence = '`'.repeat(
        Math.max(3, ...[...file.text.matchAll(/`+/g)].map((match) => match[0].length + 1)),
      );
      content += `\n${escapeCell(file.name)}\n\n${fence}text\n${file.text.trimEnd()}\n${fence}\n`;
    }
  }
  publish(rootDir, content, check);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((arg) => !['--check', '--prepare-tools'].includes(arg)))
      throw new Error('Supported options: --check, --prepare-tools');
    if (process.argv.includes('--prepare-tools') && process.argv.includes('--check'))
      throw new Error('Tool preparation and checking are separate operations');
    if (process.argv.includes('--prepare-tools')) prepareTools();
    else
      generate(root, command, process.argv.includes('--check'), (receipt) =>
        console.log(`Verified npm source: ${JSON.stringify(receipt)}`),
      );
  } catch (error) {
    console.error(`NOTICE generation refused: ${error.message}`);
    process.exitCode = 1;
  }
}
