/**
 * 计划的结构化表示（T-112 Plan Mode / ADR 0010）。
 *
 * 计划固定结构（002 十节扩展点表 + kickoff 0.11.0 三、设计要点 1）：目标 / 涉及
 * 文件 / 分步改动 / 验证方式 / 风险点——自由散文无法验证、无法部分批准，固定结构
 * 才能被程序解析（评测判定）、被部分修改、被落盘重建（T-113）。
 *
 * 依赖方向：本模块零依赖（不 import 其他 core 模块），parse / serialize 是纯函数。
 */

/** 计划五段结构的键。 */
export type PlanSectionKey =
  'goal' | 'files' | 'steps' | 'verification' | 'risks';

/** 结构化计划（ADR 0010：固定五段）。 */
export interface StructuredPlan {
  /** 目标：这次改动要达成的结果（一句话）。 */
  readonly goal: string;
  /** 涉及文件：将改动 / 新增 / 移除的文件路径清单。 */
  readonly files: readonly string[];
  /** 分步改动：按顺序执行的改动步骤（每一步可独立验证）。 */
  readonly steps: readonly string[];
  /** 验证方式：改完后如何确认正确（测试 / 构建 / 手动核对）。 */
  readonly verification: readonly string[];
  /** 风险点：实现过程中可能踩的坑与规避。 */
  readonly risks: readonly string[];
}

/** 五段的中文小节标题（serialize 输出 / parse 匹配；支持中文与英文别名）。 */
export const PLAN_SECTION_TITLES: Readonly<Record<PlanSectionKey, string>> = {
  goal: '目标',
  files: '涉及文件',
  steps: '分步改动',
  verification: '验证方式',
  risks: '风险点',
};

/** 五段的中文标题列表（serialize 输出顺序；也是 /help 与 notice 的说明数据源）。 */
export const PLAN_SECTION_KEYS: readonly PlanSectionKey[] = [
  'goal',
  'files',
  'steps',
  'verification',
  'risks',
];

/** markdown 解析时的标题别名 → 段键（中文 + 英文，忽略大小写）。 */
const SECTION_ALIASES: Readonly<Record<string, PlanSectionKey>> = {
  目标: 'goal',
  goal: 'goal',
  涉及文件: 'files',
  files: 'files',
  涉及文件清单: 'files',
  分步改动: 'steps',
  steps: 'steps',
  步骤: 'steps',
  验证方式: 'verification',
  verification: 'verification',
  验证: 'verification',
  风险点: 'risks',
  risks: 'risks',
  风险: 'risks',
};

/**
 * 解析模型产出的计划文本为 `StructuredPlan`；解析失败返回 null。
 *
 * 容错策略（模型输出不可信）：
 * 1. 先尝试 JSON（剥 markdown 围栏后 `JSON.parse`）：对象含 goal 字符串即规范化；
 * 2. 再按 markdown 小节解析：`## 目标` 一类标题（中文 / 英文别名）分段，标题下
 *    逐行收集（剥行首 `- ` / `* ` / `数字.`），goal 取首行非空文本；段缺失填空数组；
 * 3. 两路都失败返回 null（调用方提示重试）。
 */
export function parseStructuredPlan(text: string): StructuredPlan | null {
  const cleaned = stripCodeFence(text).trim();
  if (cleaned.length === 0) return null;

  const json = tryParseJson(cleaned);
  if (json !== null) return json;

  return tryParseMarkdown(cleaned);
}

/** 剥 markdown 围栏：```json …``` 或 ``` …``` 整体包裹时取内部文本。 */
function stripCodeFence(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)```\s*$/i.exec(text);
  return match === null ? text : match[1];
}

/** JSON 路径：对象含 goal 字符串即接受，数组字段规范化。 */
function tryParseJson(text: string): StructuredPlan | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const source = parsed as Record<string, unknown>;
  if (typeof source.goal !== 'string' || source.goal.trim().length === 0) {
    return null;
  }
  return normalizeFromRecord(source);
}

/** 从 record 规范化出 StructuredPlan（数组字段只保留非空字符串）。 */
function normalizeFromRecord(source: Record<string, unknown>): StructuredPlan {
  const strings = (value: unknown): readonly string[] => {
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is string =>
        typeof entry === 'string' && entry.trim().length > 0,
    );
  };
  return {
    goal:
      typeof source.goal === 'string' && source.goal.trim().length > 0
        ? source.goal.trim()
        : '',
    files: strings(source.files),
    steps: strings(source.steps),
    verification: strings(source.verification),
    risks: strings(source.risks),
  };
}

/** markdown 路径：按小节标题分段收集。 */
function tryParseMarkdown(text: string): StructuredPlan | null {
  // 把文本按行切分，先找到首个小节标题；没有标题则视为不可解析
  const lines = text.split('\n');
  const sections = new Map<PlanSectionKey, string[]>();
  let current: PlanSectionKey | null = null;
  let hasHeading = false;

  for (const raw of lines) {
    const line = raw.trim();
    const heading = parseHeading(line);
    if (heading !== null) {
      hasHeading = true;
      current = heading;
      if (!sections.has(heading)) sections.set(heading, []);
      continue;
    }
    if (current === null) continue; // 首个标题之前的杂讯跳过
    if (line.length === 0) continue;
    const entry = stripListItem(line);
    if (entry.length > 0) sections.get(current)?.push(entry);
  }

  if (!hasHeading) return null;
  const goal = sections.get('goal')?.[0];
  if (goal === undefined || goal.length === 0) return null;

  return {
    goal,
    files: sections.get('files') ?? [],
    steps: sections.get('steps') ?? [],
    verification: sections.get('verification') ?? [],
    risks: sections.get('risks') ?? [],
  };
}

/** 解析一行是否为小节标题（`## 目标` / `## Files`；忽略大小写）。 */
function parseHeading(line: string): PlanSectionKey | null {
  const match = /^#{1,4}\s+(.+)$/.exec(line);
  if (match === null) return null;
  const title = match[1].trim().toLowerCase();
  return SECTION_ALIASES[title] ?? null;
}

/** 剥列表项前缀（`- ` / `* ` / `数字. ` / `数字、`）。 */
function stripListItem(line: string): string {
  return line.replace(/^(?:[-*]\s+|\d+[.)、]\s*)/, '').trim();
}

/** 把结构化计划序列化为 markdown（T-113 落盘 / approve 时回填上下文）。 */
export function serializeStructuredPlan(plan: StructuredPlan): string {
  const lines: string[] = ['# 实施计划', ''];
  for (const key of PLAN_SECTION_KEYS) {
    lines.push(`## ${PLAN_SECTION_TITLES[key]}`);
    lines.push('');
    if (key === 'goal') {
      lines.push(plan.goal);
      lines.push('');
      continue;
    }
    const items = plan[key] as readonly string[];
    if (items.length === 0) {
      lines.push('（无）');
    } else {
      for (const item of items) lines.push(`- ${item}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/** 是否「空计划」：五段全空（用于判定解析出的计划是否有内容）。 */
export function isEmptyPlan(plan: StructuredPlan): boolean {
  return (
    plan.goal.length === 0 &&
    plan.files.length === 0 &&
    plan.steps.length === 0 &&
    plan.verification.length === 0 &&
    plan.risks.length === 0
  );
}
