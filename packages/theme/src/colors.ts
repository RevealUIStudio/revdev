/**
 * RevDev color palette.
 *
 * Based on the RevealUI brand colors, optimized for terminal readability.
 * These tokens are consumed by both the xterm.js theme (Studio) and
 * the Bubble Tea lipgloss styles (Terminal).
 */

export interface ColorPalette {
  /** Primary brand color */
  primary: string;
  /** Secondary accent */
  secondary: string;
  /** Success/green state */
  success: string;
  /** Warning/yellow state */
  warning: string;
  /** Error/red state */
  error: string;
  /** Informational/blue state */
  info: string;
  /** Muted/dimmed text */
  muted: string;

  /** Terminal ANSI colors (0-15) */
  ansi: {
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
  };
}

export const COLORS: ColorPalette = {
  primary: '#6366f1', // Indigo-500
  secondary: '#8b5cf6', // Violet-500
  success: '#22c55e', // Green-500
  warning: '#f59e0b', // Amber-500
  error: '#ef4444', // Red-500
  info: '#3b82f6', // Blue-500
  muted: '#6b7280', // Gray-500

  ansi: {
    black: '#1e1e2e',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#cba6f7',
    cyan: '#94e2d5',
    white: '#cdd6f4',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#cba6f7',
    brightCyan: '#94e2d5',
    brightWhite: '#f5f5f5',
  },
};
