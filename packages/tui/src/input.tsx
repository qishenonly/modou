/**
 * 输入框（T-041）：多行编辑、粘贴、历史上翻、斜杠命令补全。
 *
 * ## 输入模型
 *
 * 扁平模型：文本是一条含 `\n` 的字符串，光标是字符偏移（UTF-16 code unit）。
 * 编辑操作（插入/删除/移动）都是对 (text, cursor) 的纯函数变换，见文件下部的
 * 导出函数——它们不依赖 React，可直接单元测试。
 *
 * ## 键位设计（Ink v5 实测约束，见注释中各序列实测结果）
 *
 * - **Enter（`\r`）提交**：唯一可靠的提交键（实测 `key.return=true`）。
 *   与 Claude Code 惯例一致；空输入不提交。
 * - **换行**：
 *   - **粘贴多行文本**自动正确换行——Ink 的 useInput 把一次粘贴（多字符）
 *     整体作为单个 `input` 传给 handler（实测 `input='hello\nworld'`），
 *     其中 `\n` 保留，在光标处整段插入；
 *   - **Ctrl+J（`\n` 字节）** 插入换行（shell/readline 惯例；实测可靠）；
 *   - **Shift+Enter**：在支持 CSI-u 修饰键协议（kitty/iTerm/WezTerm/
 *     Windows Terminal 等）的终端下到达 Ink 时为 `input='[13;2u'`
 *     （实测 Ink 不解析该序列），映射为换行；旧终端下 Shift+Enter 与
 *     Enter 同字节，退化为提交——退化行为已记录，不再重复。
 * - **Ctrl+A / Ctrl+E**：行首 / 行尾。Home/End 键在 Ink 里不可检测
 *   （实测 `\x1b[H` / `\x1b[F` 到达时无任何 key flag），故用 emacs 键位替代。
 * - **方向键**：←/→ 移动光标；↑/↓ 在斜杠补全列表打开时选择候选，
 *   否则翻阅本会话提交历史（历史浏览不丢当前草稿）。
 * - **退格**：`key.delete`（Ink 把物理 Backspace 的 `\x7f` 与 Delete 键的
 *   `\x1b[3~` 都归为 delete，实测不可区分）删除光标前字符；
 *   **Ctrl+D** 删除光标处字符。
 * - **Tab / Shift+Tab**：斜杠补全候选循环选择（Shift+Tab 反向）。
 * - **Ctrl+Z / Ctrl+Y**：undo / redo（可选增强，简单快照栈实现）。
 * - **Esc / Ctrl+C**：分别交由 App 处理（打断当前轮 / 干净退出）。
 *
 * ## 斜杠命令
 *
 * 输入以 `/` 开头时展示候选（内置 `/help /model /compact /resume /context /clear`，
 * 经 `slashCommands` prop 可注入）。Tab 循环选中，Enter 提交：优先使用选中的
 * 候选名，否则解析原始输入（`/compact now` → name='compact', args='now'），
 * 统一发 `slash` Command（002 3.3 表）。
 */
import { useMemo, useRef, useState, type ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';

/** 内置斜杠命令（0.4.0 静态列表；0.11.0 起自定义命令由 core 注入）。 */
export const DEFAULT_SLASH_COMMANDS: readonly string[] = [
  '/help',
  '/model',
  '/compact',
  '/resume',
  '/context',
  '/clear',
];

/** Input 组件属性。 */
export interface InputProps {
  /** 提交普通文本（Enter；文本以 `/` 开头时改走 onSlash）。 */
  readonly onSubmit: (text: string) => void;
  /** 提交斜杠命令（输入以 `/` 开头）。 */
  readonly onSlash: (name: string, args?: string) => void;
  /** 斜杠命令候选列表（含 `/` 前缀；缺省内置列表，可注入）。 */
  readonly slashCommands?: readonly string[];
}

/** 输入缓冲（扁平模型：text 含 `\n`，cursor 为字符偏移）。 */
export interface InputState {
  readonly text: string;
  readonly cursor: number;
}

// ---------------------------------------------------------------------------
// 编辑纯函数（无 React 依赖，可直接单元测试）
// ---------------------------------------------------------------------------

/** 初始缓冲：光标在末尾。 */
export function initialState(text = ''): InputState {
  return { text, cursor: text.length };
}

/** offset 所在行的行首偏移。 */
function lineStartOf(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1;
}

/** offset 所在行的行尾偏移（不含 `\n`）。 */
function lineEndOf(text: string, offset: number): number {
  const idx = text.indexOf('\n', offset);
  return idx === -1 ? text.length : idx;
}

/** 光标所在的行列（row 从 0 起）。 */
export function cursorRowCol(state: InputState): { row: number; col: number } {
  const start = lineStartOf(state.text, state.cursor);
  let row = 0;
  for (let i = 0; i < state.cursor; i++) {
    if (state.text.charCodeAt(i) === 10) row += 1;
  }
  return { row, col: state.cursor - start };
}

/** 在光标处插入文本（粘贴/换行/普通字符统一入口），归一化 `\r\n` / `\r` → `\n`。 */
export function insertText(state: InputState, text: string): InputState {
  if (text.length === 0) return state;
  const norm = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return {
    text:
      state.text.slice(0, state.cursor) + norm + state.text.slice(state.cursor),
    cursor: state.cursor + norm.length,
  };
}

/** 删除光标前一个字符（退格；行首删除时与上一行合并）。 */
export function backspace(state: InputState): InputState {
  if (state.cursor <= 0) return state;
  return {
    text:
      state.text.slice(0, state.cursor - 1) + state.text.slice(state.cursor),
    cursor: state.cursor - 1,
  };
}

/** 删除光标处字符（Ctrl+D）。 */
export function deleteForward(state: InputState): InputState {
  if (state.cursor >= state.text.length) return state;
  return {
    text:
      state.text.slice(0, state.cursor) + state.text.slice(state.cursor + 1),
    cursor: state.cursor,
  };
}

/** 光标左移（行首时跳到上一行行尾）。 */
export function moveLeft(state: InputState): InputState {
  if (state.cursor <= 0) return state;
  return { ...state, cursor: state.cursor - 1 };
}

/** 光标右移（行尾时跳到下一行行首）。 */
export function moveRight(state: InputState): InputState {
  if (state.cursor >= state.text.length) return state;
  return { ...state, cursor: state.cursor + 1 };
}

/** 光标到行首（Ctrl+A；Home 键在 Ink 不可检测）。 */
export function moveHome(state: InputState): InputState {
  return { ...state, cursor: lineStartOf(state.text, state.cursor) };
}

/** 光标到行尾（Ctrl+E）。 */
export function moveEnd(state: InputState): InputState {
  return { ...state, cursor: lineEndOf(state.text, state.cursor) };
}

/** 光标上移一行（同列，超出则钳制到行尾；第一行不动）。 */
export function moveUp(state: InputState): InputState {
  const start = lineStartOf(state.text, state.cursor);
  if (start === 0) return state;
  const prevStart = lineStartOf(state.text, start - 1);
  const col = state.cursor - start;
  const prevEnd = lineEndOf(state.text, prevStart);
  return { ...state, cursor: Math.min(prevStart + col, prevEnd) };
}

/** 光标下移一行（同列，超出则钳制到行尾；最后一行不动）。 */
export function moveDown(state: InputState): InputState {
  const end = lineEndOf(state.text, state.cursor);
  if (end === state.text.length) return state;
  const nextStart = end + 1;
  const col = state.cursor - lineStartOf(state.text, state.cursor);
  const nextEnd = lineEndOf(state.text, nextStart);
  return { ...state, cursor: Math.min(nextStart + col, nextEnd) };
}

/** 解析斜杠命令：`/compact now` → { name: 'compact', args: 'now' }。 */
export function parseSlash(text: string): { name: string; args?: string } {
  const rest = text.startsWith('/') ? text.slice(1) : text;
  const sp = rest.indexOf(' ');
  if (sp < 0) return { name: rest };
  const name = rest.slice(0, sp);
  const args = rest.slice(sp + 1);
  return args.length > 0 ? { name, args } : { name };
}

/** 以输入为前缀计算斜杠候选（忽略大小写）。 */
export function computeCandidates(
  text: string,
  commands: readonly string[],
): readonly string[] {
  if (!text.startsWith('/')) return [];
  const prefix = text.toLowerCase();
  return commands.filter((c) => c.toLowerCase().startsWith(prefix));
}

/** 从候选与当前选中索引解析出提交用的候选名（无候选返回 undefined）。 */
function resolveSelection(
  candidates: readonly string[],
  selIndex: number,
): string | undefined {
  if (candidates.length === 0) return undefined;
  if (selIndex >= 0 && selIndex < candidates.length)
    return candidates[selIndex];
  if (candidates.length === 1) return candidates[0];
  return undefined;
}

// ---------------------------------------------------------------------------
// Input 组件
// ---------------------------------------------------------------------------

/** undo 快照栈上限（文本很小，防止无限增长）。 */
const UNDO_LIMIT = 100;

export function Input(props: InputProps): ReactElement {
  const { onSubmit, onSlash } = props;
  const slashCommands = props.slashCommands ?? DEFAULT_SLASH_COMMANDS;

  // 缓冲状态：state 供渲染，stateRef 供键盘回调读最新值。
  // 注意：apply/applyHistory 等会**同步**更新 stateRef——终端的按键可能在同一
  // 事件循环 tick 内突发到达（React 批处理把多次 setState 合成一次渲染），
  // 若只在渲染期同步 ref，同 tick 的后续按键会读到过期状态（如 Tab 后紧跟 Enter）。
  const [state, setState] = useState<InputState>(() => initialState());
  const stateRef = useRef(state);
  stateRef.current = state;

  // 本会话已提交的输入历史（submit 与 slash 都记录）
  const [history, setHistory] = useState<readonly string[]>([]);
  const historyRef = useRef(history);
  historyRef.current = history;

  // 历史浏览：histIndex = -1 表示正在编辑新草稿；↑ 时把当前草稿存入 draftRef
  const histIndexRef = useRef(-1);
  const draftRef = useRef<InputState | null>(null);

  // 斜杠补全选中索引（-1 = 未选中）；selIndexRef 与 stateRef 同理同步更新
  const [selIndex, setSelIndex] = useState(-1);
  const selIndexRef = useRef(-1);

  // undo/redo 快照栈
  const undoStackRef = useRef<InputState[]>([]);
  const redoStackRef = useRef<InputState[]>([]);

  const pushUndo = (prev: InputState): void => {
    undoStackRef.current.push(prev);
    if (undoStackRef.current.length > UNDO_LIMIT) {
      undoStackRef.current.shift();
    }
    redoStackRef.current = [];
  };

  const resetSelection = (): void => {
    selIndexRef.current = -1;
    setSelIndex(-1);
  };

  /** 编辑类操作：进 undo 栈、同步更新缓冲、重置补全选中。 */
  const apply = (next: InputState): void => {
    pushUndo(stateRef.current);
    stateRef.current = next;
    setState(next);
    resetSelection();
  };

  /** 历史翻页：不进 undo 栈。 */
  const applyHistory = (next: InputState): void => {
    stateRef.current = next;
    setState(next);
    resetSelection();
  };

  const undo = (): void => {
    const prev = undoStackRef.current.pop();
    if (prev === undefined) return;
    redoStackRef.current.push(stateRef.current);
    stateRef.current = prev;
    setState(prev);
    resetSelection();
  };

  const redo = (): void => {
    const next = redoStackRef.current.pop();
    if (next === undefined) return;
    undoStackRef.current.push(stateRef.current);
    stateRef.current = next;
    setState(next);
    resetSelection();
  };

  // 斜杠候选（以当前输入为前缀）。渲染用 useMemo；键盘回调用 currentCandidates
  // 实时从 stateRef 计算，保证同 tick 突发按键看到最新输入。
  const candidates = useMemo(
    () => computeCandidates(state.text, slashCommands),
    [state.text, slashCommands],
  );
  const currentCandidates = (): readonly string[] =>
    computeCandidates(stateRef.current.text, slashCommands);

  const reset = (): void => {
    const empty = initialState();
    stateRef.current = empty;
    setState(empty);
    resetSelection();
    histIndexRef.current = -1;
    draftRef.current = null;
  };

  const commitHistory = (text: string): void => {
    setHistory((prev) => [...prev, text]);
  };

  /** 提交：以 `/` 开头走 slash Command，否则 submit（空输入不提交）。 */
  const submit = (): void => {
    const { text } = stateRef.current;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const cands = currentCandidates();

    if (text.startsWith('/')) {
      const sel = resolveSelection(cands, selIndexRef.current);
      if (sel !== undefined) {
        onSlash(sel.slice(1));
        commitHistory(sel);
      } else {
        const parsed = parseSlash(text);
        if (parsed.name.length === 0 && cands.length > 0) {
          // 只输入 `/`：退化为第一个候选（等价「选一个执行」）
          onSlash(cands[0].slice(1));
          commitHistory(cands[0]);
        } else {
          onSlash(parsed.name, parsed.args);
          commitHistory(text);
        }
      }
    } else {
      onSubmit(trimmed);
      commitHistory(trimmed);
    }
    reset();
  };

  /** ↑：进入历史或向前翻（保留草稿）。 */
  const historyUp = (): void => {
    const hist = historyRef.current;
    if (hist.length === 0) return;
    if (histIndexRef.current === -1) {
      draftRef.current = stateRef.current;
      histIndexRef.current = hist.length - 1;
    } else if (histIndexRef.current > 0) {
      histIndexRef.current -= 1;
    }
    const t = hist[histIndexRef.current];
    applyHistory({ text: t, cursor: t.length });
  };

  /** ↓：向后翻历史，越过最新一条时恢复草稿。 */
  const historyDown = (): void => {
    if (histIndexRef.current === -1) return;
    histIndexRef.current += 1;
    if (histIndexRef.current >= historyRef.current.length) {
      histIndexRef.current = -1;
      applyHistory(draftRef.current ?? initialState());
      draftRef.current = null;
    } else {
      const t = historyRef.current[histIndexRef.current];
      applyHistory({ text: t, cursor: t.length });
    }
  };

  /** 在候选之间移动选中索引（循环；up 反向 / down 正向）。 */
  const cycleSelection = (direction: 'up' | 'down'): void => {
    const cands = currentCandidates();
    if (cands.length === 0) return;
    const next =
      direction === 'up'
        ? selIndexRef.current <= 0
          ? cands.length - 1
          : selIndexRef.current - 1
        : selIndexRef.current >= cands.length - 1
          ? 0
          : selIndexRef.current + 1;
    selIndexRef.current = next;
    setSelIndex(next);
  };

  useInput((input, key) => {
    // Esc：交由 App 处理（打断当前轮）
    if (key.escape) return;

    // Ctrl 组合：处理已知，其余忽略——绝不把 ctrl 组合当普通文本插入
    if (key.ctrl) {
      if (input === 'a') return apply(moveHome(stateRef.current));
      if (input === 'e') return apply(moveEnd(stateRef.current));
      if (input === 'd') return apply(deleteForward(stateRef.current));
      if (input === 'z') return undo();
      if (input === 'y') return redo();
      return; // ctrl+c 由 App 处理退出；其余 ctrl 组合忽略
    }

    // Enter：提交（实测 `\r` → key.return=true；Alt+Enter 也落到 input='\r'）
    if (key.return || input === '\r') {
      submit();
      return;
    }

    // 换行：Ctrl+J（`\n` 字节）；Shift+Enter（CSI-u）在现代终端映射到换行
    if (input === '\n' || input === '[13;2u') {
      apply(insertText(stateRef.current, '\n'));
      return;
    }

    // 方向键：补全打开时 ↑/↓ 选择候选，否则 ↑/↓ 翻历史
    if (key.upArrow || key.downArrow) {
      if (currentCandidates().length > 0) {
        cycleSelection(key.upArrow ? 'up' : 'down');
      } else if (key.upArrow) {
        historyUp();
      } else {
        historyDown();
      }
      return;
    }
    if (key.leftArrow) {
      apply(moveLeft(stateRef.current));
      return;
    }
    if (key.rightArrow) {
      apply(moveRight(stateRef.current));
      return;
    }

    // Tab / Shift+Tab：斜杠补全循环选择
    if (key.tab) {
      cycleSelection(key.shift ? 'up' : 'down');
      return;
    }

    // 退格/删除（Ink 把物理 Backspace 与 Delete 都报 delete；删光标前字符）
    if (key.backspace || key.delete) {
      apply(backspace(stateRef.current));
      return;
    }

    // 普通文本 / 粘贴多行（input 可能含 `\n`，整体在光标处插入）
    if (input.length > 0) {
      apply(insertText(stateRef.current, input));
    }
  });

  // 渲染：多行文本，光标处用反显标记（行末显示反显空格）
  const lines = state.text.split('\n');
  const { row, col } = cursorRowCol(state);

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        {lines.map((line, index) => {
          if (index === row) {
            const caret = line.charAt(col);
            return (
              <Box key={index}>
                <Text>{line.slice(0, col)}</Text>
                <Text inverse>{caret.length > 0 ? caret : ' '}</Text>
                <Text>{line.slice(col + 1)}</Text>
              </Box>
            );
          }
          return <Text key={index}>{line}</Text>;
        })}
      </Box>

      {/* 斜杠补全候选列表 */}
      {candidates.length > 0 && (
        <Box flexDirection="column">
          {candidates.map((c, index) => (
            <Text
              key={c}
              inverse={index === selIndex}
              dimColor={index !== selIndex}
            >
              {c}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
