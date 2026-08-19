/**
 * Input size limits for daemon RPC params.
 * Prevents resource exhaustion from oversized inputs.
 */

/** Maximum agent/session name length */
export const MAX_NAME_LENGTH = 256;

/** Maximum message subject length */
export const MAX_SUBJECT_LENGTH = 500;

/** Maximum message/description body length (50KB) */
export const MAX_BODY_LENGTH = 50_000;

/** Maximum file path length */
export const MAX_PATH_LENGTH = 4096;

/**
 * Maximum bytes accepted by `file.write` content. 768 KiB — symmetric with the
 * daemon's `maxInlineReadBytes` read cap, so the write surface is bounded
 * explicitly (clean -32602) rather than only by the 1 MiB inbound frame cap.
 */
export const MAX_FILE_WRITE_BYTES = 786_432;

/** Maximum number of paths in a batch operation */
export const MAX_PATHS_BATCH = 100;

/** Maximum number of message IDs in markRead */
export const MAX_IDS_BATCH = 200;

/** Maximum event payload JSON size (100KB) */
export const MAX_PAYLOAD_SIZE = 100_000;

/** Maximum memory content length (500KB) */
export const MAX_MEMORY_LENGTH = 500_000;

/** GAP-349 episode content cap (lockstep with @revealui/mcp kg_add_episode). */
export const MAX_EPISODE_CONTENT_CHARS = 64_000;

/** Maximum TTL for file reservations (24 hours in seconds) */
export const MAX_TTL_SECONDS = 86_400;

/** Maximum query limit for list operations */
export const MAX_QUERY_LIMIT = 500;
