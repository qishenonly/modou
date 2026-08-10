/**
 * parseGitStatus 单元测试（纯函数，不依赖 electron）。
 */
import { describe, expect, test } from 'bun:test';
import { parseGitStatus } from '../electron/gitparse';

describe('parseGitStatus（porcelain + numstat 合并）', () => {
  test('空输入返回空数组', () => {
    expect(parseGitStatus('', '', '')).toEqual([]);
  });

  test('staged 新增：A  src/a.ts 行数来自 staged numstat', () => {
    const entries = parseGitStatus('A  src/a.ts\n', '', '10\t0\tsrc/a.ts\n');
    expect(entries).toEqual([
      { path: 'src/a.ts', status: 'A ', staged: true, added: 10, deleted: 0 },
    ]);
  });

  test('staged 新增但无 numstat 项：行数归 0', () => {
    const entries = parseGitStatus('A  src/a.ts\n', '', '');
    expect(entries).toEqual([
      { path: 'src/a.ts', status: 'A ', staged: true, added: 0, deleted: 0 },
    ]);
  });

  test('unstaged 修改： M src/b.ts 且 numstat 给行数', () => {
    const entries = parseGitStatus(' M src/b.ts\n', '5\t1\tsrc/b.ts\n', '');
    expect(entries).toEqual([
      { path: 'src/b.ts', status: ' M', staged: false, added: 5, deleted: 1 },
    ]);
  });

  test('untracked：?? notes.md 无 numstat 项', () => {
    const entries = parseGitStatus('?? notes.md\n', '', '');
    expect(entries).toEqual([
      { path: 'notes.md', status: '??', staged: false, added: 0, deleted: 0 },
    ]);
  });

  test('重命名：R  old.ts -> new.ts 取箭头后路径', () => {
    const entries = parseGitStatus(
      'R  old.ts -> new.ts\n',
      '',
      '0\t0\tnew.ts\n',
    );
    expect(entries).toEqual([
      { path: 'new.ts', status: 'R ', staged: true, added: 0, deleted: 0 },
    ]);
  });

  test('重命名 numstat 用 `old => new` 形式时也能归一到新路径', () => {
    const entries = parseGitStatus(
      'R  old.ts -> new.ts\n',
      '',
      '3\t4\told.ts => new.ts\n',
    );
    expect(entries).toEqual([
      { path: 'new.ts', status: 'R ', staged: true, added: 3, deleted: 4 },
    ]);
  });

  test('staged 与 unstaged 同时存在：行数优先取 staged', () => {
    const entries = parseGitStatus(
      'MM src/c.ts\n',
      '1\t2\tsrc/c.ts\n',
      '3\t4\tsrc/c.ts\n',
    );
    expect(entries).toEqual([
      { path: 'src/c.ts', status: 'MM', staged: true, added: 3, deleted: 4 },
    ]);
  });

  test('path 含空格：numstat 取第二个 tab 之后的部分', () => {
    const entries = parseGitStatus(
      ' M src/my file.ts\n',
      '1\t1\tsrc/my file.ts\n',
      '',
    );
    expect(entries).toEqual([
      {
        path: 'src/my file.ts',
        status: ' M',
        staged: false,
        added: 1,
        deleted: 1,
      },
    ]);
  });

  test('忽略空行', () => {
    const entries = parseGitStatus(
      'A  a.ts\n\nM  b.ts\n',
      '1\t1\tb.ts\n',
      '2\t2\ta.ts\n',
    );
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.path)).toEqual(['a.ts', 'b.ts']);
  });
});
