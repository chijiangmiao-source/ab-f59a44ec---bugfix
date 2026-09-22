import type { AuditInput, AuditOutcome, PackedAuditInput } from '../solver/types';

/**
 * 页面与后台计算线程之间的消息协议。
 *
 * 打包/解包是唯一经过 postMessage 结构化克隆的环节：
 * 时刻与重频均为安全整数（可达 2^53 − 1），Float64Array 能精确承载，
 * 且其 buffer 可作为转移对象（transferable）避免拷贝。
 */

/** 主线程 → Worker 的审计请求。 */
export interface AuditRequest {
  id: number;
  input: PackedAuditInput;
}

/** Worker → 主线程的审计响应。 */
export interface AuditResponse {
  id: number;
  outcome: AuditOutcome;
}

/** 页面侧打包：把校验后的审计输入转为可转移的打包形式，数值原样保留。 */
export function packAuditInput(input: AuditInput): PackedAuditInput {
  return {
    times: Float64Array.from(input.times),
    pris: Float64Array.from(input.pris),
    maxMissed: input.maxMissed,
  };
}

/** 打包输入对应的转移对象列表（postMessage 第二个参数）。 */
export function packTransferables(packed: PackedAuditInput): Transferable[] {
  return [packed.times.buffer, packed.pris.buffer];
}

/** Worker 侧解包：还原为普通数组供求解器使用，数值与打包前完全一致。 */
export function unpackAuditInput(packed: PackedAuditInput): AuditInput {
  return {
    times: Array.from(packed.times),
    pris: Array.from(packed.pris),
    maxMissed: packed.maxMissed,
  };
}
