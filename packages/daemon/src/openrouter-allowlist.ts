/**
 * US-origin allowlist, reviewed 2026-10-06; Arcee Trinity (US, Arcee-trained)
 * is pre-approved but has no free variant today.
 * Enforcement is allowlist-only. An id that is not listed here is refused
 * before any network call. `openrouter/free` is not an allowlist entry.
 */

export type OpenRouterTier = 'default' | 'training' | 'explicit';

export interface OpenRouterAllowlistEntry {
  id: string;
  canonicalSlug: string;
  lab: string;
  origin: 'US';
  providerTrains: boolean;
  tier: OpenRouterTier;
}

export const OPENROUTER_ALLOWLIST: readonly OpenRouterAllowlistEntry[] = [
  {
    id: 'google/gemma-4-31b-it:free',
    canonicalSlug: 'google/gemma-4-31b-it-20260402',
    lab: 'Google DeepMind',
    origin: 'US',
    providerTrains: false,
    tier: 'default',
  },
  {
    id: 'google/gemma-4-26b-a4b-it:free',
    canonicalSlug: 'google/gemma-4-26b-a4b-it-20260403',
    lab: 'Google DeepMind',
    origin: 'US',
    providerTrains: false,
    tier: 'default',
  },
  {
    id: 'nvidia/nemotron-3-super-120b-a12b:free',
    canonicalSlug: 'nvidia/nemotron-3-super-120b-a12b-20230311',
    lab: 'NVIDIA',
    origin: 'US',
    providerTrains: true,
    tier: 'training',
  },
  {
    id: 'nvidia/nemotron-3.5-lightning:free',
    canonicalSlug: 'nvidia/nemotron-3.5-lightning-20260807',
    lab: 'NVIDIA',
    origin: 'US',
    providerTrains: true,
    tier: 'training',
  },
  {
    id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    canonicalSlug: 'nvidia/nemotron-3-ultra-550b-a55b-20260604',
    lab: 'NVIDIA',
    origin: 'US',
    providerTrains: true,
    tier: 'explicit',
  },
  {
    id: 'thinkingmachines/inkling:free',
    canonicalSlug: 'thinkingmachines/inkling-20260715',
    lab: 'Thinking Machines Lab',
    origin: 'US',
    providerTrains: true,
    tier: 'explicit',
  },
  {
    id: 'thinkingmachines/inkling-small:free',
    canonicalSlug: 'thinkingmachines/inkling-small-20260730',
    lab: 'Thinking Machines Lab',
    origin: 'US',
    providerTrains: true,
    tier: 'explicit',
  },
  {
    id: 'liquid/lfm-2.5-2.6b:free',
    canonicalSlug: 'liquid/lfm-2.5-2.6b-20260811',
    lab: 'Liquid AI',
    origin: 'US',
    providerTrains: true,
    tier: 'explicit',
  },
];

/** Default chain. Works with data_collection deny. */
export const DEFAULT_CHAIN: readonly string[] = [
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
];

/** Used only when REVDEV_OPENROUTER_ALLOW_TRAINING=1. */
export const TRAINING_ALLOWED_CHAIN: readonly string[] = [
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3.5-lightning:free',
];

export const DEFAULT_OPENROUTER_MODEL = 'google/gemma-4-31b-it:free';

export const OPENROUTER_FREE_ROUTER_MODEL = 'openrouter/free';

const MAX_CHAIN = 3;

function entryById(id: string): OpenRouterAllowlistEntry | undefined {
  return OPENROUTER_ALLOWLIST.find((entry) => entry.id === id);
}

function assertListed(chain: readonly string[]): void {
  for (const id of chain) {
    if (!entryById(id)) {
      throw new Error(`OpenRouter chain id is not on the allowlist: ${id}`);
    }
  }
  if (chain.length > MAX_CHAIN) {
    throw new Error('OpenRouter chain is longer than 3');
  }
}

assertListed(DEFAULT_CHAIN);
assertListed(TRAINING_ALLOWED_CHAIN);
if (DEFAULT_CHAIN[0] !== DEFAULT_OPENROUTER_MODEL) {
  throw new Error('default model must be the first id in DEFAULT_CHAIN');
}

export function responseModelAliases(entry: OpenRouterAllowlistEntry): readonly string[] {
  const slug = entry.canonicalSlug;
  const slugFree = slug.endsWith(':free') ? slug : `${slug}:free`;
  return [entry.id, slug, slugFree];
}

/**
 * Accept the response model when it is a chain id, or that id's pinned
 * canonical slug with or without the `:free` suffix.
 * `openrouter/free` is not itself an allowlist id. When that router was the
 * request, accept any allowlist entry instead, because the router names the
 * model that actually answered.
 */
export function isAllowlistedResponseModel(model: string, chain: readonly string[]): boolean {
  const trimmed = model.trim();
  if (!trimmed) return false;
  const freeRouter = chain.length === 1 && chain[0] === OPENROUTER_FREE_ROUTER_MODEL;
  const entries = freeRouter
    ? OPENROUTER_ALLOWLIST
    : OPENROUTER_ALLOWLIST.filter((entry) => chain.includes(entry.id));
  return entries.some((entry) => responseModelAliases(entry).includes(trimmed));
}

export interface ResolvedOpenRouterChain {
  ok: true;
  chain: string[];
  freeRouter: boolean;
  dataCollection: 'deny' | 'allow';
}

export interface RejectedOpenRouterChain {
  ok: false;
  error: string;
  status: 'not_allowlisted';
}

function trainingAllowed(env: NodeJS.ProcessEnv): boolean {
  return env.REVDEV_OPENROUTER_ALLOW_TRAINING === '1';
}

function activeChain(env: NodeJS.ProcessEnv): readonly string[] {
  return trainingAllowed(env) ? TRAINING_ALLOWED_CHAIN : DEFAULT_CHAIN;
}

function notAllowlisted(id: string): RejectedOpenRouterChain {
  return {
    ok: false,
    status: 'not_allowlisted',
    error: `Model "${id}" is not on the revdev OpenRouter US allowlist`,
  };
}

function chainStartingWith(model: string, env: NodeJS.ProcessEnv): string[] {
  const rest = activeChain(env).filter((id) => id !== model);
  return [model, ...rest].slice(0, MAX_CHAIN);
}

/**
 * Fail closed. A requested id must be allowlisted and permitted in the
 * current mode. Training and explicit tiers require
 * REVDEV_OPENROUTER_ALLOW_TRAINING=1. `openrouter/free` is accepted only when
 * REVDEV_OPENROUTER_ALLOW_FREE_ROUTER=1 and the caller named it. It is never
 * copied into a default chain. REVDEV_OPENROUTER_MODEL must be allowlisted
 * and permitted, or the call errors.
 */
export function resolveOpenRouterChain(
  requested: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedOpenRouterChain | RejectedOpenRouterChain {
  const dataCollection = trainingAllowed(env) ? 'allow' : 'deny';
  const raw = requested?.trim() ?? '';

  if (raw === OPENROUTER_FREE_ROUTER_MODEL) {
    if (env.REVDEV_OPENROUTER_ALLOW_FREE_ROUTER !== '1') {
      return notAllowlisted(OPENROUTER_FREE_ROUTER_MODEL);
    }
    return {
      ok: true,
      chain: [OPENROUTER_FREE_ROUTER_MODEL],
      freeRouter: true,
      dataCollection,
    };
  }

  let chosen = raw;
  if (!chosen) {
    const fromEnv = env.REVDEV_OPENROUTER_MODEL?.trim() ?? '';
    if (fromEnv) {
      const envEntry = entryById(fromEnv);
      if (!envEntry || (envEntry.tier !== 'default' && !trainingAllowed(env))) {
        return notAllowlisted(fromEnv);
      }
      chosen = fromEnv;
    }
  }

  if (!chosen) {
    return {
      ok: true,
      chain: [...activeChain(env)],
      freeRouter: false,
      dataCollection,
    };
  }

  const entry = entryById(chosen);
  if (!entry || (entry.tier !== 'default' && !trainingAllowed(env))) {
    return notAllowlisted(chosen);
  }

  return {
    ok: true,
    chain: chainStartingWith(chosen, env),
    freeRouter: false,
    dataCollection,
  };
}
