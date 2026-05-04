/**
 * RPC input validation — validates params before handler dispatch.
 *
 * The only registered method without a schema is `ping` (intentional —
 * no params). Methods with a schema are validated and rejected with
 * JSON-RPC -32602 (Invalid params) on failure. Unknown methods also
 * pass through here (the registry only validates known methods; the
 * dispatcher surfaces -32601 Method not found later).
 */

import { schemas } from './schemas.js';

export * from './limits.js';
export { schemas } from './schemas.js';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate RPC method params against the registered schema.
 * Returns { valid: true } if no schema exists (pass-through) or validation passes.
 * Returns { valid: false, error } with a human-readable error message on failure.
 */
export function validateParams(method: string, params: unknown): ValidationResult {
  const schema = schemas[method];
  if (!schema) {
    // No schema registered — allow (ping, harness.health, inference.status)
    return { valid: true };
  }

  const result = schema.safeParse(params ?? {});
  if (result.success) {
    return { valid: true };
  }

  // Format Zod errors into a concise message
  const issues = result.error.issues
    .slice(0, 3) // Limit to 3 issues to avoid huge error messages
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${path}${issue.message}`;
    })
    .join('; ');

  return { valid: false, error: issues };
}

/**
 * JSON-RPC 2.0 error response for invalid params.
 * Uses error code -32602 (standard invalid params code).
 */
export function invalidParamsResponse(id: number | string | null, error: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32602,
      message: 'Invalid params',
      data: { details: error },
    },
  });
}
