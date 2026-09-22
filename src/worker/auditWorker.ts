import {
  handleAuditRequest,
  type AuditRequest,
  type AuditResponse,
} from './protocol';

/**
 * 审计计算在 Worker 中执行，保证计算期间页面仍可操作。
 * 主线程在发起新审计时会终止旧 Worker，因此旧结果不会覆盖新审计。
 * 消息协议（打包 / 解包 / 请求处理）见 ./protocol，
 * 与页面及验收测试共用同一实现。
 */

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<AuditRequest>) => void) | null;
  postMessage: (message: AuditResponse) => void;
};

scope.onmessage = (ev) => {
  scope.postMessage(handleAuditRequest(ev.data));
};
