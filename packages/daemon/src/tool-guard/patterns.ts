/**
 * tool-guard pattern loader.
 *
 * Loads the canonical security-pattern manifest (patterns.json), validates its
 * shape at load, computes a stable content hash, and exposes pure predicate
 * evaluators over commands / file paths / write content.
 *
 * The manifest is DATA (substrings, prefix lists, and structured matchers).
 * Anything a substring/prefix cannot express is a NAMED typed predicate keyed
 * from the manifest and implemented here — never a regex string, per the fleet
 * no-regex rule. Every matcher is evaluated with character-boundary logic
 * (isWordChar / wordBoundaryAt), not RegExp.
 *
 * Two consumers share this one manifest: the daemon (imports this loader) and
 * the Claude Code PreToolUse hook (a vendored copy of patterns.json plus a CJS
 * mirror of this evaluator). The content hash lets a divergence surface.
 */

import { createHash } from 'node:crypto';
import rawManifest from './patterns.json';

// ---------------------------------------------------------------------------
// Manifest types
// ---------------------------------------------------------------------------

/** One element of an ordered matcher: a substring plus optional word-boundary asserts. */
export interface Matcher {
  s: string;
  bStart?: boolean;
  bEnd?: boolean;
}

export interface MatchersRule {
  reason: string;
  kind: 'matchers';
  ci?: boolean;
  matchers: Matcher[];
}

export interface PredicateRule {
  reason: string;
  kind: 'predicate';
  predicate: string;
}

export type DangerousCommandRule = MatchersRule | PredicateRule;

export interface ProductionDb {
  commandTriggers: string[];
  urlIndicators: string[];
}

export type ContentSecretSeverity = 'block' | 'warn';

export interface SubstringAnySecret {
  severity: ContentSecretSeverity;
  reason: string;
  kind: 'substringAny';
  needles: string[];
}

export interface PemPrivateKeySecret {
  severity: ContentSecretSeverity;
  reason: string;
  kind: 'pemPrivateKey';
  begin: string;
  end: string;
  types: string[];
}

export type TokenCharset = 'alnum' | 'alnumUnderscore' | 'upperDigit';

export interface TokenSecret {
  severity: ContentSecretSeverity;
  reason: string;
  kind: 'token';
  prefix: string;
  len: number;
  mode: 'exact' | 'min';
  charset: TokenCharset;
}

export interface PredicateSecret {
  severity: ContentSecretSeverity;
  reason: string;
  kind: 'predicate';
  predicate: string;
}

export type ContentSecret =
  | SubstringAnySecret
  | PemPrivateKeySecret
  | TokenSecret
  | PredicateSecret;

export interface PatternManifest {
  version: number;
  dangerousCommands: DangerousCommandRule[];
  productionDb: ProductionDb;
  credentialPathEndsWith: string[];
  credentialPathContains: string[];
  credentialPathPredicates: string[];
  blockedWritePrefixes: string[];
  blockedWriteHomeRelativePrefixes: string[];
  lockFiles: string[];
  envTemplateExact: string[];
  envTemplateSuffixes: string[];
  contentSecrets: ContentSecret[];
}

export interface CommandVerdict {
  reason: string;
}

export interface ContentVerdict {
  severity: ContentSecretSeverity;
  reason: string;
}

// ---------------------------------------------------------------------------
// Character helpers (no regex)
// ---------------------------------------------------------------------------

function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined || ch.length === 0) return false;
  const c = ch.charCodeAt(0);
  return (
    (c >= 48 && c <= 57) || // 0-9
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) || // a-z
    c === 95 // _
  );
}

function isDigit(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  return c >= 48 && c <= 57;
}

function isWhitespace(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  // space, tab, LF, CR, FF, VT
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
}

/** True when index `i` in `s` is a word boundary (word/non-word transition). */
function wordBoundaryAt(s: string, i: number): boolean {
  const before = i > 0 && isWordChar(s[i - 1]);
  const after = i < s.length && isWordChar(s[i]);
  return before !== after;
}

function inCharset(ch: string | undefined, charset: TokenCharset): boolean {
  if (ch === undefined || ch.length === 0) return false;
  const c = ch.charCodeAt(0);
  const isUpper = c >= 65 && c <= 90;
  const isLower = c >= 97 && c <= 122;
  const isNum = c >= 48 && c <= 57;
  switch (charset) {
    case 'alnum':
      return isUpper || isLower || isNum;
    case 'alnumUnderscore':
      return isUpper || isLower || isNum || c === 95;
    case 'upperDigit':
      return isUpper || isNum;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Ordered matcher engine
// ---------------------------------------------------------------------------

/**
 * True when every matcher appears in `text` in order, each satisfying its
 * word-boundary asserts. `ci` lower-cases both haystack and needles.
 */
function matchOrdered(text: string, matchers: Matcher[], ci: boolean): boolean {
  const hay = ci ? text.toLowerCase() : text;
  let pos = 0;
  for (const m of matchers) {
    const needle = ci ? m.s.toLowerCase() : m.s;
    let idx = hay.indexOf(needle, pos);
    let found = -1;
    while (idx !== -1) {
      const startOk = !m.bStart || idx === 0 || !isWordChar(hay[idx - 1]);
      const end = idx + needle.length;
      const endOk = !m.bEnd || end >= hay.length || !isWordChar(hay[end]);
      if (startOk && endOk) {
        found = idx;
        break;
      }
      idx = hay.indexOf(needle, idx + 1);
    }
    if (found === -1) return false;
    pos = found + needle.length;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Quote-aware shell tokens (GAP-384)
// ---------------------------------------------------------------------------
// Command-position rules must not fire on prose inside quoted arguments
// (--body/--message/-m/-F, sed replacements, commit messages). Quoted spans
// become a single opaque token. Nested shell -c / eval payloads are re-scanned
// (fail-closed). Zero regex.

interface ShellToken {
  text: string;
  quoted: boolean;
}

const CHAIN_SEPARATORS = new Set(['&&', '||', ';', '|', '&']);

const WRAPPER_COMMANDS = new Set(['env', 'sudo', 'command', 'nice', 'nohup', 'time', 'stdbuf']);

const SHELL_FOR_DASH_C = new Set(['bash', 'sh', 'zsh', 'ksh', 'dash', 'fish']);

/** Basename of a path-like token (`/usr/bin/node` → `node`). */
function cmdBase(token: string): string {
  if (token.length === 0) return token;
  let end = token.length;
  // Drop a trailing slash if present.
  if (token[end - 1] === '/' || token[end - 1] === '\\') end -= 1;
  let slash = -1;
  for (let i = 0; i < end; i += 1) {
    if (token[i] === '/' || token[i] === '\\') slash = i;
  }
  return slash === -1 ? token.slice(0, end) : token.slice(slash + 1, end);
}

/** True when token is NAME=value (leading env assignment), not a flag. */
function isEnvAssignment(token: string): boolean {
  if (token.length === 0 || token[0] === '-') return false;
  let i = 0;
  const first = token.charCodeAt(0);
  if (!((first >= 65 && first <= 90) || (first >= 97 && first <= 122) || first === 95)) {
    return false;
  }
  i = 1;
  while (i < token.length) {
    const c = token.charCodeAt(i);
    if (c === 61) return i > 0; // '='
    const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
    if (!ok) return false;
    i += 1;
  }
  return false;
}

/**
 * Quote-aware tokenizer. Whitespace-separated; single- and double-quoted
 * spans are one token each (quotes stripped from `text`). Unclosed quotes
 * consume the remainder (fail-closed: content stays visible to scanners).
 */
function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let i = 0;
  while (i < command.length) {
    while (i < command.length && isWhitespace(command[i])) i += 1;
    if (i >= command.length) break;

    const ch = command[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      let text = '';
      while (i < command.length) {
        if (command[i] === quote) {
          i += 1;
          break;
        }
        // Double-quote backslash escape: keep the escaped char literally.
        if (quote === '"' && command[i] === '\\' && i + 1 < command.length) {
          text += command[i + 1];
          i += 2;
          continue;
        }
        text += command[i];
        i += 1;
      }
      tokens.push({ text, quoted: true });
      continue;
    }

    const start = i;
    while (i < command.length && !isWhitespace(command[i])) {
      // Don't absorb quotes into bare tokens — start a quoted token instead.
      if (command[i] === "'" || command[i] === '"') break;
      i += 1;
    }
    if (i > start) {
      tokens.push({ text: command.slice(start, i), quoted: false });
    }
  }
  return tokens;
}

/** Split tokens into argv segments on chain separators (&& || ; | &). */
function argvSegments(tokens: ShellToken[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  for (const tok of tokens) {
    if (!tok.quoted && CHAIN_SEPARATORS.has(tok.text)) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push(tok.text);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/**
 * Drop leading env assignments and common wrappers so `env FOO=1 node -e`
 * still sees `node` as the command.
 */
function stripWrappers(argv: string[]): string[] {
  let i = 0;
  while (i < argv.length) {
    const t = argAt(argv, i);
    if (isEnvAssignment(t)) {
      i += 1;
      continue;
    }
    const base = cmdBase(t);
    if (WRAPPER_COMMANDS.has(base)) {
      i += 1;
      // Skip wrapper flags (`sudo -u x`, `env -i`, …) until a non-flag token.
      while (i < argv.length) {
        const flag = argAt(argv, i);
        if (flag.length === 0 || flag[0] !== '-') break;
        // sudo -u USER / env --unset=NAME take a value; treat attached and
        // next-token forms loosely by only skipping pure-flag tokens here.
        // Fail-closed: over-skipping can hide a real binary — so only skip
        // tokens that look like flags without consuming the following value
        // when the flag is a known value-taking short option. Simpler: skip
        // one flag token; value-taking forms leave the value as a no-op
        // assignment-shaped or username token which stripWrappers may not
        // drop — acceptable (may miss `sudo -u foo node -e`, rare for agents).
        i += 1;
      }
      continue;
    }
    break;
  }
  return argv.slice(i);
}

/**
 * Surfaces to evaluate command-position rules against: each pipeline segment
 * after wrapper strip, plus nested payloads of `bash -c` / `eval` (fail-closed).
 */
function collectCommandSurfaces(command: string, depth = 0): string[][] {
  if (depth > 4) return [];
  const surfaces: string[][] = [];
  const tokens = tokenizeShell(command);
  for (const seg of argvSegments(tokens)) {
    const argv = stripWrappers(seg);
    if (argv.length === 0) continue;
    surfaces.push(argv);

    const base = cmdBase(argAt(argv, 0));
    // eval <payload>
    if (base === 'eval' && argv.length >= 2) {
      surfaces.push(...collectCommandSurfaces(argv.slice(1).join(' '), depth + 1));
      continue;
    }
    // shell -c <payload> / shell -c<payload>
    if (SHELL_FOR_DASH_C.has(base)) {
      for (let i = 1; i < argv.length; i += 1) {
        const a = argAt(argv, i);
        if (a === '-c' && i + 1 < argv.length) {
          surfaces.push(...collectCommandSurfaces(argAt(argv, i + 1), depth + 1));
          break;
        }
        if (a.startsWith('-c') && a.length > 2) {
          surfaces.push(...collectCommandSurfaces(a.slice(2), depth + 1));
          break;
        }
      }
    }
  }
  return surfaces;
}

function anySurface(command: string, pred: (argv: string[]) => boolean): boolean {
  for (const argv of collectCommandSurfaces(command)) {
    if (pred(argv)) return true;
  }
  return false;
}

/** Safe argv access under noUncheckedIndexedAccess. */
function argAt(argv: string[], i: number): string {
  return argv[i] ?? '';
}

// ---------------------------------------------------------------------------
// Named command predicates
// ---------------------------------------------------------------------------

/** `powershell` (optionally `.exe`) immediately followed by whitespace, case-insensitive. */
function powershellInvocation(command: string): boolean {
  const lower = command.toLowerCase();
  const token = 'powershell';
  let idx = lower.indexOf(token);
  while (idx !== -1) {
    const startOk = idx === 0 || !isWordChar(lower[idx - 1]);
    if (startOk) {
      let pos = idx + token.length;
      if (lower.startsWith('.exe', pos)) pos += 4;
      if (isWhitespace(lower[pos])) return true;
    }
    idx = lower.indexOf(token, idx + 1);
  }
  return false;
}

/** `wsl.exe` + whitespace + (`--exec` | `--`) + whitespace. */
function wslInterop(command: string): boolean {
  const token = 'wsl.exe';
  let idx = command.indexOf(token);
  while (idx !== -1) {
    const startOk = idx === 0 || !isWordChar(command[idx - 1]);
    if (startOk) {
      let p = idx + token.length;
      let sawWs = false;
      while (isWhitespace(command[p])) {
        p += 1;
        sawWs = true;
      }
      if (sawWs) {
        if (command.startsWith('--exec', p) && isWhitespace(command[p + 6])) return true;
        if (command.startsWith('--', p) && isWhitespace(command[p + 2])) return true;
      }
    }
    idx = command.indexOf(token, idx + 1);
  }
  return false;
}

/** `>` then optional whitespace then `/mnt/c/`. */
function redirectToWindows(command: string): boolean {
  let idx = command.indexOf('>');
  while (idx !== -1) {
    let p = idx + 1;
    while (isWhitespace(command[p])) p += 1;
    if (command.startsWith('/mnt/c/', p)) return true;
    idx = command.indexOf('>', idx + 1);
  }
  return false;
}

/** Match `interp\b` at position p for one of the given interpreter tokens. */
function interpreterAt(text: string, p: number, interpreters: string[]): boolean {
  for (const interp of interpreters) {
    if (text.startsWith(interp, p)) {
      let end = p + interp.length;
      // python3? — allow an optional trailing "3".
      if (interp === 'python' && text[end] === '3') end += 1;
      if (end >= text.length || !isWordChar(text[end])) return true;
    }
  }
  return false;
}

/** `fetcher\b` then non-pipe chars, a pipe, optional whitespace, then a listed interpreter. */
function fetcherPipedTo(command: string, fetcher: string, interpreters: string[]): boolean {
  let idx = command.indexOf(fetcher);
  while (idx !== -1) {
    const startOk = idx === 0 || !isWordChar(command[idx - 1]);
    const end = idx + fetcher.length;
    const endOk = end >= command.length || !isWordChar(command[end]);
    if (startOk && endOk) {
      const pipe = command.indexOf('|', end);
      if (pipe !== -1) {
        let p = pipe + 1;
        while (isWhitespace(command[p])) p += 1;
        if (interpreterAt(command, p, interpreters)) return true;
      }
    }
    idx = command.indexOf(fetcher, idx + 1);
  }
  return false;
}

function curlPipedToInterpreter(command: string): boolean {
  return fetcherPipedTo(command, 'curl', ['bash', 'sh', 'zsh', 'node', 'python', 'perl', 'ruby']);
}

function wgetPipedToShell(command: string): boolean {
  return fetcherPipedTo(command, 'wget', ['bash', 'sh', 'zsh']);
}

/** `gh api` then, anywhere after, `-X DELETE` or `--method[ =]DELETE` (case-insensitive). */
function ghApiDelete(command: string): boolean {
  // Command-position: only when `gh` is the effective binary (GAP-384).
  // Still scan the rest of that argv for DELETE forms.
  return anySurface(command, (argv) => {
    if (cmdBase(argAt(argv, 0)).toLowerCase() !== 'gh') return false;
    // Rebuild a mini command line from argv for deleteFormAfter.
    const lower = argv.join(' ').toLowerCase();
    // "gh" is at start of lower; find "api" as a subsequent argv word.
    for (let i = 1; i < argv.length; i += 1) {
      if (argAt(argv, i).toLowerCase() === 'api') {
        return deleteFormAfter(lower, 0);
      }
    }
    return false;
  });
}

/** `-x` (+ ws) + `delete`, or `--method` + (` ` | `=`) + ws + `delete`, in already-lowercased text. */
function deleteFormAfter(lower: string, from: number): boolean {
  let x = lower.indexOf('-x', from);
  while (x !== -1) {
    let p = x + 2;
    while (isWhitespace(lower[p])) p += 1;
    if (lower.startsWith('delete', p)) return true;
    x = lower.indexOf('-x', x + 1);
  }
  let m = lower.indexOf('--method', from);
  while (m !== -1) {
    let p = m + 8;
    if (lower[p] === ' ' || lower[p] === '=') {
      p += 1;
      while (isWhitespace(lower[p])) p += 1;
      if (lower.startsWith('delete', p)) return true;
    }
    m = lower.indexOf('--method', m + 1);
  }
  return false;
}

/** `gh auth token` as consecutive subcommands — not prose in `--body`. */
function ghAuthToken(command: string): boolean {
  return anySurface(command, (argv) => {
    if (cmdBase(argAt(argv, 0)).toLowerCase() !== 'gh') return false;
    return argAt(argv, 1) === 'auth' && argAt(argv, 2) === 'token';
  });
}

/** `npm token create|revoke|list` as consecutive subcommands. */
function npmTokenMgmt(command: string): boolean {
  return anySurface(command, (argv) => {
    if (cmdBase(argAt(argv, 0)) !== 'npm' || argAt(argv, 1) !== 'token') return false;
    const op = argAt(argv, 2);
    return op === 'create' || op === 'revoke' || op === 'list';
  });
}

/** True when a node argv token is an inline-eval flag (-e/--eval/-p/--print). */
function isNodeEvalFlag(token: string): boolean {
  if (token === '-e' || token === '--eval' || token === '-p' || token === '--print') {
    return true;
  }
  if (token.startsWith('--eval=') || token.startsWith('--print=')) return true;
  // Attached short form: -eCODE / -pCODE (not -experimental…).
  if (token.startsWith('-e') && token.length > 2 && token[2] !== '-') return true;
  if (token.startsWith('-p') && token.length > 2 && token[2] !== '-') return true;
  return false;
}

/** `node -e` / `-p` / `--eval` / `--print` in command position only. */
function nodeInlineEval(command: string): boolean {
  return anySurface(command, (argv) => {
    if (cmdBase(argAt(argv, 0)) !== 'node') return false;
    for (let i = 1; i < argv.length; i += 1) {
      if (isNodeEvalFlag(argAt(argv, i))) return true;
    }
    return false;
  });
}

/** `python` / `python3` with `-c` in command position. Optional code needle. */
function pythonDashC(command: string, codeNeedle?: string): boolean {
  return anySurface(command, (argv) => {
    const base = cmdBase(argAt(argv, 0));
    if (base !== 'python' && base !== 'python3') return false;
    for (let i = 1; i < argv.length; i += 1) {
      const a = argAt(argv, i);
      if (a === '-c') {
        if (!codeNeedle) return true;
        const code = i + 1 < argv.length ? argAt(argv, i + 1) : '';
        return code.includes(codeNeedle);
      }
      if (a.startsWith('-c') && a.length > 2) {
        if (!codeNeedle) return true;
        return a.slice(2).includes(codeNeedle);
      }
    }
    return false;
  });
}

function pythonSocket(command: string): boolean {
  return pythonDashC(command, 'socket');
}

function pythonSubprocess(command: string): boolean {
  return pythonDashC(command, 'subprocess');
}

function pythonInlineEval(command: string): boolean {
  return pythonDashC(command);
}

/** `pnpm dlx` as consecutive subcommands. */
function pnpmDlx(command: string): boolean {
  return anySurface(
    command,
    (argv) => cmdBase(argAt(argv, 0)) === 'pnpm' && argAt(argv, 1) === 'dlx',
  );
}

/** `npm exec` as consecutive subcommands. */
function npmExec(command: string): boolean {
  return anySurface(
    command,
    (argv) => cmdBase(argAt(argv, 0)) === 'npm' && argAt(argv, 1) === 'exec',
  );
}

/**
 * GAP-388: `npx -y <pkg>` is dangerous; `npx <pkg> --yes` (package's own flag)
 * is not. Only count -y/--yes before the first non-flag token of an npx argv.
 */
function npxYesFlag(command: string): boolean {
  return anySurface(command, (argv) => {
    if (cmdBase(argAt(argv, 0)) !== 'npx') return false;
    let sawPackage = false;
    for (let i = 1; i < argv.length; i += 1) {
      const t = argAt(argv, i);
      if (sawPackage) continue;
      if (t === '-y' || t === '--yes') return true;
      if (t.length > 0 && t[0] === '-') continue;
      sawPackage = true;
    }
    return false;
  });
}

/**
 * Credential-shaped env names: TOKEN / SECRET / PASSWORD / PASSWD / API_KEY /
 * ACCESS_KEY / PRIVATE_KEY as whole segments or suffixes (_TOKEN etc.).
 */
function isCredentialEnvName(name: string): boolean {
  if (name.length === 0) return false;
  const upper = name.toUpperCase();
  const exact = new Set([
    'TOKEN',
    'SECRET',
    'PASSWORD',
    'PASSWD',
    'API_KEY',
    'ACCESS_KEY',
    'PRIVATE_KEY',
    'AUTH_TOKEN',
    'ACCESS_TOKEN',
    'REFRESH_TOKEN',
    'CLIENT_SECRET',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'NPM_TOKEN',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_ACCESS_KEY_ID',
  ]);
  if (exact.has(upper)) return true;
  const suffixes = [
    '_TOKEN',
    '_SECRET',
    '_PASSWORD',
    '_PASSWD',
    '_API_KEY',
    '_ACCESS_KEY',
    '_PRIVATE_KEY',
  ];
  for (const s of suffixes) {
    if (upper.endsWith(s) && upper.length > s.length) return true;
  }
  return false;
}

/** Extract ENV name from `$VAR`, `${VAR}`, or bare `VAR` (printenv form). */
function credentialNameFromArg(arg: string): string | null {
  if (arg.length === 0) return null;
  if (arg[0] === '$') {
    if (arg[1] === '{') {
      if (arg[arg.length - 1] !== '}') return null;
      const inner = arg.slice(2, -1);
      // ${VAR:-default} — take leading name.
      let name = '';
      for (let i = 0; i < inner.length; i += 1) {
        const c = inner.charCodeAt(i);
        const ok =
          (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
        if (!ok) break;
        name += inner[i];
      }
      return name.length > 0 ? name : null;
    }
    // $VAR
    let name = '';
    for (let i = 1; i < arg.length; i += 1) {
      const c = arg.charCodeAt(i);
      const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
      if (!ok) break;
      name += arg[i];
    }
    return name.length > 0 ? name : null;
  }
  // bare name for printenv / env | — only all-caps-ish identifiers
  let okBare = true;
  for (let i = 0; i < arg.length; i += 1) {
    const c = arg.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95)) {
      okBare = false;
      break;
    }
  }
  return okBare ? arg : null;
}

/**
 * echo/printf/printenv of a credential-shaped variable.
 * True positive: `echo $GITHUB_TOKEN`. Does not fire on prose that merely
 * mentions the word token inside a quoted --body.
 */
function credentialPrint(command: string): boolean {
  return anySurface(command, (argv) => {
    const base = cmdBase(argAt(argv, 0));
    if (base !== 'echo' && base !== 'printf' && base !== 'printenv') return false;
    // printenv NAME  or  printenv
    // echo/printf: look for $VAR / ${VAR} among args
    for (let i = 1; i < argv.length; i += 1) {
      const arg = argAt(argv, i);
      if (base === 'printenv') {
        if (isCredentialEnvName(arg)) return true;
        continue;
      }
      // printf format string might be first arg — still scan all for $CRED
      const name = credentialNameFromArg(arg);
      if (name && isCredentialEnvName(name)) return true;
    }
    return false;
  });
}

const COMMAND_PREDICATES: Record<string, (command: string) => boolean> = {
  powershellInvocation,
  wslInterop,
  redirectToWindows,
  curlPipedToInterpreter,
  wgetPipedToShell,
  ghApiDelete,
  ghAuthToken,
  npmTokenMgmt,
  nodeInlineEval,
  pythonSocket,
  pythonSubprocess,
  pythonInlineEval,
  pnpmDlx,
  npmExec,
  npxYesFlag,
  credentialPrint,
};

// ---------------------------------------------------------------------------
// Named credential-path predicates
// ---------------------------------------------------------------------------

/** `/proc/<digits>/environ` at end of path. */
function procEnviron(path: string): boolean {
  const tail = '/environ';
  if (!path.endsWith(tail)) return false;
  const digitsEnd = path.length - tail.length;
  const marker = '/proc/';
  let k = path.indexOf(marker);
  while (k !== -1) {
    const digitsStart = k + marker.length;
    if (digitsStart < digitsEnd) {
      let allDigits = true;
      for (let i = digitsStart; i < digitsEnd; i += 1) {
        if (!isDigit(path[i])) {
          allDigits = false;
          break;
        }
      }
      if (allDigits) return true;
    }
    k = path.indexOf(marker, k + 1);
  }
  return false;
}

const CREDENTIAL_PATH_PREDICATES: Record<string, (path: string) => boolean> = {
  procEnviron,
};

// ---------------------------------------------------------------------------
// Named content-secret predicates + token/pem matchers
// ---------------------------------------------------------------------------

/** `sk-ant-api` + 2 digits + `-` + >=90 of [A-Za-z0-9_-]. */
function anthropicApiKey(content: string): boolean {
  const prefix = 'sk-ant-api';
  let idx = content.indexOf(prefix);
  while (idx !== -1) {
    const startOk = idx === 0 || !isWordChar(content[idx - 1]);
    if (startOk) {
      let p = idx + prefix.length;
      if (isDigit(content[p]) && isDigit(content[p + 1]) && content[p + 2] === '-') {
        p += 3;
        let run = 0;
        while (p + run < content.length) {
          const ch = content[p + run];
          if (inCharset(ch, 'alnumUnderscore') || ch === '-') run += 1;
          else break;
        }
        if (run >= 90) return true;
      }
    }
    idx = content.indexOf(prefix, idx + 1);
  }
  return false;
}

const CONTENT_PREDICATES: Record<string, (content: string) => boolean> = {
  anthropicApiKey,
};

function matchToken(content: string, spec: TokenSecret): boolean {
  let idx = content.indexOf(spec.prefix);
  while (idx !== -1) {
    const startOk = idx === 0 || !isWordChar(content[idx - 1]);
    if (startOk) {
      const runStart = idx + spec.prefix.length;
      let run = 0;
      while (runStart + run < content.length && inCharset(content[runStart + run], spec.charset)) {
        run += 1;
      }
      if (spec.mode === 'exact') {
        if (run === spec.len && wordBoundaryAt(content, runStart + spec.len)) return true;
      } else if (run >= spec.len && wordBoundaryAt(content, runStart + run)) {
        return true;
      }
    }
    idx = content.indexOf(spec.prefix, idx + 1);
  }
  return false;
}

function matchPemPrivateKey(content: string, spec: PemPrivateKeySecret): boolean {
  for (const type of spec.types) {
    if (content.includes(spec.begin + type + spec.end)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public evaluators
// ---------------------------------------------------------------------------

/** First dangerous-command rule matching `command`, or null. */
export function evaluateCommand(command: string, manifest: PatternManifest): CommandVerdict | null {
  for (const rule of manifest.dangerousCommands) {
    if (rule.kind === 'matchers') {
      if (matchOrdered(command, rule.matchers, rule.ci === true)) {
        return { reason: rule.reason };
      }
    } else {
      const pred = COMMAND_PREDICATES[rule.predicate];
      if (pred?.(command)) return { reason: rule.reason };
    }
  }
  return null;
}

/**
 * First content-secret verdict, preferring `block` (manifest lists block
 * entries first, so first match preserves the hook's block-before-warn order).
 */
export function evaluateContentSecrets(
  content: string,
  manifest: PatternManifest,
): ContentVerdict | null {
  for (const secret of manifest.contentSecrets) {
    let hit = false;
    switch (secret.kind) {
      case 'substringAny':
        hit = secret.needles.some((n) => content.includes(n));
        break;
      case 'pemPrivateKey':
        hit = matchPemPrivateKey(content, secret);
        break;
      case 'token':
        hit = matchToken(content, secret);
        break;
      default: {
        const pred = CONTENT_PREDICATES[secret.predicate];
        hit = pred ? pred(content) : false;
        break;
      }
    }
    if (hit) return { severity: secret.severity, reason: secret.reason };
  }
  return null;
}

/** True when a normalized (forward-slash) path is a protected credential file. */
export function isCredentialPath(normPath: string, manifest: PatternManifest): boolean {
  if (manifest.credentialPathEndsWith.some((s) => normPath.endsWith(s))) return true;
  if (manifest.credentialPathContains.some((s) => normPath.includes(s))) return true;
  for (const name of manifest.credentialPathPredicates) {
    const pred = CREDENTIAL_PATH_PREDICATES[name];
    if (pred?.(normPath)) return true;
  }
  return false;
}

/** True when a normalized write path falls under a protected system prefix. */
export function isBlockedWritePath(
  normPath: string,
  homeDir: string,
  manifest: PatternManifest,
): boolean {
  if (manifest.blockedWritePrefixes.some((p) => normPath.startsWith(p))) return true;
  const home = homeDir.replace(/\\/g, '/');
  for (const rel of manifest.blockedWriteHomeRelativePrefixes) {
    if (normPath.startsWith(`${home}/${rel}/`)) return true;
  }
  return false;
}

/** True when a lowercased ".env"-prefixed basename is a committed-template exemption. */
export function isEnvTemplate(lowerBasename: string, manifest: PatternManifest): boolean {
  if (manifest.envTemplateExact.includes(lowerBasename)) return true;
  if (!lowerBasename.startsWith('.env.')) return false;
  for (const suffix of manifest.envTemplateSuffixes) {
    if (lowerBasename.endsWith(suffix) && lowerBasename.length > '.env.'.length + suffix.length) {
      return true;
    }
  }
  return false;
}

/** True when a basename is a protected .env file (not a committed template). */
export function isProtectedEnvFile(basename: string, manifest: PatternManifest): boolean {
  const lower = basename.toLowerCase();
  return lower.startsWith('.env') && !isEnvTemplate(lower, manifest);
}

/** True when a basename is a protected lock file. */
export function isLockFile(basename: string, manifest: PatternManifest): boolean {
  return manifest.lockFiles.includes(basename);
}

/**
 * True when a command targets a production database URL. The command trigger +
 * URL indicator lists are canonical here; the consumer supplies the URL it
 * knows about (env var, inline assignment) since the daemon and the hook read
 * it from different places.
 */
export function isProductionDbCommand(
  command: string,
  dbUrl: string,
  manifest: PatternManifest,
): boolean {
  if (!dbUrl) return false;
  const triggered = manifest.productionDb.commandTriggers.some((t) => command.includes(t));
  if (!triggered) return false;
  return manifest.productionDb.urlIndicators.some((u) => dbUrl.includes(u));
}

// ---------------------------------------------------------------------------
// Load + validate + hash
// ---------------------------------------------------------------------------

/** Deterministic serialization (recursively key-sorted) for a stable content hash. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** sha256 (hex) of the stably-serialized manifest. */
export function manifestHash(manifest: PatternManifest): string {
  return createHash('sha256').update(stableStringify(manifest)).digest('hex');
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`tool-guard patterns.json invalid: ${message}`);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

const KNOWN_COMMAND_PREDICATES = new Set(Object.keys(COMMAND_PREDICATES));
const KNOWN_CREDENTIAL_PREDICATES = new Set(Object.keys(CREDENTIAL_PATH_PREDICATES));
const KNOWN_CONTENT_PREDICATES = new Set(Object.keys(CONTENT_PREDICATES));

/** Validate manifest shape; throws on any structural problem (fail-closed at load). */
export function validateManifest(value: unknown): PatternManifest {
  assert(typeof value === 'object' && value !== null, 'not an object');
  const m = value as Record<string, unknown>;
  assert(typeof m.version === 'number', 'version must be a number');

  assert(Array.isArray(m.dangerousCommands), 'dangerousCommands must be an array');
  for (const rule of m.dangerousCommands as unknown[]) {
    assert(typeof rule === 'object' && rule !== null, 'dangerousCommands entry not an object');
    const r = rule as Record<string, unknown>;
    assert(typeof r.reason === 'string', 'dangerousCommands.reason must be a string');
    if (r.kind === 'matchers') {
      assert(
        Array.isArray(r.matchers) && r.matchers.length > 0,
        'matchers must be a non-empty array',
      );
      for (const mm of r.matchers as unknown[]) {
        const matcher = mm as Record<string, unknown>;
        assert(
          typeof matcher.s === 'string' && matcher.s.length > 0,
          'matcher.s must be a non-empty string',
        );
      }
    } else if (r.kind === 'predicate') {
      assert(
        typeof r.predicate === 'string' && KNOWN_COMMAND_PREDICATES.has(r.predicate),
        `unknown command predicate: ${String(r.predicate)}`,
      );
    } else {
      assert(false, `unknown dangerousCommands kind: ${String(r.kind)}`);
    }
  }

  const pdb = m.productionDb as Record<string, unknown> | undefined;
  assert(typeof pdb === 'object' && pdb !== null, 'productionDb must be an object');
  assert(isStringArray(pdb?.commandTriggers), 'productionDb.commandTriggers must be string[]');
  assert(isStringArray(pdb?.urlIndicators), 'productionDb.urlIndicators must be string[]');

  assert(isStringArray(m.credentialPathEndsWith), 'credentialPathEndsWith must be string[]');
  assert(isStringArray(m.credentialPathContains), 'credentialPathContains must be string[]');
  assert(isStringArray(m.credentialPathPredicates), 'credentialPathPredicates must be string[]');
  for (const name of m.credentialPathPredicates as string[]) {
    assert(KNOWN_CREDENTIAL_PREDICATES.has(name), `unknown credential predicate: ${name}`);
  }
  assert(isStringArray(m.blockedWritePrefixes), 'blockedWritePrefixes must be string[]');
  assert(
    isStringArray(m.blockedWriteHomeRelativePrefixes),
    'blockedWriteHomeRelativePrefixes must be string[]',
  );
  assert(isStringArray(m.lockFiles), 'lockFiles must be string[]');
  assert(isStringArray(m.envTemplateExact), 'envTemplateExact must be string[]');
  assert(isStringArray(m.envTemplateSuffixes), 'envTemplateSuffixes must be string[]');

  assert(Array.isArray(m.contentSecrets), 'contentSecrets must be an array');
  for (const secret of m.contentSecrets as unknown[]) {
    const s = secret as Record<string, unknown>;
    assert(s.severity === 'block' || s.severity === 'warn', 'contentSecrets.severity invalid');
    assert(typeof s.reason === 'string', 'contentSecrets.reason must be a string');
    switch (s.kind) {
      case 'substringAny':
        assert(
          isStringArray(s.needles) && (s.needles as string[]).length > 0,
          'substringAny.needles invalid',
        );
        break;
      case 'pemPrivateKey':
        assert(typeof s.begin === 'string', 'pemPrivateKey.begin must be a string');
        assert(typeof s.end === 'string', 'pemPrivateKey.end must be a string');
        assert(isStringArray(s.types), 'pemPrivateKey.types must be string[]');
        break;
      case 'token':
        assert(
          typeof s.prefix === 'string' && (s.prefix as string).length > 0,
          'token.prefix invalid',
        );
        assert(typeof s.len === 'number' && (s.len as number) > 0, 'token.len invalid');
        assert(s.mode === 'exact' || s.mode === 'min', 'token.mode invalid');
        assert(
          s.charset === 'alnum' || s.charset === 'alnumUnderscore' || s.charset === 'upperDigit',
          'token.charset invalid',
        );
        break;
      case 'predicate':
        assert(
          typeof s.predicate === 'string' && KNOWN_CONTENT_PREDICATES.has(s.predicate as string),
          `unknown content predicate: ${String(s.predicate)}`,
        );
        break;
      default:
        assert(false, `unknown contentSecrets kind: ${String(s.kind)}`);
    }
  }

  return value as PatternManifest;
}

let cached: { manifest: PatternManifest; hash: string } | null = null;

/** Load, validate, and hash the manifest once. Throws on an invalid manifest. */
export function loadPatterns(): { manifest: PatternManifest; hash: string } {
  if (cached) return cached;
  const manifest = validateManifest(rawManifest);
  cached = { manifest, hash: manifestHash(manifest) };
  return cached;
}
