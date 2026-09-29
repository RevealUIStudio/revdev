import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function command(tool, args, cwd) {
  const result = spawnSync(tool, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error || result.status !== 0)
    throw new Error(`${tool} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
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
    if (['node_modules', '.git', 'target', 'dist', '.next'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...manifests(path, name));
    else if (entry.name === name) result.push(path);
  }
  return result.sort();
}
export function nodeRecords(graph, grouped, workspaceNames) {
  if (!Array.isArray(graph) || !graph.length) throw new Error('Empty Node workspace inventory');
  const expected = new Set();
  const visit = (tree) => {
    for (const [dependencyName, dep] of Object.entries(tree ?? {})) {
      const name = dep.name ?? dep.from ?? dependencyName;
      if (dep.missing || !name || !dep.version)
        throw new Error('Incomplete installed Node dependency graph');
      if (!workspaceNames.has(name)) expected.add(`${name}@${dep.version}`);
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
  requireCoverage(expected, records, 'Node');
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
    if (!Array.isArray(item.used_by) || !item.text?.trim())
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
    records.set(row[0], license(row[2]));
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
  // go list emits adjacent JSON objects; request a JSON array through its template instead.
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
  for (const tool of ['pnpm', 'cargo', 'cargo-about']) run(tool, ['--version'], rootDir);
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
  const nodes = nodeRecords(graph, grouped, workspaceNames);
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
  }
  const go = new Map();
  const goManifests = manifests(rootDir, 'go.mod');
  if (!goManifests.length) throw new Error('Missing Go manifest inventory');
  for (const manifest of goManifests) {
    const cwd = dirname(manifest);
    const stream = run('go', ['list', '-mod=readonly', '-deps', '-json', './...'], cwd);
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
    const report = run('go-licenses', ['report', './...'], cwd);
    for (const [key, value] of goRecords(packages, report)) go.set(key, value);
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
    for (const [key, value] of [...records].sort(([a], [b]) => a.localeCompare(b)))
      content += `| ${escapeCell(key)} | ${escapeCell(value)} |\n`;
  }
  publish(rootDir, content, check);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== '--check'))
      throw new Error('Supported option: --check');
    generate(root, command, process.argv.includes('--check'));
  } catch (error) {
    console.error(`NOTICE generation refused: ${error.message}`);
    process.exitCode = 1;
  }
}
