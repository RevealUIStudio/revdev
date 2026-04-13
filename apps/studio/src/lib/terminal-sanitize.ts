/**
 * Restricts the ANSI / control bytes that may be written into an xterm.js
 * instance as *banner* text (welcome lines, status messages, anything not
 * coming from a real PTY). The live PTY byte stream is trusted to xterm's
 * own parser — this helper is for strings the app renders around it.
 *
 * Allow-list:
 *  - Printable characters
 *  - `\t`, `\n`, `\r`
 *  - SGR (Select Graphic Rendition) CSI escapes — `\x1b[…m` — for colours
 *    and text attributes only
 *
 * Stripped:
 *  - OSC sequences (`\x1b]…`) — set window title, hyperlinks
 *  - Non-SGR CSI sequences (`\x1b[…A|B|J|H|…`) — cursor moves, erase,
 *    scroll region, mouse reporting
 *  - DCS / PM / APC / SOS sequences
 *  - Every C0 control byte except TAB / LF / CR
 *  - DEL (0x7f)
 *
 * Why: untrusted ANSI is a known terminal-escape-injection surface. Running
 * every non-PTY string through this means the {@link TerminalView} `welcome`
 * prop (and any future non-literal sink) cannot hijack the cursor, clear
 * the screen, rewrite the window title, or smuggle hyperlinks.
 */

// Single-pass alternation so each escape is matched exactly once —
// avoids a multi-pass pipeline stripping ESC bytes out of escapes that
// an earlier pass decided to keep (e.g. SGR). Order inside the alternation
// matters: longest / most-specific first.
//
//   \x1b]…(\x07|\x1b\\)?   — OSC
//   \x1b[PX^_]…(\x1b\\)?   — DCS / SOS / PM / APC
//   \x1b\[[0-?]*[ -/]*[@-~] — CSI (ECMA-48: params, intermediates, final)
//   \x1b.                  — bare 2-byte escape (Fs, Fp, nF)
//   \x1b                   — lone trailing ESC
// biome-ignore lint/suspicious/noControlCharactersInRegex: control bytes are the thing we filter
const ANY_ESCAPE =
  /\x1b\](?:[^\x07\x1b]*)(?:\x07|\x1b\\)?|\x1b[PX^_](?:[^\x1b]*)(?:\x1b\\)?|\x1b\[[0-?]*[ -/]*[@-~]|\x1b.|\x1b/g;

// An SGR CSI is `\x1b[` + params/intermediates + final byte `m`.
// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR by definition contains ESC
const SGR_CSI = /^\x1b\[[0-?]*[ -/]*m$/;

// C0 + DEL minus tab / lf / cr. ESC (0x1b) is excluded here because the
// first pass (ANY_ESCAPE) has already decided whether to keep it (inside an
// SGR sequence) or drop it — stripping 0x1b here would shred preserved SGRs.
// biome-ignore lint/suspicious/noControlCharactersInRegex: C0 bytes are the thing we filter
const DISALLOWED_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;

export function sanitizeTerminalLine(input: string): string {
  const stripped = input.replace(ANY_ESCAPE, (match) => (SGR_CSI.test(match) ? match : ''));
  return stripped.replace(DISALLOWED_CONTROL, '');
}
