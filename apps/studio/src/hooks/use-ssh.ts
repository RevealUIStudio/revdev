import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';
import { sshConnect, sshDisconnect, sshResize, sshSend } from '../lib/invoke';
import type {
  SshConnectParams,
  SshDisconnectEvent,
  SshHostKeyEvent,
  SshOutputEvent,
} from '../types';

interface SshHookState {
  sessionId: string | null;
  connected: boolean;
  connecting: boolean;
  error: string | null;
}

interface UseSshOptions {
  onData?: (data: Uint8Array) => void;
  onDisconnect?: (reason: string) => void;
  onHostKey?: (event: SshHostKeyEvent) => void;
}

export function useSsh(options: UseSshOptions = {}) {
  const [state, setState] = useState<SshHookState>({
    sessionId: null,
    connected: false,
    connecting: false,
    error: null,
  });

  const onDataRef = useRef(options.onData);
  const onDisconnectRef = useRef(options.onDisconnect);
  const onHostKeyRef = useRef(options.onHostKey);
  const unlistenOutputRef = useRef<(() => void) | null>(null);
  const unlistenDisconnectRef = useRef<(() => void) | null>(null);
  const unlistenHostKeyRef = useRef<(() => void) | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  // Keep refs in sync
  onDataRef.current = options.onData;
  onDisconnectRef.current = options.onDisconnect;
  onHostKeyRef.current = options.onHostKey;

  const handleSessionLost = useCallback((reason: string) => {
    sessionIdRef.current = null;
    unlistenOutputRef.current?.();
    unlistenDisconnectRef.current?.();
    unlistenHostKeyRef.current?.();
    unlistenOutputRef.current = null;
    unlistenDisconnectRef.current = null;
    unlistenHostKeyRef.current = null;
    setState({
      sessionId: null,
      connected: false,
      connecting: false,
      error: reason,
    });
    onDisconnectRef.current?.(reason);
  }, []);

  const connect = useCallback(
    async (params: SshConnectParams) => {
      setState((prev) => ({ ...prev, connecting: true, error: null }));
      try {
        // Listen for host key verification events (fires during handshake)
        const unlistenHk = await listen<SshHostKeyEvent>('ssh_host_key', (event) => {
          onHostKeyRef.current?.(event.payload);
        });
        unlistenHostKeyRef.current = unlistenHk;

        const id = await sshConnect(params);
        sessionIdRef.current = id;

        // Listen for output events
        const unlistenOut = await listen<SshOutputEvent>('ssh_output', (event) => {
          if (event.payload.session_id !== sessionIdRef.current) return;
          const bytes = Uint8Array.from(atob(event.payload.data), (c) => c.charCodeAt(0));
          onDataRef.current?.(bytes);
        });
        unlistenOutputRef.current = unlistenOut;

        // Listen for disconnect events
        const unlistenDc = await listen<SshDisconnectEvent>('ssh_disconnect', (event) => {
          if (event.payload.session_id !== sessionIdRef.current) return;
          handleSessionLost(event.payload.reason);
        });
        unlistenDisconnectRef.current = unlistenDc;

        setState({
          sessionId: id,
          connected: true,
          connecting: false,
          error: null,
        });
      } catch (err) {
        setState({
          sessionId: null,
          connected: false,
          connecting: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [handleSessionLost],
  );

  const disconnect = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    try {
      await sshDisconnect(id);
    } catch {
      // Session may already be closed server-side
    }
    sessionIdRef.current = null;
    unlistenOutputRef.current?.();
    unlistenDisconnectRef.current?.();
    unlistenHostKeyRef.current?.();
    unlistenOutputRef.current = null;
    unlistenDisconnectRef.current = null;
    unlistenHostKeyRef.current = null;
    setState({
      sessionId: null,
      connected: false,
      connecting: false,
      error: null,
    });
  }, []);

  const send = useCallback(
    async (data: string) => {
      const id = sessionIdRef.current;
      if (!id) return;
      const encoded = btoa(data);
      try {
        await sshSend(id, encoded);
      } catch (err) {
        handleSessionLost(err instanceof Error ? err.message : String(err));
      }
    },
    [handleSessionLost],
  );

  const resize = useCallback(
    async (cols: number, rows: number) => {
      const id = sessionIdRef.current;
      if (!id) return;
      try {
        await sshResize(id, cols, rows);
      } catch (err) {
        handleSessionLost(err instanceof Error ? err.message : String(err));
      }
    },
    [handleSessionLost],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const id = sessionIdRef.current;
      if (id) {
        sshDisconnect(id).catch(() => {
          // Best-effort cleanup on unmount — nothing to handle
        });
      }
      unlistenOutputRef.current?.();
      unlistenDisconnectRef.current?.();
      unlistenHostKeyRef.current?.();
    };
  }, []);

  return { ...state, connect, disconnect, send, resize };
}
