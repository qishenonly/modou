/**
 * 自定义斜杠命令（T-114，design 002 十节扩展点表：自定义斜杠 = Config 加载
 * `.modou/commands/*.md`）。
 *
 * `.modou/commands/*.md` 即命令：frontmatter 声明元信息（name / description /
 * 允许工具 / 默认模型），正文 = 注入的提示词，支持 `$1` 参数占位。
 *
 * 文件格式（YAML 风格的 frontmatter，夹在首尾 `---` 之间）：
 *
 *     ---
 *     name: fix-lint
 *     description: 修复 lint 错误
 *     allowedTools: read,grep,glob,write,edit,bash
 *     model: gpt-4o
 *     ---
 *     请修复当前仓库的 lint 错误：先运行 $1 定位，再修复并验证。
 *
 * - `name`：命令名（不带 `/` 前缀），必须、唯一、不与内置命令冲突；
 * - `description`：/help 展示用（必须）；
 * - `allowedTools`：可选，逗号分隔的工具名白名单（本命令运行只给这些工具，
 *   未声明 = 完整工具集）；
 * - `model`：可选，默认模型（本命令运行时切换，002 8.2「换 provider 实例」）；
 * - 正文：注入的提示词，`$1`/`$2`…/`$@` 为参数占位，`$$` 转义为字面 `$`。
 *
 * 依赖方向：本模块只依赖 node 内建（fs / path），不 import core 其他模块
 * （与 config/settings.ts 一致：Config 与 Session / Permission / Provider
 * 互不依赖，002 2.2）。工具白名单的注册表过滤在调用方（TUI）做。
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 一条自定义斜杠命令（从 `.modou/commands/*.md` 解析所得）。 */
export interface CustomCommandFile {
  /** 命令名（不带 `/` 前缀）。 */
  readonly name: string;
  /** 一句话描述（/help 展示）。 */
  readonly description: string;
  /** 允许的工具名白名单（未声明 = 完整工具集）。 */
  readonly allowedTools?: readonly string[];
  /** 默认模型（未声明 = 当前模型）。 */
  readonly model?: string;
  /** 注入的提示词正文（含 `$1` 等参数占位）。 */
  readonly prompt: string;
}

/** 内置斜杠命令名（自定义命令不得覆盖；TUI /help 合并展示用）。 */
export const BUILTIN_COMMAND_NAMES: readonly string[] = [
  'help',
  'model',
  'compact',
  'resume',
  'context',
  'clear',
  'rewind',
  'snapshots',
  'plan',
];

/** 命令文件名后缀。 */
const COMMAND_EXT = '.md';

/**
 * 解析一个 `.modou/commands/*.md` 文件内容为 CustomCommandFile。
 * 无 frontmatter 或缺 name / description / 正文时返回 null（调用方跳过）。
 *
 * 解析策略（frontmatter 是模型/用户手写，容错）：
 * 1. 首行必须是 `---`，找到下一个 `---` 作为 frontmatter 边界（其余为正文）；
 * 2. frontmatter 逐行 `key: value` 解析：name / description / model 为字符串，
 *    allowedTools 支持三种写法——逗号分隔（`a,b,c`）、空格分隔（`a b c`，
 *    与 skills 解析口径一致）与块状列表（`allowedTools:` 换行 `- a` 逐行）；
 * 3. 正文 = frontmatter 之后的全部内容（trim 去首尾空行）。
 */
export function parseCommandFrontmatter(
  text: string,
): CustomCommandFile | null {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---');
  if (end < 0) return null;
  const front = text.slice(3, end);
  const body = text.slice(end + 4).trim();
  const fields: Record<string, string> = {};
  const rawLines = front.split('\n');
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index].trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key.length === 0) continue;
    // 块状列表：`key:` 空值 + 后续若干 `- item` 行（0.17.0 起支持，
    // 与 skills 的 SKILL.md 解析同口径——模型/用户手写 frontmatter 的常见形态）
    if (key === 'allowedTools' && value === '') {
      const items: string[] = [];
      let cursor = index + 1;
      while (cursor < rawLines.length) {
        const itemLine = rawLines[cursor].trim();
        if (itemLine.startsWith('- ')) {
          items.push(itemLine.slice(2).trim());
          cursor += 1;
        } else {
          break;
        }
      }
      if (items.length > 0) {
        fields.allowedTools = items.join(',');
        index = cursor - 1;
        continue;
      }
    }
    fields[key] = value;
  }
  const name = fields.name?.trim();
  const description = fields.description?.trim();
  if (name === undefined || name.length === 0) return null;
  if (description === undefined || description.length === 0) return null;
  if (body.length === 0) return null;

  const allowedTools = fields.allowedTools
    ?.split(/[,\s]+/)
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0);
  const model = fields.model?.trim();

  return {
    name,
    description,
    ...(allowedTools !== undefined && allowedTools.length > 0
      ? { allowedTools }
      : {}),
    ...(model !== undefined && model.length > 0 ? { model } : {}),
    prompt: body,
  };
}

/** loadCustomCommands 的产出：加载的命令 + 被跳过的文件名（诊断用）。 */
export interface LoadCustomCommandsResult {
  readonly commands: readonly CustomCommandFile[];
  /** 因缺 name/description/正文或与内置冲突而被跳过的文件（不静默）。 */
  readonly skipped: readonly string[];
}

/**
 * 从 `<projectRoot>/.modou/commands/*.md` 加载全部自定义斜杠命令。
 * 目录不存在返回空列表；单个文件解析失败 / 与内置命令同名 = 跳过并记录
 * （调用方据 skipped 发 notice，不静默）。
 */
export async function loadCustomCommands(
  projectRoot: string,
): Promise<LoadCustomCommandsResult> {
  const dir = join(projectRoot, '.modou', 'commands');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { commands: [], skipped: [] };
  }
  const commands: CustomCommandFile[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>(BUILTIN_COMMAND_NAMES);
  for (const name of names.sort()) {
    if (!name.endsWith(COMMAND_EXT)) continue;
    const file = join(dir, name);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      skipped.push(name);
      continue;
    }
    const command = parseCommandFrontmatter(text);
    if (command === null || seen.has(command.name)) {
      skipped.push(name);
      continue;
    }
    seen.add(command.name);
    commands.push(command);
  }
  return { commands, skipped };
}

/**
 * 展开提示词中的参数占位：`$1`…`$9` = 按空白拆分的第 N 个参数（1-based），
 * `$@` = 全部参数（空白连接），`$0` = 原始参数字符串，`$$` = 字面 `$`。
 * 未提供的占位替换为空串；未识别的 `$X` 原样保留。
 */
export function expandCommandPlaceholders(
  prompt: string,
  args?: string,
): string {
  const tokens = (args ?? '').split(/\s+/).filter((token) => token.length > 0);
  const all = tokens.join(' ');
  const raw = args ?? '';
  return prompt.replace(/\$\$|\$@|\$0|\$[1-9]/g, (match) => {
    switch (match) {
      case '$$':
        return '$';
      case '$@':
        return all;
      case '$0':
        return raw;
      default: {
        const index = Number(match.slice(1)) - 1;
        return tokens[index] ?? '';
      }
    }
  });
}
