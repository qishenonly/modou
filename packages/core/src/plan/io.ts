/**
 * 计划文档化（T-113）：计划落盘 markdown、从文件/会话日志重建、手动编辑后执行。
 *
 * - `savePlanToFile`：把结构化计划序列化为 markdown 写入 `.modou/plans/<name>.md`
 *   （缺省目录 `<projectRoot>/.modou/plans`，缺省文件名 epoch ms）。落盘后用户
 *   可手动编辑该文件（调整步骤 / 增加验证方式），再用 `loadPlanFromFile` 读回；
 * - `loadPlanFromFile`：读文件 + `parseStructuredPlan` 解析（JSON 或 markdown 均
 *   接受）——「手动编辑后再执行」的读回路径；
 * - `rebuildStructuredPlan`：从会话日志的 `plan` 条目重建最近一次计划（/resume
 *   后计划仍在——002 4.1「日志是唯一真相」，计划作为结构化状态入日志）。
 *
 * 依赖方向：本模块依赖 session（SessionRecord 类型）与 plan/plan.ts（结构 /
 * 解析 / 序列化），不感知 runtime / TUI。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionRecord } from '../session/log';
import {
  parseStructuredPlan,
  serializeStructuredPlan,
  type StructuredPlan,
} from './plan';

/** 计划文件目录名（`.modou/plans`）。 */
export const PLANS_DIR_NAME = 'plans';

/** 缺省计划目录：`<projectRoot>/.modou/plans`。 */
export function defaultPlansDir(projectRoot: string): string {
  return join(projectRoot, '.modou', PLANS_DIR_NAME);
}

/** savePlanToFile 的选项。 */
export interface SavePlanOptions {
  /** 文件名（不含扩展名；缺省 = epoch ms 时间戳）。 */
  readonly name?: string;
  /** 计划目录覆盖（缺省 `<projectRoot>/.modou/plans`）。 */
  readonly dir?: string;
  /** 时钟注入口（测试用；缺省 Date.now）。 */
  readonly now?: () => number;
}

/**
 * 把结构化计划序列化为 markdown 落盘，返回写入的文件绝对路径。
 * 目录递归创建；文件名含非法字符时由调用方负责（TUI 只用时间戳）。
 */
export async function savePlanToFile(
  projectRoot: string,
  plan: StructuredPlan,
  options: SavePlanOptions = {},
): Promise<string> {
  const dir = options.dir ?? defaultPlansDir(projectRoot);
  await mkdir(dir, { recursive: true });
  const name = options.name ?? String((options.now ?? Date.now)());
  const path = join(dir, `${name}.md`);
  await writeFile(path, serializeStructuredPlan(plan), 'utf8');
  return path;
}

/**
 * 从文件读取并解析计划（手动编辑后再执行：用户编辑 `.modou/plans/*.md` 后，
 * 读回结构化计划）。文件不存在 / 解析失败返回 null（调用方提示）。
 */
export async function loadPlanFromFile(
  filePath: string,
): Promise<StructuredPlan | null> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  return parseStructuredPlan(text);
}

/**
 * 从会话日志重建最近一次计划：取**最后一条** `plan` 条目（结构化计划序列化
 * 文本），解析成功即返回。没有任何 plan 条目 / 解析失败返回 undefined。
 * /resume 后据此恢复「计划仍在」（002 4.1：日志是唯一真相）。
 */
export function rebuildStructuredPlan(
  records: readonly SessionRecord[],
): StructuredPlan | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.kind !== 'plan') continue;
    const parsed = parseStructuredPlan(record.data.text);
    if (parsed !== null) return parsed;
  }
  return undefined;
}
