import { afterAll, describe, expect, test } from 'bun:test';
import { render, cleanup } from 'ink-testing-library';
import {
  backspace,
  computeCandidates,
  cursorRowCol,
  deleteForward,
  initialState,
  insertText,
  Input,
  moveDown,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  moveUp,
  parseSlash,
} from './input';

// ---------------------------------------------------------------------------
// 测试替身：ink-testing-library 的 stdin.write 一次调用 = 一次 input 事件
// （App 内 useInput 的 handleData 会把整段多字符文本作为单个 input 传入）。
// ---------------------------------------------------------------------------

/** 提交回调记录（区分 submit / slash）。 */
type Call =
  | { kind: 'submit'; text: string }
  | { kind: 'slash'; name: string; args?: string };

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setTimeout(resolve, 20));
}

// 按键序列（Ink v5 parse-keypress 实测字节）
const KEY = {
  enter: '\r',
  ctrlA: '\x01',
  ctrlE: '\x05',
  ctrlD: '\x04',
  ctrlJ: '\n',
  ctrlZ: '\x1a',
  ctrlY: '\x19',
  backspace: '\x7f',
  tab: '\t',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  shiftEnter: '\x1b[13;2u', // CSI-u（现代终端）
};

describe('input 编辑纯函数（多行 / 光标 / 斜杠解析）', () => {
  test('insertText 多行插入与光标推进', () => {
    const s = insertText(initialState('ab'), 'xy');
    expect(s).toEqual({ text: 'abxy', cursor: 4 });
    // 在光标处插入换行
    const m = insertText({ text: 'ab', cursor: 1 }, '\n');
    expect(m).toEqual({ text: 'a\nb', cursor: 2 });
    // 粘贴多行：\n 保留
    const p = insertText(initialState(), 'hello\nworld');
    expect(p.text).toBe('hello\nworld');
    expect(p.cursor).toBe(11);
    // 归一化 \r\n 与 \r → \n（终端粘贴差异）
    expect(insertText(initialState(), 'a\r\nb\rc').text).toBe('a\nb\nc');
  });

  test('backspace / deleteForward', () => {
    expect(backspace(initialState('ab'))).toEqual({ text: 'a', cursor: 1 });
    expect(backspace({ text: 'a', cursor: 0 })).toEqual({
      text: 'a',
      cursor: 0,
    });
    // 行首退格与上一行合并
    expect(backspace({ text: 'a\nb', cursor: 2 })).toEqual({
      text: 'ab',
      cursor: 1,
    });
    expect(deleteForward(initialState('ab'))).toEqual({
      text: 'ab',
      cursor: 2,
    });
    expect(deleteForward({ text: 'ab', cursor: 0 })).toEqual({
      text: 'b',
      cursor: 0,
    });
  });

  test('光标移动：左右、行首行尾、跨行上下', () => {
    const s = initialState('ab\ncd');
    expect(moveLeft({ ...s, cursor: 3 })).toEqual({
      text: 'ab\ncd',
      cursor: 2,
    });
    expect(moveLeft({ ...s, cursor: 0 })).toEqual({
      text: 'ab\ncd',
      cursor: 0,
    });
    expect(moveRight({ ...s, cursor: 2 })).toEqual({
      text: 'ab\ncd',
      cursor: 3,
    });
    expect(moveRight({ ...s, cursor: 5 })).toEqual({
      text: 'ab\ncd',
      cursor: 5,
    });
    expect(moveHome({ ...s, cursor: 4 })).toEqual({
      text: 'ab\ncd',
      cursor: 3,
    });
    expect(moveEnd({ ...s, cursor: 1 })).toEqual({ text: 'ab\ncd', cursor: 2 });
    // 上移：从第二行 col 1 到第一行 col 1
    expect(moveUp({ ...s, cursor: 4 })).toEqual({ text: 'ab\ncd', cursor: 1 });
    // 上移：第二行 col 2 超出第一行长度 → 钳制到第一行行尾
    expect(moveUp({ ...s, cursor: 5 })).toEqual({ text: 'ab\ncd', cursor: 2 });
    // 下移：从第一行 col 0 到第二行 col 0
    expect(moveDown({ ...s, cursor: 0 })).toEqual({
      text: 'ab\ncd',
      cursor: 3,
    });
    // 已在最后一行 / 第一行：不动
    expect(moveDown({ ...s, cursor: 5 })).toEqual({
      text: 'ab\ncd',
      cursor: 5,
    });
    expect(moveUp({ ...s, cursor: 0 })).toEqual({ text: 'ab\ncd', cursor: 0 });
  });

  test('cursorRowCol 行列计算', () => {
    expect(cursorRowCol(initialState())).toEqual({ row: 0, col: 0 });
    expect(cursorRowCol(initialState('a\nbc'))).toEqual({ row: 1, col: 2 });
    expect(cursorRowCol({ text: 'a\nb', cursor: 1 })).toEqual({
      row: 0,
      col: 1,
    });
  });

  test('parseSlash 解析命令名与参数', () => {
    expect(parseSlash('/compact')).toEqual({ name: 'compact' });
    expect(parseSlash('/model deepseek')).toEqual({
      name: 'model',
      args: 'deepseek',
    });
    expect(parseSlash('/resume 3 args')).toEqual({
      name: 'resume',
      args: '3 args',
    });
    expect(parseSlash('nope')).toEqual({ name: 'nope' });
    expect(parseSlash('/')).toEqual({ name: '' });
  });

  test('computeCandidates 前缀匹配（忽略大小写）', () => {
    expect(computeCandidates('/', ['/help', '/model'])).toEqual([
      '/help',
      '/model',
    ]);
    expect(computeCandidates('/mo', ['/help', '/model', '/compact'])).toEqual([
      '/model',
    ]);
    expect(computeCandidates('/MODEL', ['/help', '/model'])).toEqual([
      '/model',
    ]);
    expect(computeCandidates('hello', ['/help'])).toEqual([]);
  });
});

describe('Input 组件（T-041 输入框）', () => {
  afterAll(() => {
    cleanup();
  });

  test('多行输入：Ctrl+J 换行，光标随输入移动', async () => {
    const calls: Call[] = [];
    const { stdin, lastFrame, unmount } = render(
      <Input
        onSubmit={(text) => calls.push({ kind: 'submit', text })}
        onSlash={(name, args) => calls.push({ kind: 'slash', name, args })}
      />,
    );
    await flush();

    stdin.write('ab');
    stdin.write(KEY.ctrlJ); // 换行
    stdin.write('cd');
    await flush();
    let frame = lastFrame() ?? '';
    expect(frame).toContain('ab');
    expect(frame).toContain('cd');

    // Ctrl+A 到行首（第二行），输入 X → 第二行变成 Xcd
    stdin.write(KEY.ctrlA);
    stdin.write('X');
    await flush();
    frame = lastFrame() ?? '';
    expect(frame).toContain('ab');
    expect(frame).toContain('Xcd');

    unmount();
  });

  test('方向键移动光标后输入插入到正确位置', async () => {
    const { stdin, lastFrame, unmount } = render(
      <Input onSubmit={() => {}} onSlash={() => {}} />,
    );
    await flush();

    stdin.write('ab');
    stdin.write('cd');
    stdin.write(KEY.left); // 光标移到 d 前
    stdin.write(KEY.left); // 光标移到 c 前
    stdin.write('X');
    await flush();
    expect(lastFrame() ?? '').toContain('abXcd');

    // 上移到第一行行首（Ctrl+A 已到行首），输入 Y
    stdin.write(KEY.up);
    stdin.write(KEY.ctrlA);
    stdin.write('Y');
    await flush();
    expect(lastFrame() ?? '').toContain('YabXcd');

    unmount();
  });

  test('粘贴多行文本整体进入输入（不分行错乱）', async () => {
    const { stdin, lastFrame, unmount } = render(
      <Input onSubmit={() => {}} onSlash={() => {}} />,
    );
    await flush();

    // 一次 write = 一次粘贴（多字符 input，含 \n）
    stdin.write('hello\nworld');
    await flush();
    let frame = lastFrame() ?? '';
    expect(frame).toContain('hello');
    expect(frame).toContain('world');

    // 光标在粘贴文本末尾，继续输入追加在 world 后
    stdin.write('!');
    await flush();
    frame = lastFrame() ?? '';
    expect(frame).toContain('world!');

    unmount();
  });

  test('历史上翻/下翻与草稿保留', async () => {
    const calls: Call[] = [];
    const { stdin, lastFrame, unmount } = render(
      <Input
        onSubmit={(text) => calls.push({ kind: 'submit', text })}
        onSlash={(name, args) => calls.push({ kind: 'slash', name, args })}
      />,
    );
    await flush();

    // 提交两条历史
    stdin.write('first');
    stdin.write(KEY.enter);
    await flush();
    stdin.write('second');
    stdin.write(KEY.enter);
    await flush();
    expect(calls).toEqual([
      { kind: 'submit', text: 'first' },
      { kind: 'submit', text: 'second' },
    ]);

    // 编辑草稿 third，然后上翻历史
    stdin.write('third');
    await flush();
    stdin.write(KEY.up);
    await flush();
    expect(lastFrame() ?? '').toContain('second');
    stdin.write(KEY.up);
    await flush();
    expect(lastFrame() ?? '').toContain('first');

    // 下翻回到最新历史
    stdin.write(KEY.down);
    await flush();
    expect(lastFrame() ?? '').toContain('second');

    // 再下翻越过最新 → 恢复草稿 third（草稿不丢）
    stdin.write(KEY.down);
    await flush();
    expect(lastFrame() ?? '').toContain('third');

    unmount();
  });

  test('无历史时上翻无操作', async () => {
    const { stdin, lastFrame, unmount } = render(
      <Input onSubmit={() => {}} onSlash={() => {}} />,
    );
    await flush();
    stdin.write('abc');
    stdin.write(KEY.up);
    await flush();
    expect(lastFrame() ?? '').toContain('abc');
    unmount();
  });

  test('斜杠补全：候选展示、Tab 循环选择、Enter 走 slash', async () => {
    const calls: Call[] = [];
    const { stdin, lastFrame, unmount } = render(
      <Input
        onSubmit={(text) => calls.push({ kind: 'submit', text })}
        onSlash={(name, args) => calls.push({ kind: 'slash', name, args })}
      />,
    );
    await flush();

    // 输入 / → 展示内置候选
    stdin.write('/');
    await flush();
    let frame = lastFrame() ?? '';
    expect(frame).toContain('/help');
    expect(frame).toContain('/model');
    expect(frame).toContain('/compact');

    // 输入 /mo → 只剩 /model
    stdin.write('mo');
    await flush();
    frame = lastFrame() ?? '';
    expect(frame).toContain('/model');
    expect(frame).not.toContain('/help');

    // Tab 选中（唯一候选）→ Enter 提交 slash name='model'
    stdin.write(KEY.tab);
    stdin.write(KEY.enter);
    await flush();
    expect(calls).toEqual([{ kind: 'slash', name: 'model' }]);

    unmount();
  });

  test('斜杠补全：Tab 循环多候选，Shift+Tab 反向', async () => {
    const calls: Call[] = [];
    const { stdin, unmount } = render(
      <Input
        onSubmit={(text) => calls.push({ kind: 'submit', text })}
        onSlash={(name, args) => calls.push({ kind: 'slash', name, args })}
      />,
    );
    await flush();

    stdin.write('/');
    stdin.write(KEY.tab); // 选中第一个 /help
    stdin.write(KEY.tab); // 循环到第二个 /model
    stdin.write(KEY.enter);
    await flush();
    expect(calls).toEqual([{ kind: 'slash', name: 'model' }]);

    // 反向：/ + Shift+Tab（反向循环到最后一个）
    stdin.write('/');
    stdin.write('\x1b[Z');
    stdin.write(KEY.enter);
    await flush();
    expect(calls).toEqual([
      { kind: 'slash', name: 'model' },
      { kind: 'slash', name: 'clear' },
    ]);

    unmount();
  });

  test('斜杠命令带参数：/compact now → slash(compact, now)', async () => {
    const calls: Call[] = [];
    const { stdin, unmount } = render(
      <Input
        onSubmit={(text) => calls.push({ kind: 'submit', text })}
        onSlash={(name, args) => calls.push({ kind: 'slash', name, args })}
      />,
    );
    await flush();

    stdin.write('/compact now');
    stdin.write(KEY.enter);
    await flush();
    expect(calls).toEqual([{ kind: 'slash', name: 'compact', args: 'now' }]);
    unmount();
  });

  test('只输入 / 直接 Enter：退化为第一个候选', async () => {
    const calls: Call[] = [];
    const { stdin, unmount } = render(
      <Input
        onSubmit={(text) => calls.push({ kind: 'submit', text })}
        onSlash={(name, args) => calls.push({ kind: 'slash', name, args })}
      />,
    );
    await flush();

    stdin.write('/');
    stdin.write(KEY.enter);
    await flush();
    expect(calls).toEqual([{ kind: 'slash', name: 'help' }]);
    unmount();
  });

  test('普通文本 Enter 提交 submit；空输入不提交', async () => {
    const calls: Call[] = [];
    const { stdin, unmount } = render(
      <Input
        onSubmit={(text) => calls.push({ kind: 'submit', text })}
        onSlash={(name, args) => calls.push({ kind: 'slash', name, args })}
      />,
    );
    await flush();

    stdin.write(KEY.enter); // 空输入：不提交
    await flush();
    expect(calls).toEqual([]);

    stdin.write('hello');
    stdin.write(KEY.enter);
    await flush();
    expect(calls).toEqual([{ kind: 'submit', text: 'hello' }]);
    unmount();
  });

  test('提交后输入框清空', async () => {
    const { stdin, lastFrame, unmount } = render(
      <Input onSubmit={() => {}} onSlash={() => {}} />,
    );
    await flush();
    stdin.write('abc');
    stdin.write(KEY.enter);
    await flush();
    // 提交后缓冲区清空：不再显示 abc
    expect(lastFrame() ?? '').not.toContain('abc');
    unmount();
  });

  test('自定义 slashCommands 注入', async () => {
    const calls: Call[] = [];
    const { stdin, lastFrame, unmount } = render(
      <Input
        onSubmit={(text) => calls.push({ kind: 'submit', text })}
        onSlash={(name, args) => calls.push({ kind: 'slash', name, args })}
        slashCommands={['/alpha', '/beta']}
      />,
    );
    await flush();

    stdin.write('/');
    await flush();
    expect(lastFrame() ?? '').toContain('/alpha');
    expect(lastFrame() ?? '').not.toContain('/help');

    stdin.write('a');
    stdin.write(KEY.tab);
    stdin.write(KEY.enter);
    await flush();
    expect(calls).toEqual([{ kind: 'slash', name: 'alpha' }]);
    unmount();
  });

  test('退格删除光标前字符；Ctrl+D 删除光标处字符', async () => {
    const { stdin, lastFrame, unmount } = render(
      <Input onSubmit={() => {}} onSlash={() => {}} />,
    );
    await flush();

    stdin.write('abc');
    stdin.write(KEY.backspace);
    await flush();
    expect(lastFrame() ?? '').toContain('ab');

    stdin.write(KEY.ctrlA);
    stdin.write(KEY.ctrlD); // 删除光标处 'a'
    await flush();
    expect(lastFrame() ?? '').toContain('b');

    unmount();
  });

  test('undo / redo（Ctrl+Z / Ctrl+Y）', async () => {
    const { stdin, lastFrame, unmount } = render(
      <Input onSubmit={() => {}} onSlash={() => {}} />,
    );
    await flush();

    stdin.write('a');
    stdin.write('b');
    await flush();
    expect(lastFrame() ?? '').toContain('ab');

    stdin.write(KEY.ctrlZ);
    await flush();
    expect(lastFrame() ?? '').toContain('a');

    stdin.write(KEY.ctrlY);
    await flush();
    expect(lastFrame() ?? '').toContain('ab');

    unmount();
  });

  test('Shift+Enter（CSI-u）在现代终端语义下插入换行', async () => {
    const { stdin, lastFrame, unmount } = render(
      <Input onSubmit={() => {}} onSlash={() => {}} />,
    );
    await flush();

    stdin.write('ab');
    stdin.write(KEY.shiftEnter); // 换行
    stdin.write('cd');
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('ab');
    expect(frame).toContain('cd');
    unmount();
  });
});
