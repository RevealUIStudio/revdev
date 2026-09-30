import { spawnSync } from 'node:child_process';
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
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(`${tool} failed: ${result.error?.message ?? result.stderr}`);
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
export function licenseFiles(packageDir, sourcePaths = []) {
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
        if (
          section &&
          /copyright/i.test(section) &&
          /permission is hereby granted, free of charge/i.test(section) &&
          /the above copyright notice and this permission notice shall be included/i.test(
            section,
          ) &&
          /the software is provided ["“]as is["”]/i.test(section) &&
          /in no event shall the authors or copyright holders be liable/i.test(section)
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
  if (loadMetadata)
    for (const [key, dep] of sources) {
      if (!dep.path) throw new Error(`Missing installed metadata path: ${key}`);
      const installed = loadMetadata(dep.path, key);
      if (`${installed.name}@${installed.version}` !== key)
        throw new Error(`Installed identity mismatch: ${key}`);
      const kind = license(installed.license);
      if (records.has(key) && records.get(key) !== kind)
        throw new Error(`Conflicting license: ${key}`);
      records.set(key, kind);
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
export function generate(rootDir = root, run = command, check = false) {
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
    const files = licenseFiles(path);
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
    else generate(root, command, process.argv.includes('--check'));
  } catch (error) {
    console.error(`NOTICE generation refused: ${error.message}`);
    process.exitCode = 1;
  }
}
