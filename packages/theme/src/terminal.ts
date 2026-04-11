/**
 * Terminal theme configuration for xterm.js (Studio) and lipgloss (Terminal).
 */

import { COLORS } from './colors.js';

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;

  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** Default terminal theme — dark mode, Catppuccin Mocha inspired. */
export const TERMINAL_THEME: TerminalTheme = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: COLORS.primary,
  cursorAccent: '#1e1e2e',
  selectionBackground: '#45475a',
  selectionForeground: '#cdd6f4',

  ...COLORS.ansi,
};
