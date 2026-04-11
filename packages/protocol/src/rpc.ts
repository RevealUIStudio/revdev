/**
 * JSON-RPC 2.0 base types.
 */

/** Standard JSON-RPC error codes. */
export type RpcErrorCode =
  | -32700  // Parse error
  | -32600  // Invalid request
  | -32601  // Method not found
  | -32602  // Invalid params
  | -32603; // Internal error

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}
