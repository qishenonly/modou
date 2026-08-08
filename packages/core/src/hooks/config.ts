/**
 * 钩子装配（T-143）：settings.json 的 hooks 配置 → HookBus。
 *
 * 把 config 层的 `ConfigHooks`（settings.json hooks 键，纯 zod 结构）翻译成
 * 总线可运行的外部进程钩子：每个条目 = `processHook(HookProcessSpec)`（JSON
 * stdin/stdout + 超时 + failBehavior 降级 + 执行日志），按钩子点 + 工具匹配器
 * 注册进 HookBus。注册 ID 取 `config-<point>-<序号>`（配置确定性 → 日志稳定
 * 可回溯）。
 *
 * 依赖方向：hooks 模块 import config 类型（config 不 import hooks，无环）。
 * 装配职责在 hooks 侧而非 config 侧——config 保持「纯结构解析」，总线 / 进程
 * 语义归 hooks。
 */

import type { ConfigHooks, ConfigHookEntry } from '../config/settings';
import { HookBus } from './bus';
import type { HookPoint } from './types';
import { processHook, type HookProcessSpec } from './executor';
import type { HookExecutionLog } from './log';

/** hooksFromSettings 的装配选项。 */
export interface BuildHooksOptions {
  /** 执行日志（每次进程钩子执行落 JSONL；缺省不记录）。 */
  readonly log?: HookExecutionLog;
  /** 默认工作目录（缺省 process.cwd()；钩子进程 spawn 的 cwd）。 */
  readonly cwd?: string;
}

/** 单个配置条目 → 进程钩子规格（结构同形，透传可选字段）。 */
function toProcessSpec(entry: ConfigHookEntry): HookProcessSpec {
  return {
    command: entry.command,
    ...(entry.args !== undefined ? { args: entry.args } : {}),
    ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
    ...(entry.failBehavior !== undefined
      ? { failBehavior: entry.failBehavior }
      : {}),
    ...(entry.env !== undefined ? { env: entry.env } : {}),
  };
}

/**
 * 把 settings.json 的 hooks 配置装配成 HookBus（外部进程钩子）。
 * 配置缺省 / 全空点 = 不挂钩子（返回 undefined，管线直通）。
 */
export function hooksFromSettings(
  hooks: ConfigHooks | undefined,
  options: BuildHooksOptions = {},
): HookBus | undefined {
  if (hooks === undefined) return undefined;
  const bus = new HookBus();

  const registerPoint = (
    point: HookPoint,
    entries: readonly ConfigHookEntry[] | undefined,
  ): void => {
    if (entries === undefined || entries.length === 0) return;
    entries.forEach((entry, index) => {
      const id = `config-${point}-${index + 1}`;
      bus.register(
        point,
        processHook(toProcessSpec(entry), {
          hookId: id,
          ...(options.log !== undefined ? { log: options.log } : {}),
          ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        }),
        {
          id,
          ...(entry.matcher !== undefined ? { matcher: entry.matcher } : {}),
        },
      );
    });
  };

  registerPoint('SessionStart', hooks.SessionStart);
  registerPoint('UserPromptSubmit', hooks.UserPromptSubmit);
  registerPoint('PreToolUse', hooks.PreToolUse);
  registerPoint('PostToolUse', hooks.PostToolUse);

  return bus.list().length > 0 ? bus : undefined;
}
