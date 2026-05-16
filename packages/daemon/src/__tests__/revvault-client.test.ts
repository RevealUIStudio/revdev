/**
 * Unit tests for revvault-client.ts.
 *
 * Mocks node:child_process at the module level and controls per-test
 * behavior via mockImplementation. Each test resets the mock to avoid
 * bleed-through between cases.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

vi.mock('node:child_process', () => {
  const execFile = vi.fn();
  const EventEmitter = require('node:events').EventEmitter;

  return {
    execFile,
    __esModule: true,
    EventEmitter,
  };
});

import * as childProcess from 'node:child_process';
import { isRevvaultAvailable, revvaultGet, revvaultSet } from '../revvault-client.js';

function mockExecFileSuccess(stdout: string, stderr = ''): void {
  const execFileMock = childProcess.execFile as unknown as Mock;
  execFileMock.mockImplementation(
    (_bin: string, _args: string[], _opts: unknown, callback: unknown) => {
      if (typeof callback === 'function') {
        (callback as (err: null, result: { stdout: string; stderr: string }) => void)(null, {
          stdout,
          stderr,
        });
      }
      const child = {
        stdin: { end: vi.fn() },
        exitCode: 0,
        on: vi.fn(),
        once: vi.fn(),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
      };
      return child;
    },
  );
}

function mockExecFileEnoent(): void {
  const execFileMock = childProcess.execFile as unknown as Mock;
  const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  execFileMock.mockImplementation(
    (_bin: string, _args: string[], _opts: unknown, callback: unknown) => {
      if (typeof callback === 'function') {
        (callback as (err: Error) => void)(err);
      }
      const child = {
        stdin: { end: vi.fn() },
        exitCode: 1,
        on: vi.fn(),
        once: vi.fn(),
      };
      return child;
    },
  );
}

function mockExecFileNonZero(stderr: string, exitCode = 1): void {
  const execFileMock = childProcess.execFile as unknown as Mock;
  const err = Object.assign(new Error('Command failed'), {
    code: exitCode,
    stderr,
    stdout: '',
  });
  execFileMock.mockImplementation(
    (_bin: string, _args: string[], _opts: unknown, callback: unknown) => {
      if (typeof callback === 'function') {
        (callback as (err: Error) => void)(err);
      }
      const child = {
        stdin: { end: vi.fn() },
        exitCode,
        on: vi.fn(),
        once: vi.fn(),
      };
      return child;
    },
  );
}

let capturedArgs: string[] = [];

beforeEach(() => {
  capturedArgs = [];
  const execFileMock = childProcess.execFile as unknown as Mock;
  execFileMock.mockImplementation(
    (bin: string, args: string[], _opts: unknown, callback: unknown) => {
      capturedArgs = [bin, ...args];
      if (typeof callback === 'function') {
        (callback as (err: null, result: { stdout: string; stderr: string }) => void)(null, {
          stdout: '',
          stderr: '',
        });
      }
      const child = {
        stdin: { end: vi.fn() },
        exitCode: 0,
        on: vi.fn(),
        once: vi.fn(),
      };
      return child;
    },
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('revvaultGet', () => {
  it('returns ok:true with value on success', async () => {
    mockExecFileSuccess(JSON.stringify({ value: 'the-secret' }));
    const result = await revvaultGet('revdev/agents/abc/identity/ed25519-public');
    expect(result).toEqual({ ok: true, value: 'the-secret' });
  });

  it('returns ok:false reason:cli-not-installed on ENOENT', async () => {
    mockExecFileEnoent();
    const result = await revvaultGet('revdev/agents/abc/identity/ed25519-public');
    expect(result).toEqual({ ok: false, value: null, reason: 'cli-not-installed' });
  });

  it('returns ok:false reason:not-found when stderr contains "not found"', async () => {
    mockExecFileNonZero('secret not found');
    const result = await revvaultGet('revdev/agents/abc/identity/ed25519-public');
    expect(result).toEqual({ ok: false, value: null, reason: 'not-found' });
  });

  it('returns ok:false reason:missing when stdout is empty', async () => {
    mockExecFileSuccess('');
    const result = await revvaultGet('revdev/agents/abc/identity/ed25519-public');
    expect(result).toEqual({ ok: false, value: null, reason: 'missing' });
  });

  it('always passes --json flag', async () => {
    const execFileMock = childProcess.execFile as unknown as Mock;
    execFileMock.mockImplementation(
      (bin: string, args: string[], _opts: unknown, callback: unknown) => {
        capturedArgs = [bin, ...args];
        if (typeof callback === 'function') {
          (callback as (err: null, result: { stdout: string; stderr: string }) => void)(null, {
            stdout: JSON.stringify({ value: 'x' }),
            stderr: '',
          });
        }
        return { stdin: { end: vi.fn() }, exitCode: 0, on: vi.fn(), once: vi.fn() };
      },
    );
    await revvaultGet('some/path');
    expect(capturedArgs).toContain('--json');
  });
});

describe('revvaultSet', () => {
  it('returns ok:true on success', async () => {
    const execFileMock = childProcess.execFile as unknown as Mock;
    execFileMock.mockImplementation((bin: string, args: string[]) => {
      capturedArgs = [bin, ...args];
      const EventEmitter = require('node:events').EventEmitter;
      const child = new EventEmitter();
      child.stdin = { end: vi.fn() };
      child.exitCode = 0;
      Promise.resolve().then(() => child.emit('exit', 0));
      return child;
    });
    const result = await revvaultSet('revdev/agents/abc/identity/ed25519-public', 'pubkey-pem');
    expect(result).toEqual({ ok: true });
  });

  it('returns ok:false reason:cli-not-installed on ENOENT', async () => {
    const execFileMock = childProcess.execFile as unknown as Mock;
    execFileMock.mockImplementation(() => {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      throw err;
    });
    const result = await revvaultSet('some/path', 'value');
    expect(result).toEqual({ ok: false, reason: 'cli-not-installed' });
  });

  it('returns ok:false reason:cli-failure on non-zero exit', async () => {
    const execFileMock = childProcess.execFile as unknown as Mock;
    execFileMock.mockImplementation(() => {
      const EventEmitter = require('node:events').EventEmitter;
      const child = new EventEmitter();
      child.stdin = { end: vi.fn() };
      child.exitCode = 1;
      Promise.resolve().then(() => child.emit('exit', 1));
      return child;
    });
    const result = await revvaultSet('some/path', 'value');
    expect(result).toEqual({ ok: false, reason: 'cli-failure' });
  });

  it('always passes --json flag', async () => {
    const execFileMock = childProcess.execFile as unknown as Mock;
    execFileMock.mockImplementation((bin: string, args: string[]) => {
      capturedArgs = [bin, ...args];
      const EventEmitter = require('node:events').EventEmitter;
      const child = new EventEmitter();
      child.stdin = { end: vi.fn() };
      child.exitCode = 0;
      Promise.resolve().then(() => child.emit('exit', 0));
      return child;
    });
    await revvaultSet('some/path', 'value');
    expect(capturedArgs).toContain('--json');
  });
});

describe('isRevvaultAvailable', () => {
  it('returns true when execFile succeeds', async () => {
    mockExecFileSuccess('revvault 0.1.0');
    const result = await isRevvaultAvailable();
    expect(result).toBe(true);
  });

  it('returns false on ENOENT', async () => {
    mockExecFileEnoent();
    const result = await isRevvaultAvailable();
    expect(result).toBe(false);
  });

  it('returns false on any failure', async () => {
    mockExecFileNonZero('unexpected error');
    const result = await isRevvaultAvailable();
    expect(result).toBe(false);
  });
});
