import { describe, expect, it } from 'vitest';
import { parseApprovalsArgs } from '../approvals-cli.js';

describe('revdev approvals argv', () => {
  it('lists when no subcommand is given', () => {
    expect(parseApprovalsArgs([])).toEqual({ cmd: 'list' });
    expect(parseApprovalsArgs(['list'])).toEqual({ cmd: 'list' });
  });

  it('parses a decide verdict', () => {
    expect(parseApprovalsArgs(['decide', 'ap-1', 'approved'])).toEqual({
      cmd: 'decide',
      approvalId: 'ap-1',
      verdict: 'approved',
    });
    expect(parseApprovalsArgs(['decide', 'ap-1', 'DENIED'])).toEqual({
      cmd: 'decide',
      approvalId: 'ap-1',
      verdict: 'denied',
    });
  });

  it('rejects a missing verdict', () => {
    expect(parseApprovalsArgs(['decide', 'ap-1']).cmd).toBe('error');
    expect(parseApprovalsArgs(['nope']).cmd).toBe('error');
  });
});
