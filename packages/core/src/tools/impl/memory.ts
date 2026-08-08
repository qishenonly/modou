import { z } from 'zod';
import {
  listMemoryNotes,
  readMemoryNote,
  writeMemoryNote,
} from '../../memory/store';
import type { Tool, ToolOutcome } from '../types';

/**
 * 长期记忆工具（0.17.0 T-173，ADR 0016：文件式结构化笔记）。
 *
 * 三个工具一组（memory_write / memory_read / memory_list）：agent 可**自主**
 * 读写跨会话持久化的结构化笔记（记忆目录 `<projectRoot>/.modou/memory/`）。
 * 记忆是文件 + 结构化笔记，不上向量库——工作记忆当上下文预算问题处理：
 * 新会话启动把全部笔记注入系统提示词（loadMemoryText，总量上限内），本组工具
 * 是会话内的读写通道（记录决策 / 约定 / 结论，供未来会话加载）。
 *
 * 风险分类：
 * - `memory_write`：risk **`write`**——持久化写入是真实副作用，经审批闸门
 *   （与其他写工具一致，可被 allow_always 记忆豁免）；写入内容注入未来会话，
 *   用户能看到 agent 记录了什么是好事；
 * - `memory_read` / `memory_list`：risk **`read`**——读取记忆不产生副作用。
 *
 * 安全：键白名单（字母数字 + 下划线/连字符）由 store 强制（路径穿越从结构上
 * 拒绝）；内容单条上限 8K 字符。目录由装配方注入（deps.dir；测试用临时目录）。
 *
 * 模块依赖约束（002 2.2）：tools 边界只依赖 zod 与 protocol/events——
 * 本模块 import ../../memory/store（Config 扩展点，只依赖 node 内建），
 * 不触碰 runtime / provider。
 */

/** memory_write 工具名。 */
export const MEMORY_WRITE_TOOL_NAME = 'memory_write';
/** memory_read 工具名。 */
export const MEMORY_READ_TOOL_NAME = 'memory_read';
/** memory_list 工具名。 */
export const MEMORY_LIST_TOOL_NAME = 'memory_list';

/** 记忆工具组入参（装配方注入记忆目录；测试注入临时目录）。 */
export interface MemoryToolDeps {
  /** 记忆目录（`<projectRoot>/.modou/memory/`）。 */
  readonly dir: string;
}

/** memory_write 参数：key + content。 */
const memoryWriteSchema = z.object({
  key: z.string().min(1, 'key 不能为空字符串'),
  content: z
    .string()
    .min(1, 'content 不能为空字符串')
    .max(8_000, 'content 最长 8000 字符，请精简'),
});

/** memory_read 参数：key。 */
const memoryReadSchema = z.object({
  key: z.string().min(1, 'key 不能为空字符串'),
});

/** memory_list 参数：无。 */
const memoryListSchema = z.object({});

/** 构造长期记忆工具组（三个工具）。 */
export function createMemoryTools(deps: MemoryToolDeps): readonly Tool[] {
  const writeTool: Tool<typeof memoryWriteSchema> = {
    name: MEMORY_WRITE_TOOL_NAME,
    description:
      '写入一条长期记忆笔记（跨会话持久化到项目 .modou/memory/）。' +
      '适合记录本会话值得未来记住的事实：项目约定、技术决策与理由、' +
      '关键结论、踩过的坑。key 是记忆键（字母数字/下划线/连字符，1~64 字符），' +
      '同名键覆盖；content 是笔记内容（≤8000 字符）。记忆在**新会话启动时加载进' +
      '上下文**（总量上限内，最近写入优先），所以只记值得长期保留的东西，不要' +
      '把一次性状态写进记忆。写入需经审批（持久化副作用）。',
    schema: memoryWriteSchema,
    risk: 'write',
    execute: async (args): Promise<ToolOutcome> => {
      const result = writeMemoryNote(deps.dir, args.key, args.content);
      if (!result.ok) {
        return { ok: false, forModel: result.error };
      }
      return {
        ok: true,
        forModel: `已写入长期记忆「${result.note.key}」——将在新会话启动时加载进上下文。`,
        summary: `记忆写入：${result.note.key}`,
        payload: { key: result.note.key },
      };
    },
  };

  const readTool: Tool<typeof memoryReadSchema> = {
    name: MEMORY_READ_TOOL_NAME,
    description:
      '读取一条长期记忆笔记（本会话写入或此前会话遗留）。key 与记忆键严格匹配；' +
      '不存在的键返回可诊断错误并列出可用记忆键，供核对。读取不产生副作用。',
    schema: memoryReadSchema,
    risk: 'read',
    execute: async (args): Promise<ToolOutcome> => {
      const note = readMemoryNote(deps.dir, args.key);
      if (note === null) {
        const available = listMemoryNotes(deps.dir)
          .map((n) => n.key)
          .join('、');
        return {
          ok: false,
          forModel:
            `记忆「${args.key}」不存在。` +
            (available.length > 0
              ? `可用记忆键：${available}。`
              : '当前没有记忆。') +
            `请核对键名（与写入时的 key 严格一致），或先用 memory_write 记录。`,
        };
      }
      return {
        ok: true,
        forModel: `长期记忆「${note.key}」${note.updatedAt !== undefined ? `（${note.updatedAt}）` : ''}：\n\n${note.content}`,
        summary: `记忆读取：${note.key}`,
        payload: { key: note.key, content: note.content },
      };
    },
  };

  const listTool: Tool<typeof memoryListSchema> = {
    name: MEMORY_LIST_TOOL_NAME,
    description:
      '列出全部长期记忆笔记（键 + 更新时间 + 首行摘要）。' +
      '适合开工前了解已有哪些记忆（哪些值得读全文 / 哪些该更新）。读取不产生副作用。',
    schema: memoryListSchema,
    risk: 'read',
    execute: async (): Promise<ToolOutcome> => {
      const notes = listMemoryNotes(deps.dir);
      if (notes.length === 0) {
        return {
          ok: true,
          forModel: '当前没有长期记忆笔记。可用 memory_write 记录第一条。',
          summary: '记忆列表：空',
          payload: { notes: [] },
        };
      }
      const lines = notes.map((note) => {
        const firstLine = note.content.split('\n')[0] ?? '';
        const first =
          firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
        return `- ${note.key}${note.updatedAt !== undefined ? `（${note.updatedAt}）` : ''}：${first}`;
      });
      return {
        ok: true,
        forModel: `长期记忆（${notes.length} 条）：\n${lines.join('\n')}`,
        summary: `记忆列表：${notes.length} 条`,
        payload: {
          notes: notes.map((note) => ({
            key: note.key,
            ...(note.updatedAt !== undefined
              ? { updatedAt: note.updatedAt }
              : {}),
          })),
        },
      };
    },
  };

  return [writeTool, readTool, listTool];
}

/** 缺省记忆工具组（未注入目录——调用即失败，供注册表占位）。 */
export function defaultMemoryTools(): readonly Tool[] {
  return createMemoryTools({ dir: '' });
}
