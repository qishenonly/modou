import type { WriteConflictReport } from './types';

/**
 * 写冲突检测（T-123，ADR 0011）：追踪「哪个 agent 写过哪个文件」，检测同一文件
 * 被多个 agent（主代理 / 并行子代理）写入的冲突。
 *
 * 0.12.0 的并发解法是「**子代理默认只读、写入串行交主代理**」（ADR 0011）——
 * 本检测器是这层约束的安全网：父代理显式放行写工具给子代理、或子代理间并发
 * 写同一文件时，跨 agent 的同文件写入被标记冲突，经 onFileWrite 回调以 notice
 * 告知用户 / 前端（改动可能互相覆盖，需人工核对）。
 *
 * 覆盖范围：write / edit 工具的成功写入（工具自报路径，ctx.onFileWrite）。
 * **bash 命令文本里的写入不做静态解析**（002 6.3 诚实记录：shell 可 `;` 串联、
 * `eval`、变量展开，字符串匹配挡不住绕过）——不在本检测范围，1.0.0 的 OS 级
 * 沙箱才承担真实隔离。
 *
 * 线程模型：单线程事件循环内的纯内存结构，记录写操作是同步的，天然原子。
 */

/** 一次写入事件（谁、何时、写了哪个文件）。 */
export interface FileWriteEvent {
  readonly path: string;
  readonly agent: string;
  readonly at: number;
}

/** 默认时钟：Date.now（测试可注入假时钟）。 */
const DEFAULT_NOW = (): number => Date.now();

/** 写冲突检测器：按文件路径记录最近一次写入，检出跨 agent 覆盖。 */
export class WriteConflictDetector {
  private readonly writes = new Map<string, FileWriteEvent>();
  private readonly now: () => number;

  constructor(now: () => number = DEFAULT_NOW) {
    this.now = now;
  }

  /**
   * 记录一次成功写入，返回冲突报告或 undefined：
   * - 该路径此前无写入 → 记录，无冲突；
   * - 该路径此前由**同一 agent** 写入（连续写）→ 覆盖记录，无冲突；
   * - 该路径此前由**另一 agent** 写入 → 记录并返回冲突（改动可能互相覆盖）。
   */
  recordWrite(path: string, agent: string): WriteConflictReport | undefined {
    const existing = this.writes.get(path);
    const event: FileWriteEvent = { path, agent, at: this.now() };
    this.writes.set(path, event);
    if (existing === undefined || existing.agent === agent) return undefined;
    return {
      path,
      agent,
      existingAgent: existing.agent,
      existingAt: existing.at,
    };
  }

  /** 某 agent 写过的文件清单（按写入时间升序；测试 / payload 用）。 */
  writesBy(agent: string): readonly FileWriteEvent[] {
    return [...this.writes.values()]
      .filter((w) => w.agent === agent)
      .sort((a, b) => a.at - b.at);
  }

  /** 全部写入记录（测试 / 调试用）。 */
  allWrites(): readonly FileWriteEvent[] {
    return [...this.writes.values()].sort((a, b) => a.at - b.at);
  }

  /** 已追踪的不同文件数。 */
  get size(): number {
    return this.writes.size;
  }
}

/**
 * 便捷装配：把检测器适配成 RunAgentTurnInput.onFileWrite 需要的
 * `(path, agent) => WriteConflictReport | undefined` 钩子。
 */
export function toOnFileWrite(
  detector: WriteConflictDetector,
): (path: string, agent: string) => WriteConflictReport | undefined {
  return (path, agent) => detector.recordWrite(path, agent);
}
