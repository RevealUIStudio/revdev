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

  // GAP-154 Phase 5 — daemon peer registry (Neon role=daemon)
  'daemon.peers': 'daemon.peers',

  // Agent sessions
  'session.register': 'session.register',
  'session.attach': 'session.attach',
  'session.update': 'session.update',
  'session.end': 'session.end',
  'session.list': 'session.list',
  // GAP-342 — five-section fidelity snapshot (id-match store/serve)
  'session.snapshot.write': 'session.snapshot.write',
  'session.snapshot.get': 'session.snapshot.get',
  'session.snapshot.prune': 'session.snapshot.prune',

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

  // GAP-323 — design-pack filesystem watch (native pair of GAP-322 advisory)
  'design.pack.status': 'design.pack.status',
  'design.pack.watch': 'design.pack.watch',
  'design.pack.unwatch': 'design.pack.unwatch',
  'design.pack.scan': 'design.pack.scan',

  // Task coordination
  'tasks.create': 'tasks.create',
  'tasks.claim': 'tasks.claim',
  'tasks.complete': 'tasks.complete',
  'tasks.release': 'tasks.release',
  'tasks.list': 'tasks.list',

  // Goals (roadmap-goal-spine PR0 — propose-only GoalHarness)
  'goal.create': 'goal.create',
  'goal.get': 'goal.get',
  'goal.list': 'goal.list',
  'goal.setStatus': 'goal.setStatus',
  'goal.addCriterion': 'goal.addCriterion',
  'goal.recordCriterion': 'goal.recordCriterion',
  'goal.listCriteria': 'goal.listCriteria',
  'goal.progress': 'goal.progress',
  'goal.nextActions': 'goal.nextActions',
  'goal.proposeTask': 'goal.proposeTask',

  // Event log
  'events.log': 'events.log',
  'events.query': 'events.query',
  'events.wait': 'events.wait',
  // GAP-362 token-economy loop guard
  'loop.arm': 'loop.arm',
  'loop.tick': 'loop.tick',
  'loop.status': 'loop.status',
  'loop.spend': 'loop.spend',
  'loop.record_spend': 'loop.record_spend',
  'loop.pause': 'loop.pause',
  'loop.resume': 'loop.resume',
  'loop.stop': 'loop.stop',

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

  // GAP-474 — operational workflows (registry under REVDEV_JV_ROOT / workflows)
  'workflow.list': 'workflow.list',
  'workflow.run': 'workflow.run',

  // GAP-293 Phase B — read-only skill catalog (no execution)
  'skills.list': 'skills.list',
  // GAP-293 Phase C — native workflow generate on product default snap
  'skills.invoke': 'skills.invoke',

  // GAP-349 P5 — local knowledge-graph replica (PGlite) + outbox push to Neon
  'graph.status': 'graph.status',
  'graph.search': 'graph.search',
  'graph.node': 'graph.node',
  'graph.neighbors': 'graph.neighbors',
  'graph.at': 'graph.at',
  'graph.context': 'graph.context',
  'graph.addEpisode': 'graph.addEpisode',
  'graph.outbox.push': 'graph.outbox.push',
  'graph.sync.pull': 'graph.sync.pull',
} as const;
