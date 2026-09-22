/**
 * 完整消息路径验收：页面提交 → 后台计算线程 → 结果返回。
 *
 * 覆盖路径与页面真实流程一致：
 *   parseDraft（输入校验）
 *   → packAuditInput / packTransferables（App 发起审计时的打包）
 *   → structuredClone（模拟 postMessage 在线程间的结构化克隆传输）
 *   → 真实 auditWorker 模块的 onmessage → handleAuditRequest → audit
 *   → structuredClone（模拟响应回传）
 *   → 结果摘要 / 规范解明细 / 时间轴 / 导出数据一致性核对。
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseDraft, type Draft } from '../solver/validate';
import { audit } from '../solver/solve';
import type { AuditInput, SolvedOutcome } from '../solver/types';
import { ResultView } from '../components/ResultView';
import {
  packAuditInput,
  packTransferables,
  unpackAuditInput,
  type AuditRequest,
  type AuditResponse,
} from './protocol';

/* -------- 以假 self 加载真实 Worker 模块，捕获其 postMessage -------- */

const posted: AuditResponse[] = [];
const fakeScope = {
  onmessage: null as null | ((ev: { data: AuditRequest }) => void),
  postMessage: (message: AuditResponse) => {
    posted.push(message);
  },
};
(globalThis as Record<string, unknown>).self = fakeScope;
// 模块级副作用：注册 onmessage，必须在 self 就位之后导入
const workerReady: Promise<unknown> = import('./auditWorker');

/** 把请求交给真实 worker 模块处理，返回其回发的响应。 */
async function runWorker(req: AuditRequest): Promise<AuditResponse> {
  await workerReady;
  if (!fakeScope.onmessage) throw new Error('auditWorker 未注册 onmessage');
  posted.length = 0;
  fakeScope.onmessage({ data: req });
  if (posted.length !== 1) {
    throw new Error(`worker 应回发 1 条响应，实际 ${posted.length} 条`);
  }
  return posted[0];
}

/** 模拟页面上的一次完整审计：校验 → 打包 → 传输 → worker 求解 → 响应回传。 */
async function auditThroughWorker(draft: Draft, id = 1) {
  const parsed = parseDraft(draft);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.errors.join('；'));
  const pageInput = parsed.input;

  // 页面侧打包（App 使用的同一实现），structuredClone 模拟 postMessage 传输
  const packed = packAuditInput(pageInput);
  const transfer = packTransferables(packed);
  expect(transfer).toEqual([packed.times.buffer, packed.pris.buffer]);
  const wireReq = structuredClone({ id, input: packed } satisfies AuditRequest);

  // 计算线程：真实 worker 模块解包并求解；响应再经结构化克隆回到主线程
  const wireResp = structuredClone(await runWorker(wireReq));
  return { pageInput, wireReq, wireResp };
}

/* -------- 验收用例：大重频与大时刻（均为安全整数） -------- */

const BIG_DRAFT: Draft = {
  timesText: '0 100 4328521727 4328521827 8657043454 8657043554',
  prisText: '4328521727',
  maxMissed: 0,
};
const BIG_TIMES = [0, 100, 4328521727, 4328521827, 8657043454, 8657043554];
const BIG_PRI = 4328521727;

describe('完整消息路径：页面 → 计算线程 → 页面', () => {
  it('大重频与大时刻在往返后保持精确，摘要 / 明细 / 时间轴 / 导出一致', async () => {
    const { pageInput, wireReq, wireResp } = await auditThroughWorker(BIG_DRAFT);

    // —— 传输精确性：打包后仍是 Float64Array，解包与原输入逐项一致 ——
    expect(wireReq.input.times).toBeInstanceOf(Float64Array);
    expect(wireReq.input.pris).toBeInstanceOf(Float64Array);
    expect(unpackAuditInput(wireReq.input)).toEqual(pageInput);
    expect(unpackAuditInput(wireReq.input).times).toEqual(BIG_TIMES);
    expect(unpackAuditInput(wireReq.input).pris).toEqual([BIG_PRI]);

    // —— 响应：唯一分组，两条序列，重频保持 4328521727，零漏发 ——
    expect(wireResp.id).toBe(1);
    const outcome = wireResp.outcome;
    expect(outcome.kind).toBe('solved');
    if (outcome.kind !== 'solved') return;
    expect(outcome.sequenceCount).toBe(2);
    expect(outcome.totalMissed).toBe(0);
    expect(outcome.hasMultiple).toBe(false);
    expect(outcome.sequences).toEqual([
      { pri: BIG_PRI, members: [0, 2, 4] },
      { pri: BIG_PRI, members: [1, 3, 5] },
    ]);

    // —— 摘要与规范解明细可相互复核：按回显输入复算漏发数均为整数 0 ——
    expect(outcome.sequences.length).toBe(outcome.sequenceCount);
    let missedSum = 0;
    for (const seq of outcome.sequences) {
      let missed = 0;
      for (let k = 1; k < seq.members.length; k++) {
        const gap = pageInput.times[seq.members[k]] - pageInput.times[seq.members[k - 1]];
        missed += gap / seq.pri - 1;
      }
      expect(Number.isInteger(missed)).toBe(true);
      expect(missed).toBe(0);
      missedSum += missed;
    }
    expect(missedSum).toBe(outcome.totalMissed);

    // —— 渲染一致性：摘要卡片、规范解明细表、时间轴（无漏发标记）、输入回显 ——
    const html = renderToStaticMarkup(
      <ResultView input={pageInput} outcome={outcome} elapsedMs={1.2} />,
    );
    // 输入回显：大数值原样展示
    expect(html).toContain(BIG_TIMES.join(' '));
    expect(html).toContain(`<code>${BIG_PRI}</code>`);
    // 摘要卡片：序列数 2、漏发总数 0、无多解
    const cardValues = [...html.matchAll(/card-value">([^<]+)</g)].map((m) => m[1]);
    expect(cardValues).toEqual(['2', '0', '否']);
    // 规范解明细：两条序列重频均为 4328521727，漏发数均为 0
    expect(html.match(/<td>4328521727<\/td>/g)).toHaveLength(2);
    expect(html).toContain('0 → 2 → 4');
    expect(html).toContain('1 → 3 → 5');
    expect(html).toContain('0 → 4328521727 → 8657043454');
    expect(html.match(/<td>0<\/td>/g)).toHaveLength(2);
    // 时间轴：每条泳道标注真实重频且无漏发，不出现任何漏发标记
    expect(html.match(/>重频 4328521727 µs</g)).toHaveLength(2);
    expect(html.match(/>无漏发</g)).toHaveLength(2);
    expect(html).not.toContain('漏发位置 · 期望时刻'); // 漏发标记的 title；图例文字不算
    // 被截断的错误重频不得出现在页面任何位置
    expect(html).not.toContain('33554431');

    // —— 导出数据：与结果同源，JSON 往返后数值仍精确 ——
    const exportData = { tool: 'radar-pulse-audit', input: pageInput, outcome };
    const restored = JSON.parse(JSON.stringify(exportData)) as typeof exportData;
    expect(restored).toEqual(exportData);
    expect(restored.input.times).toEqual(BIG_TIMES);
    expect(restored.input.pris).toEqual([BIG_PRI]);
    expect((restored.outcome as SolvedOutcome).sequences).toEqual([
      { pri: BIG_PRI, members: [0, 2, 4] },
      { pri: BIG_PRI, members: [1, 3, 5] },
    ]);
  });

  it('常规小整数输入经消息路径求解与直接求解一致（无回归）', async () => {
    const draft: Draft = {
      timesText: '0 15 25 40 100 110',
      prisText: '10 25 40',
      maxMissed: 2,
    };
    const { pageInput, wireResp } = await auditThroughWorker(draft, 7);
    expect(wireResp.id).toBe(7);
    // 与求解器直接调用结果完全一致
    const direct = audit(pageInput as AuditInput);
    expect(wireResp.outcome).toEqual(direct);
    expect(wireResp.outcome.kind).toBe('solved');
    if (wireResp.outcome.kind !== 'solved') return;
    expect(wireResp.outcome.sequenceCount).toBe(3);
    expect(wireResp.outcome.totalMissed).toBe(0);
    expect(wireResp.outcome.hasMultiple).toBe(true);
    expect(wireResp.outcome.sequences).toEqual([
      { pri: 25, members: [0, 2] },
      { pri: 25, members: [1, 3] },
      { pri: 10, members: [4, 5] },
    ]);
  });
});
