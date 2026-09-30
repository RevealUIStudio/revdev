#!/usr/bin/env -S node --import=tsx

/** Authenticated hosted issuance. Local signing keys cannot establish shared revocation authority. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LICENSE_API_ORIGIN } from '../packages/daemon/src/license-authority.js';
import { getVendorPublicKey, verifyLicenseJWT } from '../packages/daemon/src/license-crypto.js';

export interface Options {
  tier: 'pro' | 'max' | 'enterprise';
  operationId?: string;
  expectedMode?: 'live' | 'test';
  expectedCurrentLicenseKey?: string;
  customer?: string;
  days?: number;
  perpetual?: boolean;
  /** Explicit revvault destination; overrides the derived default. */
  store?: string;
  /** Print the JWT to stdout instead of storing (delivery flows). */
  print?: boolean;
}

/**
 * Default revvault destination for a minted license. The founder dogfood key
 * has a fixed fleet path; customer keys follow the forge/customers/* pattern
 * already in the vault. No customer and no --store → no silent default.
 */
export function deriveStorePath(opts: Options): string | null {
  if (opts.store) return opts.store;
  if (opts.customer === 'founder') return 'revealui/dev/founder-license-key';
  if (opts.customer) return `forge/customers/${opts.customer}/license-key`;
  return null;
}

/** License writes may only target the two supported license-key namespaces.
 * In particular, a CLI --store value must never reach a signing-key path. */
export function validateLicenseStorePath(path: string, customer?: string): void {
  if (
    path !== 'revealui/dev/founder-license-key' &&
    !/^forge\/customers\/[a-zA-Z0-9][a-zA-Z0-9._-]*\/license-key$/.test(path)
  ) {
    throw new Error('Vault destination must be a supported license-key path.');
  }
  if (customer !== undefined && path !== deriveStorePath({ tier: 'pro', customer })) {
    throw new Error('Vault destination must match the license customer.');
  }
}

export function validateIssueOptions(opts: Options): void {
  if (!['pro', 'max', 'enterprise'].includes(opts.tier)) {
    throw new Error('License tier must be pro, max, or enterprise.');
  }
  if (
    opts.days !== undefined &&
    (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > 3650)
  ) {
    throw new Error('License days must be an integer from 1 to 3650.');
  }
  if (opts.perpetual && opts.days !== undefined) {
    throw new Error('Use either --perpetual or --days, not both.');
  }
  if (opts.customer !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(opts.customer)) {
    throw new Error('Customer must be a single path-safe identifier.');
  }
  const storePath = deriveStorePath(opts);
  if (storePath !== null) validateLicenseStorePath(storePath, opts.customer);
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const opts: Options = { tier: 'pro' };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--operation-id':
        opts.operationId = args[++i];
        break;
      case '--mode':
        opts.expectedMode = args[++i] as Options['expectedMode'];
        break;
      case '--tier':
        opts.tier = args[++i] as Options['tier'];
        break;
      case '--customer':
        opts.customer = args[++i];
        break;
      case '--days':
        opts.days = Number(args[++i]);
        break;
      case '--perpetual':
        opts.perpetual = true;
        break;
      case '--store':
        opts.store = args[++i];
        break;
      case '--print':
        opts.print = true;
        break;
      case '--help':
      case '-h':
        console.log(`
Issue registered RevDev license through hosted authority

Usage:
  npx tsx scripts/issue-license.ts --tier <pro|max|enterprise> [options]

Options:
  --operation-id <uuid>         Stable identifier retained across retries.
  --mode <live|test>            Required expected hosted mode for Vault promotion.
  --tier <pro|max|enterprise>   License tier (authenticated hosted grant)
  --customer <name>             Customer identifier (embedded in JWT payload)
  --days <n>                    Expiry in days (default: 90)
  --perpetual                   Never expires (omits exp claim)
  --store <revvault-path>       Vault destination (default derived: founder →
                                revealui/dev/founder-license-key, else
                                forge/customers/<customer>/license-key)
  --print                       Print the JWT to stdout instead of storing
  --help                        Show this help

Hosted issuance uses existing REVEALUI_ADMIN_API_KEY authentication.
Vault promotion uses the maintained conditional RevVault CLI and requires matching hosted issuer trust.
Retry the identical operation UUID and request; hosted containment commits before local promotion.
--print explicitly delivers the registered token; it does not activate a machine.
`);
        process.exit(0);
        break;
      default:
        throw new Error('Unknown license issuance option.');
    }
  }

  return opts;
}

export function requireOperationId(value: string | undefined): string {
  if (
    !value ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error('Hosted issuance requires a stable operation UUID.');
  }
  return value;
}

export interface NormalizedGrant {
  tier: Options['tier'];
  domains: null;
  maxSites: number | null;
  maxUsers: null;
  perpetual: boolean;
  expiresInSeconds: number | null;
}

export type PromotionIdentity = Pick<VaultPromotion, 'kind' | 'path'>;
export interface HostedOperation {
  version: 1;
  operationId: string;
  customerId: string;
  mode: 'live' | 'test';
  grant: NormalizedGrant;
  effectiveGrant: NormalizedGrant;
  action: 'initial' | 'rotation';
  expectedCurrentLicenseKeySha256: string | null;
  promotion: VaultPromotion;
}
interface HostedResult {
  licenseKey: string;
  operation: HostedOperation | null;
}

function normalizedGrant(opts: Options): NormalizedGrant {
  return {
    tier: opts.tier,
    domains: null,
    maxSites: null,
    maxUsers: null,
    perpetual: opts.perpetual === true,
    expiresInSeconds: opts.perpetual === true ? null : (opts.days ?? 90) * 86_400,
  };
}

function validatePromotionContext(opts: Options, identity: PromotionIdentity): void {
  validateIssueOptions(opts);
  requireOperationId(opts.operationId);
  if (!opts.customer) throw new Error('Hosted issuance requires customer identity.');
  if (opts.expectedMode !== 'live' && opts.expectedMode !== 'test') {
    throw new Error('Vault promotion requires an explicit --mode live or test.');
  }
  if (
    !exactObject(identity, ['kind', 'path']) ||
    (identity.kind !== 'initial' && identity.kind !== 'rotation')
  ) {
    throw new Error('Invalid license promotion identity.');
  }
  validateLicenseStorePath(identity.path, opts.customer);
}

function operationIdentity(
  body: Record<string, unknown>,
  opts: Options,
  identity: PromotionIdentity,
  expected?: VaultExpectation,
): HostedOperation {
  const operation = body.operation;
  const fields = [
    'version',
    'operationId',
    'customerId',
    'mode',
    'grant',
    'effectiveGrant',
    'action',
    'expectedCurrentLicenseKeySha256',
    'promotion',
  ];
  if (
    !exactObject(body, ['licenseKey', 'tier', 'customerId', 'operation']) ||
    !exactObject(operation, fields) ||
    operation.version !== 1 ||
    operation.operationId !== requireOperationId(opts.operationId).toLowerCase() ||
    operation.customerId !== opts.customer ||
    operation.mode !== opts.expectedMode ||
    operation.action !== identity.kind
  ) {
    throw new Error('Hosted license operation returned invalid receipt identity.');
  }
  const grant = normalizedGrant(opts);
  const actualGrant = operation.grant;
  if (
    !exactObject(actualGrant, Object.keys(grant)) ||
    Object.entries(grant).some(([field, value]) => actualGrant[field] !== value)
  ) {
    throw new Error('Hosted license operation returned a changed grant.');
  }
  const effective = operation.effectiveGrant;
  if (
    !exactObject(effective, Object.keys(grant)) ||
    Object.entries(grant).some(
      ([field, value]) => field !== 'maxSites' && effective[field] !== value,
    ) ||
    (effective.maxSites !== grant.maxSites &&
      (!grant.perpetual ||
        grant.maxSites !== null ||
        typeof effective.maxSites !== 'number' ||
        !Number.isInteger(effective.maxSites) ||
        effective.maxSites < 1 ||
        effective.maxSites > 10_000))
  ) {
    throw new Error('Hosted license operation returned invalid effective grant.');
  }
  const effectiveGrant: NormalizedGrant = {
    ...grant,
    maxSites: typeof effective.maxSites === 'number' ? effective.maxSites : null,
  };
  const promotion = operation.promotion;
  if (
    !exactObject(promotion, ['kind', 'path', 'expected']) ||
    promotion.kind !== identity.kind ||
    promotion.path !== identity.path ||
    !validExpectation(promotion.expected) ||
    (identity.kind === 'initial' &&
      (promotion.expected.kind !== 'absent' ||
        operation.expectedCurrentLicenseKeySha256 !== null)) ||
    (identity.kind === 'rotation' &&
      (promotion.expected.kind !== 'sha256' ||
        !validSha256(operation.expectedCurrentLicenseKeySha256))) ||
    (expected && !equalExpectation(promotion.expected, expected))
  ) {
    throw new Error('Hosted license operation returned invalid promotion binding.');
  }
  if (expected) {
    const priorHash = opts.expectedCurrentLicenseKey
      ? createHash('sha256').update(opts.expectedCurrentLicenseKey).digest('hex')
      : null;
    if (operation.expectedCurrentLicenseKeySha256 !== priorHash) {
      throw new Error('Hosted license operation returned invalid prior identity.');
    }
  }
  if (!opts.customer || (operation.mode !== 'live' && operation.mode !== 'test')) {
    throw new Error('Hosted license operation returned invalid mode.');
  }
  const prior = operation.expectedCurrentLicenseKeySha256;
  if (prior !== null && !validSha256(prior)) {
    throw new Error('Hosted license operation returned invalid prior identity.');
  }
  return {
    version: 1,
    operationId: requireOperationId(opts.operationId).toLowerCase(),
    customerId: opts.customer,
    mode: operation.mode,
    grant,
    effectiveGrant,
    action: identity.kind,
    expectedCurrentLicenseKeySha256: prior,
    promotion: { ...identity, expected: promotion.expected },
  };
}

/** One authenticated hosted operation transport for issuance and recovery. */
async function requestLicenseOperation(
  opts: Options,
  identity?: PromotionIdentity,
  expected?: VaultExpectation,
  recoverOnly = false,
): Promise<HostedResult | null> {
  validateIssueOptions(opts);
  const operationId = identity
    ? requireOperationId(opts.operationId).toLowerCase()
    : requireOperationId(opts.operationId);
  if (!opts.customer) throw new Error('Hosted issuance requires customer identity.');
  if (identity) validatePromotionContext(opts, identity);
  const adminKey = process.env.REVEALUI_ADMIN_API_KEY;
  if (!adminKey?.trim()) throw new Error('Hosted operator admin authentication is not configured.');
  let response: Response;
  try {
    response = await fetch(`${LICENSE_API_ORIGIN}/api/license/generate`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json', 'X-Admin-API-Key': adminKey },
      body: JSON.stringify({
        operationId,
        tier: opts.tier,
        customerId: opts.customer,
        perpetual: opts.perpetual === true,
        expiresInDays: opts.perpetual ? undefined : opts.days,
        ...(!recoverOnly ? { expectedCurrentLicenseKey: opts.expectedCurrentLicenseKey } : {}),
        ...(identity
          ? {
              expectedMode: opts.expectedMode,
              promotion: expected ? { ...identity, expected } : identity,
            }
          : {}),
        ...(recoverOnly ? { recoverOnly: true, action: identity?.kind } : {}),
      }),
    });
  } catch {
    throw new Error('Hosted license operation unavailable or migration required.');
  }
  if (
    response.redirected ||
    (!response.ok && !(recoverOnly && response.status === 404)) ||
    (identity && response.ok && response.status !== (recoverOnly ? 200 : 201))
  ) {
    throw new Error('Hosted license operation unavailable or migration required.');
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('Hosted license operation returned invalid identity.');
  }
  if (recoverOnly && response.status === 404) {
    if (exactObject(body, ['error']) && body.error === 'operation_not_found') return null;
    throw new Error('Hosted license recovery did not prove an operation miss.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('Hosted license operation returned invalid identity.');
  }
  const result = body as Record<string, unknown>;
  if (
    typeof result.licenseKey !== 'string' ||
    result.tier !== opts.tier ||
    result.customerId !== opts.customer
  ) {
    throw new Error('Hosted license operation returned invalid identity.');
  }
  const verified = verifyLicenseJWT(result.licenseKey, getVendorPublicKey());
  if (!verified.valid || verified.tier !== opts.tier) {
    throw new Error('Hosted issuer trust migration required; returned token rejected.');
  }
  const claims = JSON.parse(
    Buffer.from(result.licenseKey.split('.')[1] as string, 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
  if (
    claims.customerId !== opts.customer ||
    typeof claims.jti !== 'string' ||
    !claims.jti.trim() ||
    claims.jti !== claims.jti.trim() ||
    (opts.perpetual === true ? claims.exp !== undefined : typeof claims.exp !== 'number')
  ) {
    throw new Error('Hosted license operation returned invalid identity.');
  }
  const operation = identity ? operationIdentity(result, opts, identity, expected) : null;
  if (operation) {
    const grant = operation.effectiveGrant;
    if (
      claims.tier !== grant.tier ||
      claims.perpetual !== grant.perpetual ||
      Object.hasOwn(claims, 'domains') ||
      Object.hasOwn(claims, 'maxUsers') ||
      (grant.maxSites === null
        ? Object.hasOwn(claims, 'maxSites')
        : claims.maxSites !== grant.maxSites)
    ) {
      throw new Error('Hosted license operation returned a signed grant mismatch.');
    }
    if (
      !Number.isInteger(claims.iat) ||
      (grant.perpetual
        ? Object.hasOwn(claims, 'exp')
        : typeof claims.exp !== 'number' ||
          typeof claims.iat !== 'number' ||
          claims.exp - claims.iat !== grant.expiresInSeconds)
    ) {
      throw new Error('Hosted license operation returned a signed grant duration mismatch.');
    }
  }
  return { licenseKey: result.licenseKey, operation };
}

/** Explicit delivery keeps the existing authenticated registered issuance primitive. */
export async function issueLicense(opts: Options): Promise<string> {
  const result = await requestLicenseOperation(opts);
  if (!result) throw new Error('Hosted license operation unavailable.');
  return result.licenseKey;
}

export interface PreparedPromotion {
  expected: VaultExpectation;
  expectedCurrentLicenseKey?: string;
}
export type PromotionOutcome =
  | { status: 'not-needed' }
  | { status: 'promoted'; operationId: string; path: string };

/** Recover before observing today's Vault prior; preparation runs only on proven miss. */
export async function promoteLicense(
  opts: Options,
  identity: PromotionIdentity,
  prepare: () => PreparedPromotion | null,
): Promise<PromotionOutcome> {
  validatePromotionContext(opts, identity);
  let result = await requestLicenseOperation(opts, identity, undefined, true);
  if (!result) {
    const prepared = prepare();
    if (!prepared) return { status: 'not-needed' };
    if (
      !validExpectation(prepared.expected) ||
      (identity.kind === 'initial' &&
        (prepared.expected.kind !== 'absent' ||
          prepared.expectedCurrentLicenseKey !== undefined)) ||
      (identity.kind === 'rotation' &&
        (prepared.expected.kind !== 'sha256' || !prepared.expectedCurrentLicenseKey))
    ) {
      throw new Error('Invalid prepared license promotion.');
    }
    try {
      result = await requestLicenseOperation(
        { ...opts, expectedCurrentLicenseKey: prepared.expectedCurrentLicenseKey },
        identity,
        prepared.expected,
      );
    } catch {
      // A timeout/conflict may follow committed containment. This lookup never
      // mints and never rebuilds the original request from a changed prior.
      result = await requestLicenseOperation(opts, identity, undefined, true);
      if (!result) throw new Error('Hosted license operation did not confirm a committed result.');
    }
  }
  if (!result?.operation)
    throw new Error('Hosted license operation lacks a durable promotion descriptor.');
  revvaultSet(
    result.operation.promotion.path,
    result.licenseKey,
    result.operation.operationId,
    result.operation.promotion.expected,
  );
  return {
    status: 'promoted',
    operationId: result.operation.operationId,
    path: result.operation.promotion.path,
  };
}

export type VaultExpectation = { kind: 'absent' } | { kind: 'sha256'; sha256: string };

export interface VaultPromotion {
  kind: 'initial' | 'rotation';
  path: string;
  expected: VaultExpectation;
}

function exactObject(value: unknown, fields: string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function validSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function validExpectation(value: unknown): value is VaultExpectation {
  return (
    (exactObject(value, ['kind']) && value.kind === 'absent') ||
    (exactObject(value, ['kind', 'sha256']) && value.kind === 'sha256' && validSha256(value.sha256))
  );
}

function equalExpectation(left: VaultExpectation, right: VaultExpectation): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === 'absent' || (right.kind === 'sha256' && left.sha256 === right.sha256))
  );
}

/** Read exact decrypted UTF-8 bytes using the maintained JSON command, not terminal output. */
export function readCurrentLicense(path: string): { raw: string; token: string; sha256: string } {
  validateLicenseStorePath(path);
  let response: unknown;
  try {
    response = JSON.parse(
      execFileSync('revvault', ['--json', 'get', path], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
  } catch {
    throw new Error('Current Vault license is unavailable; refusing promotion.');
  }
  if (
    !exactObject(response, ['path', 'value', 'bytes']) ||
    response.path !== path ||
    typeof response.value !== 'string' ||
    Buffer.from(response.value, 'utf8').toString('utf8') !== response.value ||
    response.bytes !== Buffer.byteLength(response.value, 'utf8')
  ) {
    throw new Error('Current Vault license returned an invalid byte identity.');
  }
  return {
    raw: response.value,
    token: response.value.trim(),
    sha256: createHash('sha256').update(response.value, 'utf8').digest('hex'),
  };
}

/** Promote only the immutable committed hosted operation's exact single-leaf expectation. */
export function revvaultSet(
  path: string,
  value: string,
  operationId?: string,
  expected?: VaultExpectation,
): void {
  validateLicenseStorePath(path);
  const id = requireOperationId(operationId).toLowerCase();
  if (!validExpectation(expected)) {
    throw new Error('Credential promotion requires an immutable Vault expectation.');
  }
  if (!value) throw new Error('Credential promotion requires a committed hosted token.');
  const flags =
    expected.kind === 'absent'
      ? ['--expected-absent']
      : ['--expected-current-sha256', expected.sha256];
  let receipt: unknown;
  try {
    receipt = JSON.parse(
      execFileSync('revvault', ['set', path, '--operation-id', id, ...flags], {
        input: value,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
  } catch {
    throw new Error(
      'Vault conditional promotion unavailable or conflicting; hosted containment remains committed.',
    );
  }
  if (
    !exactObject(receipt, ['operation_id', 'path', 'status', 'current_matches']) ||
    receipt.operation_id !== id ||
    receipt.path !== path ||
    receipt.status !== 'committed' ||
    typeof receipt.current_matches !== 'boolean'
  ) {
    throw new Error('Vault conditional promotion returned an invalid receipt.');
  }
  if (!receipt.current_matches) {
    throw new Error(
      'Vault promotion was committed historically but its current value is superseded.',
    );
  }
}

/** True when this file is the process entrypoint (not imported). */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// --- CLI ---
// Only runs when invoked directly; importing this module is side-effect-free
// so rotate-license.ts can reuse the authenticated issueLicense primitive.
if (isMainModule()) {
  // Help is side-effect-free; retired local key generation always refuses.
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    parseArgs(); // prints help and exits
  }

  if (process.argv.includes('--generate-keypair')) {
    throw new Error(
      'Local signing key generation retired; hosted issuer trust migration required.',
    );
  }

  const opts = parseArgs();
  if (!opts.print) {
    const path = deriveStorePath(opts);
    if (!path) throw new Error('Vault promotion requires a customer and supported destination.');
    try {
      const outcome = await promoteLicense(opts, { kind: 'initial', path }, () => ({
        expected: { kind: 'absent' },
      }));
      console.log(`Local license promotion ${outcome.status}.`);
    } catch (error) {
      console.error(
        `Error: ${error instanceof Error ? error.message : 'License promotion failed.'}`,
      );
      process.exitCode = 1;
    }
  } else {
    let key: string;
    try {
      key = await issueLicense(opts);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    console.log('');
    console.log('  License Key Issued');
    console.log('  ──────────────────');
    console.log(`  Tier:     ${opts.tier.toUpperCase()}`);
    console.log(`  Customer: ${opts.customer ?? '(not specified)'}`);
    console.log(`  Expires:  ${opts.perpetual ? 'Never (perpetual)' : `${opts.days ?? 90} days`}`);
    console.log(`  Format:   Ed25519-signed JWT (RFC 7519)`);
    console.log('');

    if (opts.print) {
      console.log('  Key:');
      console.log(`  ${key}`);
      console.log('');
      console.log('  Deliver this key to the customer. They set it as:');
      console.log('  REVEALUI_LICENSE_KEY=<key>');
      console.log('');
    }
  }
}
