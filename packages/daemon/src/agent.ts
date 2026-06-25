/**
 * agent.* stub handlers — register the agent spawning surface in the daemon
 * so browser+daemon mode receives a descriptive -32005 error instead of the
 * silent -32601 "Method not found" returned when no handler exists.
 *
 * Full agent spawning runs through spawner.rs in Tauri desktop mode; the
 * daemon does not own the PTY lifecycle. These stubs exist purely to surface
 * an actionable error in browser+daemon mode.
 */

import { registerHandler } from './server.js';

class DesktopOnlyError extends Error {
  readonly code = -32005;
  constructor(method: string) {
    super(
      `${method} requires the RevDev desktop app (Tauri). Agent spawning is handled by the ` +
        `native Rust backend (spawner.rs) and is not available via the JSON-RPC daemon socket. ` +
        `Launch RevDev Studio to use agent operations.`,
    );
    this.name = 'DesktopOnlyError';
  }
}

registerHandler('agent.spawn', async () => {
  throw new DesktopOnlyError('agent.spawn');
});

registerHandler('agent.stop', async () => {
  throw new DesktopOnlyError('agent.stop');
});

registerHandler('agent.input', async () => {
  throw new DesktopOnlyError('agent.input');
});

registerHandler('agent.resize', async () => {
  throw new DesktopOnlyError('agent.resize');
});
