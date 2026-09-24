/**
 * SELECT-only SQL guard for the native inspector.
 *
 * Allows one SELECT or WITH ... SELECT. Rejects writes, DDL, SELECT INTO,
 * extra statements, and comments that hide a write. Line comments are always
 * rejected: they hide the rest of the line and can comment out the wrapper's
 * row limit. No database connection.
 */

export type GuardDecision = { ok: true; statement: string } | { ok: false; reason: string };

const BANNED_WORDS: ReadonlySet<string> = new Set([
  'abort',
  'alter',
  'analyse',
  'analyze',
  'attach',
  'begin',
  'call',
  'checkpoint',
  'cluster',
  'comment',
  'commit',
  'copy',
  'create',
  'deallocate',
  'declare',
  'delete',
  'detach',
  'discard',
  'do',
  'drop',
  'execute',
  'explain',
  'fetch',
  'grant',
  'import',
  'insert',
  'into',
  'listen',
  'load',
  'lock',
  'merge',
  'move',
  'notify',
  'prepare',
  'reassign',
  'refresh',
  'reindex',
  'reset',
  'revoke',
  'rollback',
  'savepoint',
  'security',
  'set',
  'set_config',
  'show',
  'transaction',
  'truncate',
  'unlisten',
  'update',
  'vacuum',
]);

const DDL_WORDS: ReadonlySet<string> = new Set([
  'alter',
  'analyse',
  'analyze',
  'cluster',
  'comment',
  'create',
  'drop',
  'grant',
  'refresh',
  'reindex',
  'revoke',
  'truncate',
  'vacuum',
]);

type Token =
  | { k: 'ws'; raw: string }
  | { k: 'comment'; style: 'line' | 'block'; body: string; raw: string }
  | { k: 'word'; value: string; raw: string }
  | { k: 'ident'; raw: string }
  | { k: 'string'; raw: string }
  | { k: 'number'; raw: string }
  | { k: 'param'; raw: string }
  | { k: 'semi' }
  | { k: 'lparen' }
  | { k: 'rparen' }
  | { k: 'lbracket' }
  | { k: 'rbracket' }
  | { k: 'comma' }
  | { k: 'op'; raw: string };

type Significant = Exclude<Token, { k: 'ws' } | { k: 'comment' }>;

function isWs(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

function isDigit(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function isIdentStart(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || ch === '_';
}

function isIdentCont(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch) || ch === '_';
}

function isWordChar(ch: string): boolean {
  return isIdentCont(ch);
}

function reasonForBanned(word: string): string {
  if (word === 'into') return 'SELECT INTO is not allowed';
  if (word === 'insert' || word === 'update' || word === 'delete' || word === 'merge') {
    return `${word.toUpperCase()} is not allowed`;
  }
  if (DDL_WORDS.has(word)) return `DDL is not allowed (${word.toUpperCase()})`;
  return `${word.toUpperCase()} is not allowed`;
}

function commentHidesWrite(body: string): boolean {
  if (body.includes(';')) return true;
  let word = '';
  const flush = (): boolean => {
    const banned = word.length > 0 && BANNED_WORDS.has(word.toLowerCase());
    word = '';
    return banned;
  };
  for (const ch of body) {
    if (isWordChar(ch)) word += ch;
    else if (flush()) return true;
  }
  return flush();
}

function scanQuoted(
  sql: string,
  quoteAt: number,
  backslashEscapes: boolean,
): { end: number } | { error: string } {
  let i = quoteAt + 1;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === undefined) break;
    if (backslashEscapes && ch === '\\') {
      if (i + 1 >= sql.length) return { error: 'unterminated string' };
      i += 2;
      continue;
    }
    if (ch === "'") {
      if (sql[i + 1] === "'") {
        i += 2;
        continue;
      }
      return { end: i + 1 };
    }
    i += 1;
  }
  return { error: 'unterminated string' };
}

function stringPrefix(sql: string, i: number): { prefixLen: number; escape: boolean } | null {
  const c0 = sql[i];
  const c1 = sql[i + 1];
  if (c0 === undefined) return null;
  if (
    (c0 === 'E' ||
      c0 === 'e' ||
      c0 === 'N' ||
      c0 === 'n' ||
      c0 === 'B' ||
      c0 === 'b' ||
      c0 === 'X' ||
      c0 === 'x') &&
    c1 === "'"
  ) {
    return { prefixLen: 1, escape: c0 === 'E' || c0 === 'e' };
  }
  if ((c0 === 'U' || c0 === 'u') && c1 === '&' && sql[i + 2] === "'") {
    return { prefixLen: 2, escape: true };
  }
  return null;
}

function scanIdent(sql: string, i: number): { end: number } | { error: string } {
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] === '"') {
      if (sql[j + 1] === '"') {
        j += 2;
        continue;
      }
      return { end: j + 1 };
    }
    j += 1;
  }
  return { error: 'unterminated identifier' };
}

function scanDollar(sql: string, i: number): { token: Token; next: number } | { error: string } {
  let j = i + 1;
  const next = sql[j];
  if (next === '$') {
    const end = sql.indexOf('$$', j + 1);
    if (end < 0) return { error: 'unterminated dollar quote' };
    return { token: { k: 'string', raw: sql.slice(i, end + 2) }, next: end + 2 };
  }
  if (next !== undefined && isDigit(next)) {
    while (j < sql.length && sql[j] !== undefined && isDigit(sql[j] as string)) j += 1;
    return { token: { k: 'param', raw: sql.slice(i, j) }, next: j };
  }
  if (next !== undefined && isIdentStart(next)) {
    const tagStart = j;
    while (j < sql.length && sql[j] !== undefined && isIdentCont(sql[j] as string)) j += 1;
    if (sql[j] === '$') {
      const tag = sql.slice(tagStart, j);
      const close = `$${tag}$`;
      const end = sql.indexOf(close, j + 1);
      if (end < 0) return { error: 'unterminated dollar quote' };
      return {
        token: { k: 'string', raw: sql.slice(i, end + close.length) },
        next: end + close.length,
      };
    }
  }
  return { error: 'unsupported $ token' };
}

function scanBlock(sql: string, i: number): { token: Token; next: number } | { error: string } {
  const start = i;
  i += 2;
  const bodyStart = i;
  let depth = 1;
  while (i < sql.length && depth > 0) {
    if (sql[i] === '/' && sql[i + 1] === '*') {
      depth += 1;
      i += 2;
      continue;
    }
    if (sql[i] === '*' && sql[i + 1] === '/') {
      depth -= 1;
      i += 2;
      continue;
    }
    i += 1;
  }
  if (depth !== 0) return { error: 'unterminated block comment' };
  return {
    token: {
      k: 'comment',
      style: 'block',
      body: sql.slice(bodyStart, i - 2),
      raw: sql.slice(start, i),
    },
    next: i,
  };
}

function scanNumber(sql: string, i: number): { token: Token; next: number } {
  let j = i;
  if (sql[j] === '.') j += 1;
  while (j < sql.length && sql[j] !== undefined && isDigit(sql[j] as string)) j += 1;
  if (sql[j] === '.' && sql[i] !== '.') {
    j += 1;
    while (j < sql.length && sql[j] !== undefined && isDigit(sql[j] as string)) j += 1;
  }
  const exp = sql[j];
  if (exp === 'e' || exp === 'E') {
    let k = j + 1;
    if (sql[k] === '+' || sql[k] === '-') k += 1;
    const expDigit = sql[k];
    if (expDigit !== undefined && isDigit(expDigit)) {
      j = k + 1;
      while (j < sql.length && sql[j] !== undefined && isDigit(sql[j] as string)) j += 1;
    }
  }
  return { token: { k: 'number', raw: sql.slice(i, j) }, next: j };
}

function scan(sql: string): { ok: true; tokens: Token[] } | { ok: false; reason: string } {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === undefined) break;
    if (isWs(ch)) {
      const start = i;
      while (i < sql.length && sql[i] !== undefined && isWs(sql[i] as string)) i += 1;
      tokens.push({ k: 'ws', raw: sql.slice(start, i) });
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const start = i;
      i += 2;
      const bodyStart = i;
      while (i < sql.length && sql[i] !== '\n') i += 1;
      tokens.push({
        k: 'comment',
        style: 'line',
        body: sql.slice(bodyStart, i),
        raw: sql.slice(start, i),
      });
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const block = scanBlock(sql, i);
      if ('error' in block) return { ok: false, reason: block.error };
      tokens.push(block.token);
      i = block.next;
      continue;
    }
    if (ch === '"') {
      const ident = scanIdent(sql, i);
      if ('error' in ident) return { ok: false, reason: ident.error };
      tokens.push({ k: 'ident', raw: sql.slice(i, ident.end) });
      i = ident.end;
      continue;
    }
    if (ch === "'") {
      const quoted = scanQuoted(sql, i, false);
      if ('error' in quoted) return { ok: false, reason: quoted.error };
      tokens.push({ k: 'string', raw: sql.slice(i, quoted.end) });
      i = quoted.end;
      continue;
    }
    const prefix = stringPrefix(sql, i);
    if (prefix) {
      const quoteAt = i + prefix.prefixLen;
      const quoted = scanQuoted(sql, quoteAt, prefix.escape);
      if ('error' in quoted) return { ok: false, reason: quoted.error };
      tokens.push({ k: 'string', raw: sql.slice(i, quoted.end) });
      i = quoted.end;
      continue;
    }
    if (ch === '$') {
      const dollar = scanDollar(sql, i);
      if ('error' in dollar) return { ok: false, reason: dollar.error };
      tokens.push(dollar.token);
      i = dollar.next;
      continue;
    }
    if (isDigit(ch) || (ch === '.' && sql[i + 1] !== undefined && isDigit(sql[i + 1] as string))) {
      const num = scanNumber(sql, i);
      tokens.push(num.token);
      i = num.next;
      continue;
    }
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < sql.length && sql[j] !== undefined && isIdentCont(sql[j] as string)) j += 1;
      const raw = sql.slice(i, j);
      tokens.push({ k: 'word', value: raw.toLowerCase(), raw });
      i = j;
      continue;
    }
    if (ch.charCodeAt(0) > 127) {
      return { ok: false, reason: 'non-ascii input is not allowed outside strings' };
    }
    if (ch === '(') {
      tokens.push({ k: 'lparen' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ k: 'rparen' });
      i += 1;
      continue;
    }
    if (ch === '[') {
      tokens.push({ k: 'lbracket' });
      i += 1;
      continue;
    }
    if (ch === ']') {
      tokens.push({ k: 'rbracket' });
      i += 1;
      continue;
    }
    if (ch === ',') {
      tokens.push({ k: 'comma' });
      i += 1;
      continue;
    }
    if (ch === ';') {
      tokens.push({ k: 'semi' });
      i += 1;
      continue;
    }
    tokens.push({ k: 'op', raw: ch });
    i += 1;
  }
  return { ok: true, tokens };
}

function skipBalanced(tokens: Significant[], openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) return -1;
    if (token.k === 'lparen') depth += 1;
    else if (token.k === 'rparen') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function assertWithSelect(tokens: Significant[]): GuardDecision | { ok: true } {
  let i = 1;
  const recursive = tokens[i];
  if (recursive?.k === 'word' && recursive.value === 'recursive') i += 1;
  let cteCount = 0;
  while (i < tokens.length) {
    const name = tokens[i];
    if (name === undefined || (name.k !== 'word' && name.k !== 'ident')) {
      return { ok: false, reason: 'WITH query must end in a SELECT' };
    }
    i += 1;
    if (tokens[i]?.k === 'lparen') {
      const afterCols = skipBalanced(tokens, i);
      if (afterCols < 0) return { ok: false, reason: 'unbalanced parentheses' };
      i = afterCols;
    }
    const asTok = tokens[i];
    if (asTok?.k !== 'word' || asTok.value !== 'as') {
      return { ok: false, reason: 'WITH query must end in a SELECT' };
    }
    i += 1;
    const materialized = tokens[i];
    if (materialized?.k === 'word' && materialized.value === 'not') {
      const next = tokens[i + 1];
      if (next?.k !== 'word' || next.value !== 'materialized') {
        return { ok: false, reason: 'WITH query must end in a SELECT' };
      }
      i += 2;
    } else if (materialized?.k === 'word' && materialized.value === 'materialized') {
      i += 1;
    }
    if (tokens[i]?.k !== 'lparen') return { ok: false, reason: 'WITH query must end in a SELECT' };
    const afterBody = skipBalanced(tokens, i);
    if (afterBody < 0) return { ok: false, reason: 'unbalanced parentheses' };
    i = afterBody;
    cteCount += 1;
    if (tokens[i]?.k === 'comma') {
      i += 1;
      continue;
    }
    break;
  }
  if (cteCount < 1) return { ok: false, reason: 'WITH query must end in a SELECT' };
  const main = tokens[i];
  if (main?.k !== 'word' || main.value !== 'select') {
    return { ok: false, reason: 'WITH query must end in a SELECT' };
  }
  return { ok: true };
}

function renderStatement(tokens: Token[]): string {
  let lastSignificant = -1;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token !== undefined && token.k !== 'ws' && token.k !== 'comment') lastSignificant = i;
  }
  const dropSemi =
    lastSignificant >= 0 && tokens[lastSignificant]?.k === 'semi' ? lastSignificant : -1;
  let out = '';
  for (let i = 0; i < tokens.length; i += 1) {
    if (i === dropSemi) continue;
    const token = tokens[i];
    if (token === undefined) continue;
    if (token.k === 'comment') out += ' ';
    else if (token.k === 'semi' || token.k === 'lparen' || token.k === 'rparen') {
      out += token.k === 'semi' ? ';' : token.k === 'lparen' ? '(' : ')';
    } else if (token.k === 'lbracket') out += '[';
    else if (token.k === 'rbracket') out += ']';
    else if (token.k === 'comma') out += ',';
    else out += token.raw;
  }
  return out.trim();
}

export function guardSelectOnly(sql: string): GuardDecision {
  const scanned = scan(sql);
  if (!scanned.ok) return scanned;
  const tokens = scanned.tokens;

  for (const token of tokens) {
    if (token.k !== 'comment') continue;
    if (token.style === 'line' || commentHidesWrite(token.body)) {
      return { ok: false, reason: 'comment hides a write' };
    }
  }

  const significant: Significant[] = [];
  for (const token of tokens) {
    if (token.k === 'ws' || token.k === 'comment') continue;
    significant.push(token);
  }

  let end = significant.length;
  if (end > 0 && significant[end - 1]?.k === 'semi') end -= 1;
  const body = significant.slice(0, end);
  for (const token of body) {
    if (token.k === 'semi') return { ok: false, reason: 'multiple statements are not allowed' };
  }
  if (body.length === 0) return { ok: false, reason: 'empty query' };

  let paren = 0;
  let bracket = 0;
  for (const token of body) {
    if (token.k === 'param') {
      return { ok: false, reason: 'bound parameters are not allowed' };
    }
    if (token.k === 'word' && BANNED_WORDS.has(token.value)) {
      return { ok: false, reason: reasonForBanned(token.value) };
    }
    if (token.k === 'lparen') paren += 1;
    else if (token.k === 'rparen') {
      paren -= 1;
      if (paren < 0) return { ok: false, reason: 'unbalanced parentheses' };
    } else if (token.k === 'lbracket') bracket += 1;
    else if (token.k === 'rbracket') {
      bracket -= 1;
      if (bracket < 0) return { ok: false, reason: 'unbalanced parentheses' };
    }
  }
  if (paren !== 0 || bracket !== 0) return { ok: false, reason: 'unbalanced parentheses' };

  const first = body[0];
  if (first === undefined || first.k !== 'word') {
    return { ok: false, reason: 'only a single SELECT or WITH ... SELECT is allowed' };
  }
  if (first.value === 'with') {
    const withShape = assertWithSelect(body);
    if (!withShape.ok) return withShape;
  } else if (first.value !== 'select') {
    return { ok: false, reason: 'only a single SELECT or WITH ... SELECT is allowed' };
  }

  const statement = renderStatement(tokens);
  if (statement.length === 0) return { ok: false, reason: 'empty query' };
  return { ok: true, statement };
}
