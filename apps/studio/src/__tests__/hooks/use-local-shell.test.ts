import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocalShell } from '../../hooks/use-local-shell';

const { mockUnlisten } = vi.hoisted(() => ({
  mockUnlisten: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(mockUnlisten),
}));

vi.mock('../../lib/invoke', () => ({
  shellOpen: vi.fn(),
  shellClose: vi.fn().mockResolvedValue(undefined),
  shellSend: vi.fn(),
  shellResize: vi.fn(),
}));

const { shellOpen, shellClose, shellSend, shellResize } = await import('../../lib/invoke');

describe('useLocalShell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUnlisten.mockClear();
    vi.mocked(shellClose).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes closed', () => {
    const { result } = renderHook(() => useLocalShell());

    expect(result.current.sessionId).toBeNull();
    expect(result.current.isOpen).toBe(false);
    expect(result.current.opening).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('opens the shell with platform defaults when shellProgram is omitted', async () => {
    vi.mocked(shellOpen).mockResolvedValueOnce('shell-session-1');

    const { result } = renderHook(() => useLocalShell());

    await act(async () => {
      await result.current.open({ cols: 80, rows: 24 });
    });

    expect(shellOpen).toHaveBeenCalledWith(80, 24, undefined, undefined);
    expect(result.current.sessionId).toBe('shell-session-1');
    expect(result.current.isOpen).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('passes through explicit shellProgram and cwd', async () => {
    vi.mocked(shellOpen).mockResolvedValueOnce('shell-session-2');

    const { result } = renderHook(() => useLocalShell());

    await act(async () => {
      await result.current.open({
        cols: 120,
        rows: 40,
        cwd: '/home/user/proj',
        shellProgram: 'wsl.exe',
      });
    });

    expect(shellOpen).toHaveBeenCalledWith(120, 40, '/home/user/proj', 'wsl.exe');
  });

  it('records the error message when shell_open rejects', async () => {
    vi.mocked(shellOpen).mockRejectedValueOnce(new Error('wsl.exe not found'));

    const { result } = renderHook(() => useLocalShell());

    await act(async () => {
      await result.current.open({ cols: 80, rows: 24 });
    });

    expect(result.current.isOpen).toBe(false);
    expect(result.current.opening).toBe(false);
    expect(result.current.error).toBe('wsl.exe not found');
    expect(result.current.sessionId).toBeNull();
  });

  it('base64-encodes input before sending', async () => {
    vi.mocked(shellOpen).mockResolvedValueOnce('shell-session-3');

    const { result } = renderHook(() => useLocalShell());
    await act(async () => {
      await result.current.open({ cols: 80, rows: 24 });
    });

    await act(async () => {
      await result.current.send('ls\n');
    });

    expect(shellSend).toHaveBeenCalledWith('shell-session-3', btoa('ls\n'));
  });

  it('forwards resize to shell_resize', async () => {
    vi.mocked(shellOpen).mockResolvedValueOnce('shell-session-4');

    const { result } = renderHook(() => useLocalShell());
    await act(async () => {
      await result.current.open({ cols: 80, rows: 24 });
    });

    await act(async () => {
      await result.current.resize(100, 30);
    });

    expect(shellResize).toHaveBeenCalledWith('shell-session-4', 100, 30);
  });

  it('close resets state and invokes shell_close', async () => {
    vi.mocked(shellOpen).mockResolvedValueOnce('shell-session-5');

    const { result } = renderHook(() => useLocalShell());
    await act(async () => {
      await result.current.open({ cols: 80, rows: 24 });
    });

    await act(async () => {
      await result.current.close();
    });

    expect(shellClose).toHaveBeenCalledWith('shell-session-5');
    expect(result.current.sessionId).toBeNull();
    expect(result.current.isOpen).toBe(false);
  });

  it('send is a no-op when no session is open', async () => {
    const { result } = renderHook(() => useLocalShell());

    await act(async () => {
      await result.current.send('anything');
    });

    expect(shellSend).not.toHaveBeenCalled();
  });
});
