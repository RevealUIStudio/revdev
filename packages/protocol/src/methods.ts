/**
 * RPC method name constants.
 *
 * Every method the daemon exposes is listed here so Studio, Terminal,
 * and test code can reference them without string literals.
 */

export const RPC_METHODS = {
  // System
  ping: 'ping',

  // Harness management
  'harness.list': 'harness.list',
  'harness.execute': 'harness.execute',
  'harness.info': 'harness.info',
  'harness.listRunning': 'harness.listRunning',
  'harness.syncConfig': 'harness.syncConfig',
  'harness.diffConfig': 'harness.diffConfig',
  'harness.health': 'harness.health',
  'harness.prune': 'harness.prune',

  // Agent sessions
  'session.register': 'session.register',
  'session.attach': 'session.attach',
  'session.update': 'session.update',
  'session.end': 'session.end',
  'session.list': 'session.list',
  'session.history': 'session.history',

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

  // Agent spawning
  'agent.spawn': 'agent.spawn',
  'agent.stop': 'agent.stop',
  'agent.input': 'agent.input',
  'agent.resize': 'agent.resize',

  // Inference management
  'inference.status': 'inference.status',
  'inference.pull': 'inference.pull',
  'inference.start': 'inference.start',
  'inference.stop': 'inference.stop',

  // Worktree management
  'worktree.create': 'worktree.create',
  'worktree.list': 'worktree.list',
  'worktree.remove': 'worktree.remove',

  // Merge pipeline
  'merge.request': 'merge.request',
  'merge.status': 'merge.status',
  'merge.list': 'merge.list',
  'merge.update': 'merge.update',

  // Agent memory
  'memory.store': 'memory.store',
  'memory.query': 'memory.query',
} as const;
