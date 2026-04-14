import type { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useRef } from 'react';
import { useLocalShell } from '../../hooks/use-local-shell';
import Button from '../ui/Button';
import ErrorAlert from '../ui/ErrorAlert';
import StatusDot from '../ui/StatusDot';
import TerminalView from './TerminalView';

/**
 * Local PTY terminal. Auto-opens a shell on mount using the platform default
 * (`wsl.exe` on Windows, `$SHELL` elsewhere) — no connect form, no SSH.
 * This is the tab RevDev opens by default so it can replace the system
 * terminal as the daily driver.
 */
export default function LocalTerminalPanel() {
  const terminalRef = useRef<Terminal | null>(null);
  const pendingSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const hasOpenedRef = useRef(false);

  const handleData = useCallback((data: Uint8Array) => {
    terminalRef.current?.write(data);
  }, []);

  const handleExit = useCallback((reason: string) => {
    terminalRef.current?.writeln(`\r\n\x1b[33m--- ${reason} ---\x1b[0m`);
  }, []);

  const { isOpen, opening, error, open, close, send, resize } = useLocalShell({
    onData: handleData,
    onExit: handleExit,
  });

  const ensureOpen = useCallback(
    (cols: number, rows: number) => {
      if (hasOpenedRef.current) return;
      hasOpenedRef.current = true;
      void open({ cols, rows });
    },
    [open],
  );

  const handleTerminalData = useCallback(
    (data: string) => {
      void send(data);
    },
    [send],
  );

  const handleTerminalResize = useCallback(
    (cols: number, rows: number) => {
      if (!hasOpenedRef.current) {
        pendingSizeRef.current = { cols, rows };
        ensureOpen(cols, rows);
        return;
      }
      void resize(cols, rows);
    },
    [ensureOpen, resize],
  );

  useEffect(() => {
    const pending = pendingSizeRef.current;
    if (isOpen && pending) {
      void resize(pending.cols, pending.rows);
      pendingSizeRef.current = null;
    }
  }, [isOpen, resize]);

  const handleRestart = useCallback(async () => {
    await close();
    hasOpenedRef.current = false;
    const term = terminalRef.current;
    if (term) {
      term.writeln('\r\n\x1b[90m--- restarting shell ---\x1b[0m');
      void open({ cols: term.cols, rows: term.rows });
      hasOpenedRef.current = true;
    }
  }, [close, open]);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <StatusDot status={isOpen ? 'ok' : opening ? 'warn' : 'off'} size="md" />
          <span className="text-xs text-neutral-400">
            {isOpen ? 'Local shell' : opening ? 'Starting…' : 'Not running'}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={handleRestart} disabled={opening}>
          Restart
        </Button>
      </div>

      <ErrorAlert message={error} />

      <div className="min-h-0 flex-1">
        <TerminalView
          onData={handleTerminalData}
          onResize={handleTerminalResize}
          terminalRef={terminalRef}
        />
      </div>
    </div>
  );
}
