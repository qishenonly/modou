import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SKILL.md 解析（design 002 §10 扩展点表「Skills = Config 发现 + Context 投影」，
 * 0.15.0 T-150）：严格遵循 Agent Skills 开放标准（skills.sh）的 SKILL.md 格式。
 *
 * 标准要点（skills.sh / Claude Code 实现口径）：
 * - 一个技能 = 一个目录，内含 SKILL.md（正文）+ 可选附带文件（scripts/ 等）；
 * - SKILL.md 开头是 YAML frontmatter（`---` 行分隔），字段：name / description /
 *   allowed-tools（标准用连字符，本模块同时接受 allowedTools 别名）/ license /
 *   compatibility / metadata 等；标准字段除 description 外皆可选；
 * - 正文 = frontmatter 之后的 markdown，加载时整体注入上下文（T-152 渐进式披露）；
 * - 不发明私有格式：不引入任何 modou 专有 frontmatter 字段——第三方 skill
 *   无需改造即可解析（0.15.0 验收门 G-0.15.0「从 skills.sh 拿一个未改造的
 *   第三方 skill 放进目录即可生效」）。
 *
 * 实现说明：
 * - 不引入 YAML 依赖，用最小子集解析器覆盖标准 frontmatter 的真实使用面：
 *   单行标量（name / description）、块状列表（`allowed-tools:` 换行 `- item`）、
 *   流式列表（`[a, b]`）与空格分隔字符串（`Read Grep`）；其余字段（license 等）
 *   忽略——它们不影响 modou 的加载行为；
 * - 缺字段容错：name 缺失回落目录名（调用方传 fallbackName）、description 缺失
 *   记为 ''、frontmatter 缺失 / 无闭合分隔符时整份内容视为正文——技能仍可被
 *   发现与加载，只是清单描述为空；
 * - 附带文件清单（listSkillFiles）：递归列出技能目录下除 SKILL.md 外的全部文件
 *   （相对路径、排序稳定、跳过隐藏文件），供 Skill 工具注入正文时一并告知模型。
 *
 * 模块依赖约束（002 2.2）：skills 属于 Config 扩展点，只依赖 node 内建
 * （fs / path），不 import 任何 core 符号。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** SKILL.md frontmatter 的解析结果（缺省未填的字段为 undefined）。 */
export interface SkillFrontmatter {
  /** 技能名（标准可选字段；缺失时由调用方回落目录名）。 */
  readonly name?: string;
  /** 技能描述（标准推荐字段；进清单供模型判断何时使用）。 */
  readonly description?: string;
  /**
   * 技能声明的工具白名单（标准 allowed-tools；解析后按原样暴露，注入正文时
   * 一并告知模型——加载技能后应只在声明的工具范围内操作）。
   */
  readonly allowedTools?: readonly string[];
}

/** 一份 SKILL.md 的解析产物：frontmatter 元数据 + 正文。 */
export interface ParsedSkill {
  /** 技能名：frontmatter.name 或回落名（发现时 = 目录名）。 */
  readonly name: string;
  /** 技能描述（缺失为空字符串）。 */
  readonly description: string;
  /** 声明的工具白名单（未声明为空数组）。 */
  readonly allowedTools: readonly string[];
  /** 正文（frontmatter 之后的 markdown，trim 后）。 */
  readonly body: string;
  /** 原始 frontmatter 解析结果（缺省字段保持 undefined）。 */
  readonly frontmatter: SkillFrontmatter;
}

/** 进上下文清单的摘要（T-152 渐进式披露：只含 name + description，正文不常驻）。 */
export interface SkillSummary {
  readonly name: string;
  readonly description: string;
}

// ---------------------------------------------------------------------------
// frontmatter 解析（最小 YAML 子集）
// ---------------------------------------------------------------------------

/** frontmatter 分隔行：首行与末行都必须恰为 `---`。 */
const FRONTMATTER_DELIMITER = '---';

/** 去除字符串两侧引号（'x' / "x"）。 */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * 解析工具清单值：兼容三种写法（标准生态的实际使用面）——
 * - 流式列表 `[read, grep]`；
 * - 空格分隔字符串 `Read Grep`（Claude Code 口径）；
 * - 其余形态按单个条目处理。
 */
function parseToolList(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed === '') return [];
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((item) => unquote(item.trim()))
      .filter((item) => item.length > 0);
  }
  return trimmed
    .split(/\s+/)
    .map((item) => unquote(item))
    .filter((item) => item.length > 0);
}

/** 我们识别的工具清单字段名（标准连字符 + 本项目接受的驼峰别名）。 */
const ALLOWED_TOOLS_KEYS = new Set(['allowed-tools', 'allowedTools']);

/** parseFrontmatter 内部的可变中间态（与对外只读 SkillFrontmatter 同形）。 */
interface MutableFrontmatter {
  name?: string;
  description?: string;
  allowedTools?: string[];
}

/**
 * 解析 frontmatter 文本（`---` 之间的各行）。
 *
 * 识别的字段：name / description / allowed-tools（或 allowedTools）；其余字段
 * （license / compatibility / metadata / disable-model-invocation 等）忽略。
 * 未知键与无法识别的行静默跳过（标准兼容：别的 agent 用的字段不构成我们
 * 的加载负担）。
 */
function parseFrontmatter(text: string): SkillFrontmatter {
  const result: MutableFrontmatter = {};
  const lines = text.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const raw = lines[index].trim();
    if (raw === '' || raw.startsWith('#')) {
      index += 1;
      continue;
    }
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    if (match === null) {
      index += 1;
      continue;
    }
    const key = match[1];
    const value = match[2].trim();

    // 块状列表：`key:` 空值 + 后续若干 `- item` 行
    if (value === '' && ALLOWED_TOOLS_KEYS.has(key)) {
      const items: string[] = [];
      let cursor = index + 1;
      while (cursor < lines.length) {
        const itemLine = lines[cursor].trim();
        if (itemLine.startsWith('- ')) {
          items.push(unquote(itemLine.slice(2).trim()));
          cursor += 1;
        } else {
          break;
        }
      }
      if (items.length > 0) {
        result.allowedTools = items;
        index = cursor;
        continue;
      }
    }

    if (key === 'name') {
      result.name = unquote(value);
    } else if (key === 'description') {
      result.description = unquote(value);
    } else if (ALLOWED_TOOLS_KEYS.has(key)) {
      result.allowedTools = parseToolList(value);
    }
    index += 1;
  }
  return result;
}

/**
 * 把 SKILL.md 拆成 frontmatter 与正文。
 *
 * - 首行（允许前导空行与 BOM）必须恰为 `---`，否则视为无 frontmatter（整份
 *   内容都是正文——标准要求 frontmatter 在文件最开头）；
 * - 之后第一个恰为 `---` 的行作为闭合；无闭合分隔符同样视为无 frontmatter
 *   （容错：残缺 frontmatter 不吞掉正文）。
 */
function splitFrontmatter(markdown: string): {
  readonly frontmatter: string;
  readonly body: string;
} {
  const lines = markdown.split(/\r?\n/);
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start += 1;
  if (start >= lines.length || lines[start].trim() !== FRONTMATTER_DELIMITER) {
    return { frontmatter: '', body: markdown };
  }
  const end = lines.findIndex(
    (line, index) => index > start && line.trim() === FRONTMATTER_DELIMITER,
  );
  if (end === -1) return { frontmatter: '', body: markdown };
  return {
    frontmatter: lines.slice(start + 1, end).join('\n'),
    body: lines.slice(end + 1).join('\n'),
  };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 解析一份 SKILL.md 文本（纯函数，可离线测试）。
 *
 * @param markdown SKILL.md 的原始文本。
 * @param fallbackName frontmatter 缺 name 时的回落名（发现流程传目录名）。
 */
export function parseSkillMarkdown(
  markdown: string,
  fallbackName?: string,
): ParsedSkill {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const meta = parseFrontmatter(frontmatter);
  return {
    name: (meta.name?.trim() || fallbackName || '').trim(),
    description: (meta.description ?? '').trim(),
    allowedTools: meta.allowedTools ?? [],
    body: body.trim(),
    frontmatter: meta,
  };
}

/**
 * 读取技能目录下的 SKILL.md；不存在 / 不可读返回 null（发现流程据此跳过）。
 */
export function readSkillMarkdown(skillDir: string): string | null {
  try {
    return readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
}

/**
 * 列出技能目录的附带文件清单（不含 SKILL.md 本身）。
 *
 * - 递归收集全部普通文件，路径相对技能目录、正斜杠分隔、按名称排序（确定性）；
 * - 隐藏文件（`.` 开头）与空目录不进入清单——它们是版本控制噪音，不是技能资源。
 */
export function listSkillFiles(skillDir: string): string[] {
  const result: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter(
          (entry) =>
            !entry.name.startsWith('.') &&
            (entry.isFile() || entry.isDirectory()),
        )
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return;
    }
    for (const entryName of entries) {
      const fullPath = join(dir, entryName);
      const rel = prefix === '' ? entryName : `${prefix}/${entryName}`;
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(fullPath, rel);
      } else if (stat.isFile() && entryName !== 'SKILL.md') {
        result.push(rel);
      }
    }
  };
  walk(skillDir, '');
  return result;
}
