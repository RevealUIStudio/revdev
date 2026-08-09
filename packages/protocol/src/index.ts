/**
 * @revdev/protocol — JSON-RPC 2.0 type definitions for RevDev.
 *
 * Shared between Studio (Tauri), Terminal (Go), and the Harness Daemon (Node.js).
 * All inter-process communication uses these types.
 *
 * @packageDocumentation
 */

export type {
  HarnessCapabilities,
  HarnessCommand,
  HarnessCommandResult,
  HarnessEvent,
  HarnessInfo,
  HarnessProcessInfo,
  HealthCheckResult,
} from './harness.js';
export { RPC_METHODS } from './methods.js';
export type { JsonRpcRequest, JsonRpcResponse, RpcErrorCode } from './rpc.js';
export {
  waitForWorkCompleted,
  WORK_COMPLETED_EVENT,
  type DaemonRpc,
  type WaitForWorkParams,
  type WaitForWorkResult,
} from './wait-for-work.js';
export type {
  AgentMemoryEntry,
  AgentMessage,
  AgentSession,
  AgentTask,
  AgentWorktree,
  DaemonEvent,
  FileReservation,
  MergeRequest,
} from './schema.js';
export type {
  ConflictResult,
  TaskPriority,
  TaskStatus,
  WorkboardAgent,
  WorkboardBlockedTask,
  WorkboardDoneTask,
  WorkboardState,
  WorkboardTask,
} from './workboard.js';
