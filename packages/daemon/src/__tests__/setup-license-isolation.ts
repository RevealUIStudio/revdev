/** All daemon tests use synthetic license storage, including tests without a JTI. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, vi } from 'vitest';
import { installTestLicenseAuthority } from './test-license-helper.js';

const settings = [
  'REVEALUI_LICENSE_KEY',
  'REVEALUI_LICENSE_KEY_FILE',
  'REVEALUI_REVOKED_JTI_FILE',
  'REVDEV_DAEMON_DATA',
] as const;
const prior = settings.map((name) => process.env[name]);
const fixtureRoot = mkdtempSync(join(tmpdir(), 'revdev-license-suite-'));
// Setup runs before test module imports, so even original-environment snapshots
// and helper consumers cannot authorize against an operator's installed token.
delete process.env.REVEALUI_LICENSE_KEY;
delete process.env.REVEALUI_LICENSE_KEY_FILE;
process.env.REVDEV_DAEMON_DATA = fixtureRoot;
process.env.REVEALUI_REVOKED_JTI_FILE = join(fixtureRoot, 'revoked-jtis.json');
// Every licensed daemon suite uses the same exact-token synthetic registration
// fixture. Focused authority tests can still replace the transport explicitly.
installTestLicenseAuthority();

afterAll(() => {
  vi.unstubAllGlobals();
  settings.forEach((name, index) => {
    if (prior[index] === undefined) delete process.env[name];
    else process.env[name] = prior[index];
  });
  rmSync(fixtureRoot, { recursive: true, force: true });
});
