import { afterAll, describe, expect, test } from 'bun:test';
import { render, cleanup } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { Text } from 'ink';
import type { ListBlock } from './markdown';
import {
  DEFAULT_FRAME_MS,
  FrameThrottle,
  Markdown,
  highlight,
  parseBlocks,
  parseInline,
  useFrameThrottledText,
} from './markdown';

// ---------------------------------------------------------------------------
// 测试说明
// ---------------------------------------------------------------------------
// - ink-testing-library 的帧在非 TTY 下不含 ANSI 转义（Ink 只对 TTY 输出上色），
//   所以「代码块高亮产生颜色」在 highlight() 的 token 层面断言（token 带
//   Ink color 名），渲染层断言代码文本进入输出帧。
// - 帧节流 / 未闭合结构用真实 setTimeout（窗口 20–60ms，等待留足裕量），
//   确定性由帧窗口与等待时间的量级差保证。
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 等 Ink 首帧/重渲染落地（Markdown 首帧需若干 tick，见探针验证）。 */
async function frameReady(): Promise<void> {
  await sleep(30);
  await sleep(30);
}

describe('parseInline（行内解析：粗体 / 斜体 / 行内代码 / 链接）', () => {
  test('基础标记', () => {
    expect(parseInline('**加粗**')).toEqual([{ text: '加粗', bold: true }]);
    expect(parseInline('*斜体*')).toEqual([{ text: '斜体', italic: true }]);
    expect(parseInline('`code`')).toEqual([{ text: 'code', code: true }]);
    expect(parseInline('[modou](https://x)')).toEqual([
      { text: 'modou', link: true },
    ]);
  });

  test('行内代码与相邻文本分段', () => {
    expect(parseInline('前 `中` 后')).toEqual([
      { text: '前 ' },
      { text: '中', code: true },
      { text: ' 后' },
    ]);
  });

  test('嵌套强调：粗体内斜体', () => {
    expect(parseInline('**粗 *斜* 粗**')).toEqual([
      { text: '粗 ', bold: true },
      { text: '斜', italic: true, bold: true },
      { text: ' 粗', bold: true },
    ]);
  });

  test('未闭合标记按字面渲染（流式安全）', () => {
    expect(parseInline('**未闭合')).toEqual([{ text: '**未闭合' }]);
    expect(parseInline('`未闭合')).toEqual([{ text: '`未闭合' }]);
  });
});

describe('parseBlocks（块解析：标题 / 段落 / 列表 / 代码块）', () => {
  test('标题 / 段落 / 无序列表 / 代码块', () => {
    const blocks = parseBlocks(
      '# 标题\n\n正文。\n\n- 甲\n- 乙\n\n```ts\nconst x = 1;\n```',
    );
    expect(blocks.map((b) => b.type)).toEqual([
      'heading',
      'paragraph',
      'list',
      'code',
    ]);
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 1 });
    expect(blocks[2]).toMatchObject({ type: 'list', ordered: false });
    expect((blocks[2] as ListBlock).items).toHaveLength(2);
    expect(blocks[3]).toMatchObject({
      type: 'code',
      lang: 'ts',
      code: 'const x = 1;',
    });
  });

  test('有序列表与嵌套列表', () => {
    const ordered = parseBlocks('1. 一\n2. 二');
    const orderedList = ordered[0] as ListBlock;
    expect(orderedList.ordered).toBe(true);
    expect(orderedList.items).toHaveLength(2);

    const nested = parseBlocks('- a\n  - b\n- c');
    const list = nested[0] as ListBlock;
    expect(list.items).toHaveLength(2);
    expect(list.items[0].children).toHaveLength(1);
    expect(list.items[0].children[0].items).toHaveLength(1);
  });

  test('未闭合围栏：余下文本按代码块解析（流式不闪断）', () => {
    const blocks = parseBlocks('```ts\nconst x = ');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'code',
      lang: 'ts',
      code: 'const x = ',
    });
  });
});

describe('highlight（代码块高亮）', () => {
  test('ts：关键字 / 字符串 / 注释有颜色，未知语言按纯文本', () => {
    const lines = highlight('const x = "hi";\n// 注释', 'ts');
    expect(lines).toHaveLength(2);
    expect(lines[0].find((t) => t.text === 'const')?.color).toBe('yellow');
    expect(lines[0].find((t) => t.text === '"hi"')?.color).toBe('green');
    expect(lines[1].find((t) => t.text.startsWith('//'))?.color).toBe('gray');

    const plain = highlight('const x = 1;', 'cobol');
    expect(plain[0].every((t) => t.color === undefined)).toBe(true);
  });

  test('json：键 / 字符串 / 数字区分', () => {
    const lines = highlight('{"a": 1, "b": "x"}', 'json');
    expect(lines[0].find((t) => t.text === '"a"')?.color).toBe('cyan');
    expect(lines[0].find((t) => t.text === '"x"')?.color).toBe('green');
    expect(lines[0].find((t) => t.text === '1')?.color).toBe('magenta');
  });

  test('bash：关键字 / 内置命令 / 变量', () => {
    const lines = highlight('if [[ -f x ]]; then echo $HOME; fi', 'bash');
    expect(lines[0].find((t) => t.text === 'if')?.color).toBe('yellow');
    expect(lines[0].find((t) => t.text === 'echo')?.color).toBe('blue');
    expect(lines[0].find((t) => t.text === '$HOME')?.color).toBe('cyan');
  });

  test('tsx：JSX 标签 / 属性 / 字符串', () => {
    const lines = highlight('<Foo bar="baz">text</Foo>', 'tsx');
    expect(lines[0].find((t) => t.text === 'Foo')?.color).toBe('blue');
    expect(lines[0].find((t) => t.text === 'bar')?.color).toBe('cyan');
    expect(lines[0].find((t) => t.text === '"baz"')?.color).toBe('green');
  });

  test('流式未闭合字符串不崩（按字符串色渲染到文末）', () => {
    const lines = highlight('const s = "hi', 'ts');
    expect(lines[0].some((t) => t.color === 'green')).toBe(true);
  });
});

describe('FrameThrottle（帧节流合并）', () => {
  test('窗口内多次 append 合并为一次提交', async () => {
    const commits: string[] = [];
    const throttle = new FrameThrottle((text) => commits.push(text), 30);
    for (let i = 0; i < 200; i++) throttle.append('x');
    // 窗口未到：只累积不提交
    expect(throttle.pendingText).toBe('x'.repeat(200));
    await sleep(80); // 远超 30ms 窗口
    expect(commits).toEqual(['x'.repeat(200)]);
    expect(throttle.pendingText).toBe('');
  });

  test('commit 立即提交累积文本（帧尾 / 结束语义）', () => {
    const commits: string[] = [];
    const throttle = new FrameThrottle((text) => commits.push(text), 60);
    throttle.append('a');
    throttle.append('b');
    throttle.commit();
    expect(commits).toEqual(['ab']);
    expect(throttle.pendingText).toBe('');
  });

  test('commit 幂等：空缓冲不重复提交', () => {
    const commits: string[] = [];
    const throttle = new FrameThrottle((text) => commits.push(text), 20);
    throttle.commit();
    throttle.commit();
    expect(commits).toEqual([]);
  });

  test('多轮窗口各自合并一次', async () => {
    const commits: string[] = [];
    const throttle = new FrameThrottle((text) => commits.push(text), 20);
    throttle.append('1');
    await sleep(50);
    throttle.append('2');
    throttle.append('3');
    await sleep(50);
    expect(commits).toEqual(['1', '23']);
  });
});

describe('useFrameThrottledText（流式中间态可见 + 合并提交）', () => {
  afterAll(() => {
    cleanup();
  });

  test('多次 append 在帧窗口后合并可见；继续流式追加可见中间态', async () => {
    let api: { append: (d: string) => void; flush: () => void } | null = null;
    function Harness(): ReactElement {
      const { text, append, flush } = useFrameThrottledText(20);
      api = { append, flush };
      return <Text>{text.length > 0 ? text : '(空)'}</Text>;
    }
    const { lastFrame, unmount } = render(<Harness />);
    await frameReady();
    expect(lastFrame() ?? '').toContain('(空)');

    api!.append('你');
    api!.append('好');
    await sleep(60); // 超过 20ms 帧窗口
    expect(lastFrame() ?? '').toContain('你好');

    // 流式中间态：继续追加新段，窗口后可见
    api!.append('世');
    await sleep(60);
    expect(lastFrame() ?? '').toContain('你好世');

    unmount();
  });

  test('flush 立即提交（帧尾语义）', async () => {
    let api: { append: (d: string) => void; flush: () => void } | null = null;
    function Harness(): ReactElement {
      const { text, append, flush } = useFrameThrottledText(60);
      api = { append, flush };
      return <Text>{text.length > 0 ? text : '(空)'}</Text>;
    }
    const { lastFrame, unmount } = render(<Harness />);
    await frameReady();

    api!.append('终');
    api!.flush();
    await sleep(30);
    expect(lastFrame() ?? '').toContain('终');

    unmount();
  });

  test('默认帧窗口为 50ms（任务要求 30–60ms）', () => {
    expect(DEFAULT_FRAME_MS).toBeGreaterThanOrEqual(30);
    expect(DEFAULT_FRAME_MS).toBeLessThanOrEqual(60);
  });
});

describe('Markdown 渲染（Ink 输出帧）', () => {
  afterAll(() => {
    cleanup();
  });

  test('标题/粗体/行内代码/列表/代码块渲染出对应内容', async () => {
    const { lastFrame, unmount } = render(
      <Markdown
        text={
          '# 标题\n\n**加粗** 和 `code`\n\n- 甲\n- 乙\n\n```ts\nconst x = 1;\n```'
        }
      />,
    );
    await frameReady();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('# 标题');
    expect(frame).toContain('加粗');
    expect(frame).toContain('code');
    expect(frame).toContain('甲');
    expect(frame).toContain('乙');
    expect(frame).toContain('const x = 1;');
    unmount();
  });

  test('代码块按语言标注（围栏 lang 显示在代码块内）', async () => {
    const { lastFrame, unmount } = render(
      <Markdown text={'```bash\necho hi\n```'} />,
    );
    await frameReady();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('bash');
    expect(frame).toContain('echo hi');
    unmount();
  });

  test('流式未闭合代码块不崩溃（中途渲染）', async () => {
    const { lastFrame, unmount } = render(
      <Markdown text={'```ts\nconst x = "hi'} />,
    );
    await frameReady();
    expect(lastFrame() ?? '').toContain('const');
    unmount();
  });

  test('流式未闭合加粗按字面渲染不崩溃', async () => {
    const { lastFrame, unmount } = render(<Markdown text={'**未闭合'} />);
    await frameReady();
    expect(lastFrame() ?? '').toContain('未闭合');
    unmount();
  });
});
