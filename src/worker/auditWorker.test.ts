import { describe, expect, it, vi } from 'vitest';
import { audit, missedPositions, sequenceMissed } from '../solver/solve';
import type { AuditInput } from '../solver/types';
import {
  packAuditInput,
  unpackAuditInput,
  type AuditRequest,
  type AuditResponse,
} from './protocol';

/**
 * 消息路径验收：页面打包 → postMessage（结构化克隆）→ Worker 求解 → 响应回传。
 * 通过桩掉的 self 加载真实 worker 模块，请求与响应都经过结构化克隆，
 * 与浏览器中 postMessage 的语义一致。
 */

/** 验收用例：两部雷达各发三次，重频 4328521727 µs（> 2^32，但在安全整数范围内）。 */
const PRI = 4328521727;
const BIG_INPUT: AuditInput = {
  times: [0, 100, PRI, PRI + 100, 2 * PRI, 2 * PRI + 100],
  pris: [PRI],
  maxMissed: 0,
};

interface WorkerScope {
  onmessage: ((ev: MessageEvent<AuditRequest>) => void) | null;
  postMessage: (message: AuditResponse) => void;
}

/** 加载真实 worker 模块并完成一次“页面 → 后台线程 → 页面”往返。 */
async function runWorkerRoundTrip(
  input: AuditInput,
): Promise<{ request: AuditRequest; response: AuditResponse }> {
  vi.resetModules();
  const responses: AuditResponse[] = [];
  const scope: WorkerScope = {
    onmessage: null,
    postMessage: (message) => {
      responses.push(message);
    },
  };
  vi.stubGlobal('self', scope);
  try {
    await import('./auditWorker');
  } finally {
    vi.unstubAllGlobals();
  }
  expect(typeof scope.onmessage).toBe('function');

  // 与 App.tsx 相同：packAuditInput 打包后由 postMessage 结构化克隆送达 worker
  const request = structuredClone({
    id: 1,
    input: packAuditInput(input),
  }) as AuditRequest;
  scope.onmessage!({ data: request } as MessageEvent<AuditRequest>);

  expect(responses).toHaveLength(1);
  // 响应同样经结构化克隆回到主线程
  const response = structuredClone(responses[0]) as AuditResponse;
  return { request, response };
}

describe('审计消息路径（页面 ↔ 后台计算线程）', () => {
  it('大重频与对应时刻在往返后保持精确', async () => {
    const { request, response } = await runWorkerRoundTrip(BIG_INPUT);

    // 请求侧：打包 + 结构化克隆后，worker 收到的输入与页面提交完全一致
    expect(unpackAuditInput(request.input)).toEqual(BIG_INPUT);

    // 响应侧：结果摘要
    expect(response.id).toBe(1);
    const { outcome } = response;
    expect(outcome.kind).toBe('solved');
    if (outcome.kind !== 'solved') return;
    expect(outcome.sequenceCount).toBe(2);
    expect(outcome.totalMissed).toBe(0);
    expect(outcome.hasMultiple).toBe(false);

    // 规范解：重频原样为 4328521727，零基下标 0/2/4 与 1/3/5 各成一条序列
    expect(outcome.sequences).toEqual([
      { pri: PRI, members: [0, 2, 4] },
      { pri: PRI, members: [1, 3, 5] },
    ]);
  });

  it('结果摘要、规范解明细、时间轴与导出数据相互一致', async () => {
    const { response } = await runWorkerRoundTrip(BIG_INPUT);
    const { outcome } = response;
    expect(outcome.kind).toBe('solved');
    if (outcome.kind !== 'solved') return;

    // 规范解明细复算（与结果视图同一实现）：各序列漏发数均为 0，合计等于摘要
    const perSequence = outcome.sequences.map((s) =>
      sequenceMissed(BIG_INPUT.times, s),
    );
    expect(perSequence).toEqual([0, 0]);
    expect(perSequence.reduce((a, b) => a + b, 0)).toBe(outcome.totalMissed);

    // 时间轴：不应出现任何漏发标记
    for (const seq of outcome.sequences) {
      expect(missedPositions(BIG_INPUT.times, seq)).toEqual([]);
    }

    // 导出数据：JSON 序列化/解析后数值精确，可离线重算出相同结论
    const exported = JSON.parse(
      JSON.stringify({ tool: 'radar-pulse-audit', input: BIG_INPUT, outcome }),
    ) as { input: AuditInput; outcome: typeof outcome };
    expect(exported.input).toEqual(BIG_INPUT);
    expect(exported.outcome.sequences.map((s) => s.pri)).toEqual([PRI, PRI]);
    expect(
      exported.outcome.sequences.map((s) =>
        sequenceMissed(exported.input.times, s),
      ),
    ).toEqual([0, 0]);
    expect(exported.outcome.totalMissed).toBe(0);
  });

  it('常规小整数输入的往返结果与直接求解一致', async () => {
    const small: AuditInput = {
      times: [0, 40, 100, 200, 290, 300, 400, 500, 540],
      pris: [100, 250],
      maxMissed: 0,
    };
    const { request, response } = await runWorkerRoundTrip(small);
    expect(unpackAuditInput(request.input)).toEqual(small);
    expect(response.outcome).toEqual(audit(small));
  });
});
