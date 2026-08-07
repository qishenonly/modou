import type { PermissionRequest } from './policy';
import { normalizeCommand } from './danger';

/**
 * 规则表（T-052，design 002 6.1 / kickoff 0.5.0 3.1）。
 *
 * allow/deny 规则（命令前缀 / 工具名 / 路径前缀匹配），叠加在正交权限矩阵之上。
 * 裁决顺序（002 6.1）：deny 规则 > 危险命令黑名单 > 沙箱范围 > allow 规则 > 审批策略。
 *
 * - deny 规则优先级最高：命中即拒绝——即使 `never` 策略 / autoApprove 也不会
 *   走审批流程（deny 与危险黑名单的区别：黑名单是「强制确认」，deny 规则是
 *   「直接拒绝」）；
 * - allow 规则在第 ④ 步（沙箱范围之后、审批策略之前）：可放行审批策略层
 *   （默认组合下原本要问的写/执行直接放行），但**不能推翻**更优先的 deny 规则、
 *   危险命令黑名单与沙箱范围 / 目录边界。
 *
 * 匹配语义：
 * - 对 bash（exec）用命令前缀匹配：`match: 'git status'` 命中 `git status -s`；
 *   命令侧经 normalizeCommand 归一（折叠空白、剥离 `sudo `，与 danger.ts 同一份
 *   实现），`sudo rm -rf /x` 也命中 `rm -rf`；
 * - 对 write / edit 等带 path 的工具，按「工具名 + path」或「工具名」匹配：
 *   工具名做**整串匹配**（`match: 'write'` 命中全部 write 调用），路径做
 *   **分隔符边界的前缀匹配**（`match: '/repo/src'` 命中 `/repo/src/a.ts`，
 *   不误命中 `/repo/src2`）；
 * - `tool` 限定存在时，先要求 `request.toolName === rule.tool` 才继续匹配
 *   （缺省全工具）。
 *
 * 诚实记录（002 6.3）：shell 命令前缀匹配可被 `bash -c` / `eval` / base64 /
 * `;` 串联绕过——规则表是「防手滑、防模型莽撞」的深度防御一层，不是安全边界；
 * 真正的隔离依赖 1.0.0 的 OS 级沙箱。危险命令黑名单（danger.ts）本版只做内置
 * 固定清单的强制确认，不做可配置扩展——规则表不做可配置持久化（settings 文件
 * 留 0.8.0 配置系统），本版由 CLI `--rule` 简单参数与编程注入（headless / TUI
 * 的 PermissionConfig.rules）提供。
 */

/** 规则效果：allow = 放行审批策略层；deny = 直接拒绝（优先级最高）。 */
export type RuleEffect = 'allow' | 'deny';

/** 规则表条目：命令 / 工具名 / 路径前缀匹配。 */
export interface PermissionRule {
  /** 规则效果：deny 命中直接拒绝；allow 命中放行审批策略层。 */
  readonly effect: RuleEffect;
  /**
   * 匹配前缀（命令 / 工具名 / 路径，见文件头「匹配语义」）。
   * 命令侧按归一化命令书写（折叠空白、去首部 sudo）；空串不参与匹配。
   */
  readonly match: string;
  /** 可选限定工具：缺省全工具；存在时仅当 toolName 精确等于此值才匹配。 */
  readonly tool?: string;
}

/** 候选串及其匹配方式（工具名 = 整串；命令 = 普通前缀；路径 = 分隔符边界前缀）。 */
type CandidateKind = 'exact' | 'command' | 'path';

interface Candidate {
  readonly text: string;
  readonly kind: CandidateKind;
}

/**
 * 从请求提取可匹配的候选串：
 * - 工具名（整串匹配）：`match: 'write'` 命中全部 write 调用；
 * - bash 命令串（命令前缀匹配，normalizeCommand 归一）；
 * - 路径（分隔符边界前缀匹配）：写 / 编辑 / 读取工具的 args.path。
 */
function candidates(request: PermissionRequest): Candidate[] {
  const list: Candidate[] = [];
  if (request.toolName.length > 0) {
    list.push({ text: request.toolName, kind: 'exact' });
  }
  const command = request.args?.command;
  if (typeof command === 'string' && command.trim().length > 0) {
    list.push({ text: normalizeCommand(command), kind: 'command' });
  }
  const path = request.args?.path;
  if (typeof path === 'string' && path.trim().length > 0) {
    list.push({ text: path, kind: 'path' });
  }
  return list;
}

/**
 * 路径前缀判定：命中后下一个字符必须是路径分隔符或串尾。
 * 防 `match: '/repo'` 误命中 `/repo2`（与 paths.ts isWithinRoot 同款边界语义）。
 */
function isPathPrefix(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false;
  if (!haystack.startsWith(needle)) return false;
  const next = haystack[needle.length];
  return next === undefined || next === '/' || next === '\\';
}

/**
 * 单条规则是否命中请求：tool 限定（存在时须精确等于工具名）+ match 是任一
 * 候选串的匹配前缀。空 match（归一后为空）恒不命中；effect 由调用方按
 * 裁决顺序区分，此处不校验。
 */
export function ruleMatches(
  rule: PermissionRule,
  request: PermissionRequest,
): boolean {
  if (rule.tool !== undefined && rule.tool !== request.toolName) return false;
  const match = normalizeCommand(rule.match);
  if (match.length === 0) return false;
  return candidates(request).some((candidate) => {
    switch (candidate.kind) {
      case 'exact':
        return candidate.text === match;
      case 'command':
        return candidate.text.startsWith(match);
      case 'path':
        return isPathPrefix(candidate.text, match);
    }
  });
}

/**
 * 按效果在规则表中找命中（供 policy.ts 裁决顺序 ① deny / ④ allow 调用）。
 * 防御性跳过非法条目（未知 effect 天然不参与——`rule.effect === effect` 恒 false）。
 */
export function matchRule(
  request: PermissionRequest,
  rules: readonly PermissionRule[] | undefined,
  effect: RuleEffect,
): boolean {
  if (rules === undefined) return false;
  return rules.some(
    (rule) => rule.effect === effect && ruleMatches(rule, request),
  );
}
