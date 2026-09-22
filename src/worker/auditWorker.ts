import { audit } from '../solver/solve';
import type { AuditOutcome, PackedAuditInput } from '../solver/types';

/**
 * 审计计算在 Worker 中执行，保证计算期间页面仍可操作。
 * 主线程在发起新审计时会终止旧 Worker，因此旧结果不会覆盖新审计。
 */

export interface AuditRequest {
  id: number;
  input: PackedAuditInput;
}

export interface AuditResponse {
  id: number;
  outcome: AuditOutcome;
}

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<AuditRequest>) => void) | null;
  postMessage: (message: AuditResponse) => void;
};

scope.onmessage = (ev) => {
  const { id, input } = ev.data;
  const outcome = audit({
    times: Array.from(input.times),
    pris: Array.from(input.pris),
    maxMissed: input.maxMissed,
  });
  scope.postMessage({ id, outcome });
};
