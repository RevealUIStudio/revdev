import { describe, expect, it } from 'vitest';
import { DAEMON_DEFAULTS } from '../config.js';
import { checkLicense, isExemptMethod, LICENSE_TIERS } from '../license.js';
import { SCHEMA_SQL } from '../storage/schema.js';

describe('license', () => {
  it('returns free tier when no key is set', () => {
    const original = process.env['REVEALUI_LICENSE_KEY'];
    delete process.env['REVEALUI_LICENSE_KEY'];

    const result = checkLicense();
    expect(result.tier).toBe('free');
    expect(result.valid).toBe(false);

    if (original) process.env['REVEALUI_LICENSE_KEY'] = original;
  });

  it('validates a pro license key format', () => {
    process.env['REVEALUI_LICENSE_KEY'] = 'RVUI-pro-abcdef0123456789abcdef0123456789';
    const result = checkLicense();
    expect(result.tier).toBe('pro');
    expect(result.valid).toBe(true);
    delete process.env['REVEALUI_LICENSE_KEY'];
  });

  it('rejects invalid license key formats', () => {
    process.env['REVEALUI_LICENSE_KEY'] = 'invalid-key';
    const result = checkLicense();
    expect(result.tier).toBe('free');
    expect(result.valid).toBe(false);
    delete process.env['REVEALUI_LICENSE_KEY'];
  });

  it('exports all known license tiers', () => {
    expect(LICENSE_TIERS).toEqual(['free', 'pro', 'max', 'enterprise']);
  });

  it('marks session methods as exempt', () => {
    expect(isExemptMethod('ping')).toBe(true);
    expect(isExemptMethod('session.register')).toBe(true);
    expect(isExemptMethod('agent.spawn')).toBe(false);
    expect(isExemptMethod('merge.request')).toBe(false);
  });
});

describe('schema', () => {
  it('exports SCHEMA_SQL as a non-empty string', () => {
    expect(typeof SCHEMA_SQL).toBe('string');
    expect(SCHEMA_SQL.length).toBeGreaterThan(100);
  });

  it('contains all expected table definitions', () => {
    const tables = [
      'agent_sessions',
      'agent_messages',
      'file_reservations',
      'tasks',
      'events',
      'worktrees',
      'agent_memory',
      'merge_requests',
    ];
    for (const table of tables) {
      expect(SCHEMA_SQL).toContain(table);
    }
  });
});

describe('config', () => {
  it('exports default daemon configuration', () => {
    expect(DAEMON_DEFAULTS.socketPath).toContain('harness.sock');
    expect(DAEMON_DEFAULTS.httpPort).toBe(0);
    expect(DAEMON_DEFAULTS.httpHost).toBe('127.0.0.1');
    expect(DAEMON_DEFAULTS.maxMemoryMb).toBe(512);
  });
});
