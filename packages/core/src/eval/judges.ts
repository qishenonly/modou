import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvalTask, JudgeContext, JudgeResult } from './types';

/**
 * 评测判定原语（judge 的积木）。三类任务的判定方式：
 * - 修 bug：`runBunTest` 运行对应测试文件断言通过（退出码 0）；
 * - 加功能：`fileContains` grep 断言导出存在 + `runProbeTest` 探针测试断言行为；
 * - 读代码答问：`fileContains` 之外直接对 `ctx.text` 做关键词 / 结构断言。
 *
 * 全部判定在 **临时目录的 fixture 副本** 上进行，仓库原地文件不受影响。
 */

/** 一次子进程运行的结果。 */
export interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * 在给定目录执行一条命令，收集 stdout / stderr 与退出码。
 * 判定原语之一：运行脚本断言输出（spawn 失败时 exitCode 为 null、错误进 stderr）。
 */
export function runCommand(
  dir: string,
  command: string,
  args: readonly string[] = [],
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(command, [...args], { cwd: dir });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      resolve({ exitCode: null, stdout, stderr: error.message });
    });
    child.on('close', (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}

/**
 * 运行 `bun test <testPath>` 并断言通过（退出码 0）。
 * 修 bug 类任务的判定器；失败时把 bun 输出尾部带进 reason，便于调试。
 */
export async function runBunTest(
  dir: string,
  testPath: string,
): Promise<JudgeResult> {
  const { exitCode, stdout, stderr } = await runCommand(dir, 'bun', [
    'test',
    testPath,
  ]);
  const detail = exitCode === 0 ? '' : `\n${(stdout + stderr).slice(-600)}`;
  return {
    pass: exitCode === 0,
    reason: `bun test ${testPath} 退出码 ${exitCode ?? 'spawn失败'}${detail}`,
  };
}

/** 读 fixture 副本内的一个文件（相对工作目录）。 */
export async function readFixtureFile(
  dir: string,
  relativePath: string,
): Promise<string> {
  return readFile(join(dir, relativePath), 'utf8');
}

/**
 * 文件内容断言：目标文件存在且匹配给定正则。
 * 加功能类任务的判定器之一：先 grep 断言导出存在，再跑行为探针。
 */
export async function fileContains(
  dir: string,
  relativePath: string,
  pattern: RegExp,
): Promise<JudgeResult> {
  const content = await readFixtureFile(dir, relativePath).catch(
    () => undefined,
  );
  if (content === undefined) {
    return { pass: false, reason: `缺少文件：${relativePath}` };
  }
  const matched = pattern.test(content);
  return {
    pass: matched,
    reason: matched
      ? `${relativePath} 匹配 ${pattern}`
      : `${relativePath} 未匹配 ${pattern}`,
  };
}

/**
 * 运行一个临时探针测试（加功能类任务的判定器）：
 * 把探针写入 `<dir>/tests/_judge.<taskId>.test.ts`，用 bun test 运行它，跑完删除。
 * 探针内容由任务定义提供，通常 import 目标模块并断言其行为——模型没实现该函数时
 * import 即失败、测试即红，判定 pass=false。
 */
export async function runProbeTest(
  dir: string,
  taskId: string,
  probeSource: string,
): Promise<JudgeResult> {
  const probePath = join('tests', `_judge.${taskId}.test.ts`);
  const absolutePath = join(dir, probePath);
  writeFileSync(absolutePath, probeSource, 'utf8');
  try {
    return await runBunTest(dir, probePath);
  } finally {
    rmSync(absolutePath, { force: true });
  }
}

/** 对 judge 的封装：失败时把任务 id 带进 reason，便于跨任务聚合定位。 */
export async function judgeTask(
  task: EvalTask,
  ctx: JudgeContext,
): Promise<JudgeResult> {
  const result = await task.judge(ctx);
  return result.pass
    ? result
    : { pass: false, reason: `${task.id}: ${result.reason}` };
}
