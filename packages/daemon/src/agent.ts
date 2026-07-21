/**
 * agent.* load-order placeholders.
 *
 * Production entrypoints (`cli.ts`, `index.ts`) import this module FIRST, then
 * `spawn.ts`, which overwrites every agent.* handler with the real PTY-backed
 * implementations (signed, granted-root, bwrap-confined on Linux/WSL2).
 *
 * These stubs only fire if `spawn.ts` fails to load after this module — they
 * are NOT the desktop-only surface. The live multi-agent spawn path is the
 * daemon (see spawn.ts + confinement.ts), not Tauri `spawner.rs` (that path is
 * local Ollama/Snap lifecycle, a separate Studio surface).
 *
 * Registering placeholders here also keeps the method names present for
 * tooling that inspects partial import graphs; the rpc-contract test loads
 * the full index (stubs then overwrite) so the public surface is spawn.ts.
 */

import { registerHandler } from './server.js';

class SpawnSurfaceUnavailableError extends Error {
  readonly code = -32005;
  constructor(method: string) {
    super(
      `${method}: daemon agent PTY surface is not loaded. ` +
        `Production entrypoints must import spawn.ts after agent.ts. ` +
        `If you see this in a running daemon, the process is mis-bundled — restart or reinstall @revdev/daemon.`,
    );
    this.name = 'SpawnSurfaceUnavailableError';
  }
}

registerHandler('agent.spawn', async () => {
  throw new SpawnSurfaceUnavailableError('agent.spawn');
});

registerHandler('agent.stop', async () => {
  throw new SpawnSurfaceUnavailableError('agent.stop');
});

registerHandler('agent.list', async () => {
  throw new SpawnSurfaceUnavailableError('agent.list');
});

registerHandler('agent.remove', async () => {
  throw new SpawnSurfaceUnavailableError('agent.remove');
});

registerHandler('agent.input', async () => {
  throw new SpawnSurfaceUnavailableError('agent.input');
});

registerHandler('agent.resize', async () => {
  throw new SpawnSurfaceUnavailableError('agent.resize');
});

registerHandler('agent.output', async () => {
  throw new SpawnSurfaceUnavailableError('agent.output');
});
