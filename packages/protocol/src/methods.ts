/**
 * RPC method name constants.
 *
 * Every method the daemon exposes is listed here so Studio, Terminal,
 * and test code can reference them without string literals.
 *
 * This list is NOT hand-maintained: the daemon package's rpc-contract test
 * registers all handlers exactly as production startup does and asserts that
 * `listRegisteredMethods()` equals `Object.values(RPC_METHODS)` in both
 * directions. A method added to or removed from the daemon that is not
 * mirrored here fails that test, so the constant stays honest by construction.
 */

export const RPC_METHODS = {
  // System
  ping: 'ping',

  // Harness management
  'harness.health': 'harness.health',
  'harness.prune': 'harness.prune',

  // Agent sessions
  'session.register': 'session.register',
  'session.attach': 'session.attach',
  'session.update': 'session.update',
  'session.end': 'session.end',
  'session.list': 'session.list',

  // Agent identity
  'identity.rotate': 'identity.rotate',

  // Inter-agent messaging
  'mail.send': 'mail.send',
  'mail.broadcast': 'mail.broadcast',
  'mail.inbox': 'mail.inbox',
  'mail.markRead': 'mail.markRead',

  // File reservations
  'files.reserve': 'files.reserve',
  'files.check': 'files.check',
  'files.release': 'files.release',
  'files.list': 'files.list',

  // Task coordination
  'tasks.create': 'tasks.create',
  'tasks.claim': 'tasks.claim',
  'tasks.complete': 'tasks.complete',
  'tasks.release': 'tasks.release',
  'tasks.list': 'tasks.list',

  // Event log
  'events.log': 'events.log',
  'events.query': 'events.query',

  // Peer context composite (GAP-459 Phase 1)
  'context.snapshot': 'context.snapshot',

  // Agent memory
  'memory.store': 'memory.store',
  'memory.query': 'memory.query',

  // Agent spawning
  'agent.spawn': 'agent.spawn',
  'agent.stop': 'agent.stop',
  'agent.list': 'agent.list',
  'agent.remove': 'agent.remove',
  'agent.input': 'agent.input',
  'agent.resize': 'agent.resize',
  'agent.output': 'agent.output',
  'agent.streamTicket': 'agent.streamTicket',

  // Inference management
  'inference.status': 'inference.status',
  'inference.pull': 'inference.pull',
  'inference.delete': 'inference.delete',
  'inference.start': 'inference.start',
  'inference.stop': 'inference.stop',
  'inference.chat': 'inference.chat',
  'inference.generate': 'inference.generate',

  // Project access
  'project.open': 'project.open',
  'project.grant': 'project.grant',
  'project.revoke': 'project.revoke',

  // File I/O
  'file.read': 'file.read',
  'file.write': 'file.write',
  'file.delete': 'file.delete',
  'file.stat': 'file.stat',

  // Git operations
  'git.status': 'git.status',
  'git.diffFile': 'git.diffFile',
  'git.diffContent': 'git.diffContent',
  'git.readBlobAtHead': 'git.readBlobAtHead',
  'git.readBlobAtIndex': 'git.readBlobAtIndex',
  'git.listBranches': 'git.listBranches',
  'git.log': 'git.log',
  'git.stageFile': 'git.stageFile',
  'git.unstageFile': 'git.unstageFile',
  'git.discardFile': 'git.discardFile',
  'git.createBranch': 'git.createBranch',
  'git.switchBranch': 'git.switchBranch',
  'git.deleteBranch': 'git.deleteBranch',
  'git.commit': 'git.commit',
  'git.push': 'git.push',
  'git.pull': 'git.pull',

  // Worktree management
  'worktree.create': 'worktree.create',
  'worktree.list': 'worktree.list',
  'worktree.remove': 'worktree.remove',

  // Merge pipeline
  'merge.request': 'merge.request',
  'merge.status': 'merge.status',
  'merge.list': 'merge.list',
  'merge.update': 'merge.update',

  // Permission modes (GAP-294 Phase 1 pending/decide; Phase 2 setMode; §9 grants)
  'permission.pending': 'permission.pending',
  'permission.decide': 'permission.decide',
  'permission.setMode': 'permission.setMode',
  'permission.listGrants': 'permission.listGrants',
  'permission.grant': 'permission.grant',
  'permission.revokeGrant': 'permission.revokeGrant',

  // HTTP gateway token management (GAP-421 guardrail-2 remediation S5)
  'gateway.revokeToken': 'gateway.revokeToken',
} as const;
