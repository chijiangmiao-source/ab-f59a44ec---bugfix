import { audit } from '../solver/solve';
import type { AuditInput, AuditOutcome, PackedAuditInput } from '../solver/types';

/**
 * 主线程与计算线程之间的消息协议。
 * 打包 / 解包 / 请求处理集中在本模块，页面（App）、Worker 入口与
 * 验收测试共用同一实现，保证完整消息路径上的数值精确一致。
 */

/** 主线程 → 计算线程 的审计请求。 */
export interface AuditRequest {
  id: number;
  input: PackedAuditInput;
}

/** 计算线程 → 主线程 的审计响应。 */
export interface AuditResponse {
  id: number;
  outcome: AuditOutcome;
}

/**
 * 打包审计输入用于 postMessage。
 * 时刻与重频可以是任意安全整数（最大 2^53 − 1），Float64Array 能精确表示；
 * 绝不能用 Uint32Array——≥ 2^32 的值会被模 2^32 截断
 * （例如重频 4328521727 会变成 33554431）。
 */
export function packAuditInput(input: AuditInput): PackedAuditInput {
  return {
    times: Float64Array.from(input.times),
    pris: Float64Array.from(input.pris),
    maxMissed: input.maxMissed,
  };
}

/** 打包输入对应的 transfer 列表（转移缓冲区所有权，避免拷贝）。 */
export function packTransferables(packed: PackedAuditInput): Transferable[] {
  return [packed.times.buffer, packed.pris.buffer];
}

/** 计算线程侧解包：Float64Array 对安全整数精确，往返不丢失任何数值。 */
export function unpackAuditInput(packed: PackedAuditInput): AuditInput {
  return {
    times: Array.from(packed.times),
    pris: Array.from(packed.pris),
    maxMissed: packed.maxMissed,
  };
}

/** 计算线程处理一条审计请求：解包 → 求解 → 组装响应。 */
export function handleAuditRequest(req: AuditRequest): AuditResponse {
  return { id: req.id, outcome: audit(unpackAuditInput(req.input)) };
}
