import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';
import { shellClose, shellOpen, shellResize, shellSend } from '../lib/invoke';

interface ShellOutputEventPayload {
  session_id: string;
  data: string;
}

interface ShellExitEventPayload {
  session_id: string;
  reason: string;
}

interface LocalShellState {
  sessionId: string | null;
  isOpen: boolean;
  opening: boolean;
  error: string | null;
}

interface UseLocalShellOptions {
  onData?: (data: Uint8Array) => void;
  onExit?: (reason: string) => void;
}

export interface LocalShellOpenParams {
  cols: number;
  rows: number;
  cwd?: string;
}

export function useLocalShell(options: UseLocalShellOptions = {}) {
  const [state, setState] = useState<LocalShellState>({
    sessionId: null,
    isOpen: false,
    opening: false,
    error: null,
  });

  const onDataRef = useRef(options.onData);
  const onExitRef = useRef(options.onExit);
  const unlistenOutputRef = useRef<(() => void) | null>(null);
  const unlistenExitRef = useRef<(() => void) | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  onDataRef.current = options.onData;
  onExitRef.current = options.onExit;

  const clearListeners = useCallback(() => {
    unlistenOutputRef.current?.();
    unlistenExitRef.current?.();
    unlistenOutputRef.current = null;
    unlistenExitRef.current = null;
  }, []);

  const openShell = useCallback(
    async (params: LocalShellOpenParams) => {
      setState((prev) => ({ ...prev, opening: true, error: null }));
      try {
        const id = await shellOpen(params.cols, params.rows, params.cwd);
        sessionIdRef.current = id;

        const unlistenOut = await listen<ShellOutputEventPayload>('shell_output', (event) => {
          if (event.payload.session_id !== sessionIdRef.current) return;
          const bytes = Uint8Array.from(atob(event.payload.data), (c) => c.charCodeAt(0));
          onDataRef.current?.(bytes);
        });
        unlistenOutputRef.current = unlistenOut;

        const unlistenExit = await listen<ShellExitEventPayload>('shell_exit', (event) => {
          if (event.payload.session_id !== sessionIdRef.current) return;
          sessionIdRef.current = null;
          clearListeners();
          setState({ sessionId: null, isOpen: false, opening: false, error: null });
          onExitRef.current?.(event.payload.reason);
        });
        unlistenExitRef.current = unlistenExit;

        setState({ sessionId: id, isOpen: true, opening: false, error: null });
      } catch (err) {
        setState({
          sessionId: null,
          isOpen: false,
          opening: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [clearListeners],
  );

  const close = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    try {
      await shellClose(id);
    } catch {
      // Session may already be gone — best-effort
    }
    sessionIdRef.current = null;
    clearListeners();
    setState({ sessionId: null, isOpen: false, opening: false, error: null });
  }, [clearListeners]);

  const send = useCallback(
    async (data: string) => {
      const id = sessionIdRef.current;
      if (!id) return;
      try {
        await shellSend(id, btoa(data));
      } catch (err) {
        sessionIdRef.current = null;
        clearListeners();
        setState({
          sessionId: null,
          isOpen: false,
          opening: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [clearListeners],
  );

  const resize = useCallback(
    async (cols: number, rows: number) => {
      const id = sessionIdRef.current;
      if (!id) return;
      try {
        await shellResize(id, cols, rows);
      } catch (err) {
        sessionIdRef.current = null;
        clearListeners();
        setState({
          sessionId: null,
          isOpen: false,
          opening: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [clearListeners],
  );

  useEffect(() => {
    return () => {
      const id = sessionIdRef.current;
      if (id) {
        shellClose(id).catch(() => {
          // Best-effort cleanup on unmount
        });
      }
      clearListeners();
    };
  }, [clearListeners]);

  return { ...state, open: openShell, close, send, resize };
}
