/** Synthetic child host: redirects only the fixed production authority to its test server. */
import { LICENSE_API_ORIGIN } from '../../license-authority.js';
import { startDaemon } from '../../server.js';

process.once(
  'message',
  async (message: { dataDir: string; socketPath: string; httpPort: number; authority: string }) => {
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (input, init) =>
      String(input) === `${LICENSE_API_ORIGIN}/api/license/verify`
        ? nativeFetch(message.authority, init)
        : nativeFetch(input, init);
    try {
      const daemon = await startDaemon({
        dataDir: message.dataDir,
        socketPath: message.socketPath,
        httpPort: message.httpPort,
        httpHost: '127.0.0.1',
      });
      process.send?.({ ready: true });
      process.once('message', async () => {
        await daemon.close();
        process.exit(0);
      });
    } catch (error) {
      process.send?.({ error: error instanceof Error ? error.message : String(error) });
      process.exit(1);
    }
  },
);
