import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ApprovalGate } from './approval';
import {
  expandHome,
  isWithinRoot,
  resolveAllowedPath,
  resolveRealPathSync,
} from './paths';
import { decidePermission } from './policy';
import type { PermissionConfig, PermissionRequest } from './policy';
import { runToolPipeline } from '../tools/pipeline';
import { ToolRegistry } from '../tools/registry';
import type { Tool } from '../tools/types';

/**
 * T-051 目录边界渗透式对抗测试（design 002 6.2 / kickoff 0.5.0 3.2）。
 *
 * 用真实临时目录 + 真实符号链接构造攻击面，覆盖：
 * - 写工作目录外文件被拒；
 * - `../../` 路径逃逸被拒；
 * - 符号链接逃逸（工作区内软链指向 /etc 或外部目录）被拒；
 * - 符号链接后的 `..` 按 POSIX 语义解析（link → /etc 时 `link/../x` 等价 `/x`）；
 * - `--add-dir` 白名单内放行、白名单外仍拒；
 * - realpath 归一：软链路径 vs 真实路径解析到同一目标；
 * - `~` 展开；
 * - 前缀碰撞（/workspace2 不误命中 /workspace）；
 * - decidePermission 与管线 ③ Authorize 的集成（越界 → ask → 审批拦截）。
 *
 * 每条用例都必须在真实文件系统上验证（字符串前缀近似会全部漏网）。
 */

/** 本次用例的临时沙箱（beforeEach 建立，afterEach 清理）。 */
let sandbox: string;
/** 工作区根（projectRoot）。 */
let ws: string;
/** 工作区外的目录（工作区的平级兄弟）。 */
let outside: string;

/** 建立沙箱：workspace / outside，以及指向外部的软链。 */
beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'modou-paths-'));
  ws = join(sandbox, 'workspace');
  outside = join(sandbox, 'outside');
  await mkdir(ws);
  await mkdir(outside);
  await writeFile(join(ws, 'inside.txt'), 'inside');
  await writeFile(join(outside, 'secret.txt'), 'secret');
  // 工作区内的两个逃逸软链：一个指向 /etc，一个指向工作区外的兄弟目录
  await symlink('/etc', join(ws, 'link-to-etc'), 'dir');
  await symlink(outside, join(ws, 'link-to-outside'), 'dir');
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

/** 工作区写请求（permission 矩阵用）。 */
function writeReq(path: string): PermissionRequest {
  return { toolName: 'write', risk: 'write', args: { path, content: 'x' } };
}

/** bash exec 请求（可带 cwd）。 */
function execReq(command: string, cwd?: string): PermissionRequest {
  const args: Record<string, unknown> = { command };
  if (cwd !== undefined) args.cwd = cwd;
  return { toolName: 'bash', risk: 'exec', args };
}

/** workspace-write 沙箱配置（never 策略，可带 addDirs）。 */
function wsConfig(overrides: Partial<PermissionConfig> = {}): PermissionConfig {
  return {
    sandbox: 'workspace-write',
    policy: 'never',
    projectRoot: ws,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveAllowedPath：目录边界单元（真实文件系统）
// ---------------------------------------------------------------------------

describe('resolveAllowedPath：工作区内 / 外判定', () => {
  test('工作区内路径：inside=true，realPath 为绝对路径', () => {
    const r = resolveAllowedPath(join(ws, 'inside.txt'), wsConfig());
    expect(r.inside).toBe(true);
    expect(r.realPath).toBe(join(ws, 'inside.txt'));
    expect(r.allowedRoot).toBe(resolveRealPathSync(ws) ?? ws);
  });

  test('工作区根本身：inside=true（rel === root 的情形）', () => {
    expect(resolveAllowedPath(ws, wsConfig()).inside).toBe(true);
  });

  test('相对路径按工作区根解析：sub/../inside.txt 归一后仍在内', () => {
    const r = resolveAllowedPath('sub/../inside.txt', wsConfig());
    expect(r.inside).toBe(true);
    expect(r.realPath).toBe(join(ws, 'inside.txt'));
  });

  test('写工作区外绝对路径：拒绝（outside）', () => {
    const r = resolveAllowedPath(join(outside, 'secret.txt'), wsConfig());
    expect(r.inside).toBe(false);
    expect(r.reason).toBe('outside');
  });

  test('`../../` 路径逃逸：拒绝', () => {
    // join 会把 `..` 文本折叠：workspace/../../outside 落在 sandbox 的上一级
    const r = resolveAllowedPath(
      join(ws, '../../outside/secret.txt'),
      wsConfig(),
    );
    expect(r.inside).toBe(false);
    expect(r.reason).toBe('outside');
    expect(r.realPath).toBe(
      resolveRealPathSync(join(sandbox, '..', 'outside', 'secret.txt')) ?? '',
    );
  });

  test('相对 `../` 逃逸：拒绝', () => {
    expect(resolveAllowedPath('../outside/secret.txt', wsConfig()).inside).toBe(
      false,
    );
  });

  test('符号链接逃逸（工作区内软链 → /etc）：拒绝', () => {
    const r = resolveAllowedPath(join(ws, 'link-to-etc/passwd'), wsConfig());
    expect(r.inside).toBe(false);
    expect(r.realPath).toBe('/etc/passwd');
  });

  test('符号链接逃逸（工作区内软链 → 工作区外兄弟目录）：拒绝', () => {
    const r = resolveAllowedPath(
      join(ws, 'link-to-outside/secret.txt'),
      wsConfig(),
    );
    expect(r.inside).toBe(false);
    expect(r.realPath).toBe(join(outside, 'secret.txt'));
  });

  test('符号链接后的 `..` 按 POSIX 解析：link → /etc 时 link/../x 等价 /x', () => {
    // 用字符串拼接而非 join：join 会把 link-to-etc/.. 文本折叠，破坏要测的
    // 「`..` 相对符号链接目标」语义（真实工具收到绝对路径时同样保持原样）
    const raw = `${ws}/link-to-etc/../x`;
    const r = resolveAllowedPath(raw, wsConfig());
    expect(r.inside).toBe(false);
    expect(r.realPath).toBe('/x');
  });

  test('写新文件（目标不存在、父目录存在）：父目录链上的软链仍被归一', () => {
    // 新文件在软链内部 → 越界；新文件在工作区内普通目录 → 在内
    const viaLink = resolveAllowedPath(
      join(ws, 'link-to-outside/new-dir/new-file.txt'),
      wsConfig(),
    );
    expect(viaLink.inside).toBe(false);
    expect(viaLink.realPath).toBe(join(outside, 'new-dir/new-file.txt'));

    const inWs = resolveAllowedPath(
      join(ws, 'brand-new/deep/file.txt'),
      wsConfig(),
    );
    expect(inWs.inside).toBe(true);
    expect(inWs.realPath).toBe(join(ws, 'brand-new/deep/file.txt'));
  });

  test('前缀碰撞不误判：/workspace2 不算工作区内', async () => {
    const sibling = join(sandbox, 'workspace2');
    await mkdir(sibling);
    const r = resolveAllowedPath(join(sibling, 'x.txt'), wsConfig());
    expect(r.inside).toBe(false);
  });

  test('空路径 / 空 projectRoot：ok=false 可诊断', () => {
    const empty = resolveAllowedPath('', wsConfig());
    expect(empty.ok).toBe(false);
    expect(empty.reason).toBe('empty_path');

    const noRoot = resolveAllowedPath(join(ws, 'a.txt'), {
      ...wsConfig(),
      projectRoot: '',
    });
    expect(noRoot.ok).toBe(false);
    expect(noRoot.reason).toBe('missing_root');
  });

  test('workspace 根指向不存在目录时也按文本规范化判定（不抛异常）', () => {
    const phantom = join(sandbox, 'phantom');
    const r = resolveAllowedPath(
      join(phantom, 'x.txt'),
      wsConfig({ projectRoot: phantom }),
    );
    // phantom 不存在 → 目标归一为 phantom/x.txt，与根前缀一致 → 在内（fail-open 于
    // 「根本身不存在」的场景；写工具执行时仍会因 ENOENT 失败，这不构成逃逸面）
    expect(r.inside).toBe(true);
  });
});

describe('resolveAllowedPath：--add-dir 白名单', () => {
  test('白名单内路径放行', () => {
    const config = wsConfig({ addDirs: [outside] });
    const r = resolveAllowedPath(join(outside, 'secret.txt'), config);
    expect(r.inside).toBe(true);
    expect(r.allowedRoot).toBe(resolveRealPathSync(outside) ?? outside);
  });

  test('白名单内软链路径与真实路径解析到同一目标（realpath 归一一致）', () => {
    const config = wsConfig({ addDirs: [outside] });
    const viaLink = resolveAllowedPath(
      join(ws, 'link-to-outside/secret.txt'),
      config,
    );
    const direct = resolveAllowedPath(join(outside, 'secret.txt'), config);
    expect(viaLink.inside).toBe(true);
    expect(direct.inside).toBe(true);
    expect(viaLink.realPath).toBe(direct.realPath);
  });

  test('白名单之外的兄弟目录仍拒绝', async () => {
    const other = join(sandbox, 'other');
    await mkdir(other);
    const config = wsConfig({ addDirs: [outside] });
    expect(resolveAllowedPath(join(other, 'x.txt'), config).inside).toBe(false);
  });
});

describe('resolveAllowedPath：~ 展开', () => {
  test('expandHome：~ 与 ~/... 展开为家目录', () => {
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('~/foo/bar.ts')).toBe(join(homedir(), 'foo/bar.ts'));
    expect(expandHome('/abs/path')).toBe('/abs/path'); // 非 ~ 不动
  });

  test('~ 路径经边界校验：projectRoot=家目录时 ~/x 在内', () => {
    const config = wsConfig({ projectRoot: homedir() });
    const r = resolveAllowedPath('~/foo/bar.txt', config);
    expect(r.inside).toBe(true);
    expect(r.realPath).toBe(join(homedir(), 'foo/bar.txt'));
  });
});

describe('isWithinRoot：边界语义', () => {
  test('根相等为 true；子路径为 true；兄弟前缀为 false；根为 / 时全 true', () => {
    expect(isWithinRoot('/a/b', '/a')).toBe(true);
    expect(isWithinRoot('/a', '/a')).toBe(true);
    expect(isWithinRoot('/ab/c', '/a')).toBe(false); // /ab 不是 /a 的子路径
    expect(isWithinRoot('/etc/passwd', '/')).toBe(true); // 工作区即文件系统根
  });
});

// ---------------------------------------------------------------------------
// decidePermission：渗透式矩阵（真实文件系统）
// ---------------------------------------------------------------------------

describe('decidePermission × 目录边界（workspace-write + never，真实路径）', () => {
  test('工作区内写：放行', () => {
    expect(decidePermission(writeReq(join(ws, 'inside.txt')), wsConfig())).toBe(
      'allow',
    );
  });

  test('写工作区外文件：ask（沙箱范围外，需显式确认）', () => {
    expect(
      decidePermission(writeReq(join(outside, 'secret.txt')), wsConfig()),
    ).toBe('ask');
  });

  test('`../../` 路径逃逸：ask', () => {
    expect(
      decidePermission(
        writeReq(join(ws, '../../outside/secret.txt')),
        wsConfig(),
      ),
    ).toBe('ask');
  });

  test('符号链接逃逸（→ /etc 与 → 外部目录）：ask', () => {
    expect(
      decidePermission(writeReq(join(ws, 'link-to-etc/passwd')), wsConfig()),
    ).toBe('ask');
    expect(
      decidePermission(
        writeReq(join(ws, 'link-to-outside/secret.txt')),
        wsConfig(),
      ),
    ).toBe('ask');
  });

  test('--add-dir 白名单内：放行；白名单外仍 ask', async () => {
    const withAdd = wsConfig({ addDirs: [outside] });
    expect(
      decidePermission(writeReq(join(outside, 'secret.txt')), withAdd),
    ).toBe('allow');
    // 软链路径经白名单放行（realpath 归一一致）
    expect(
      decidePermission(
        writeReq(join(ws, 'link-to-outside/secret.txt')),
        withAdd,
      ),
    ).toBe('allow');
    const other = join(sandbox, 'other');
    await mkdir(other);
    expect(decidePermission(writeReq(join(other, 'x.txt')), withAdd)).toBe(
      'ask',
    );
  });

  test('bash 命令无 path：近似放行（002 6.3 诚实记录，命令文本不做静态解析）', () => {
    expect(decidePermission(execReq('echo hi'), wsConfig())).toBe('allow');
    expect(
      decidePermission(execReq('cat ../../outside/secret.txt'), wsConfig()),
    ).toBe('allow'); // 静态解析有局限，本版不拦命令文本内的路径
  });

  test('bash 显式 cwd 越界：ask（进程工作目录不能放到工作区外）', () => {
    expect(
      decidePermission(
        execReq('echo hi', join(outside, 'secret.txt')),
        wsConfig(),
      ),
    ).toBe('ask');
    expect(decidePermission(execReq('echo hi', ws), wsConfig())).toBe('allow');
  });

  test('full-access + never：完全放手，不做边界检查', () => {
    const full = {
      sandbox: 'full-access' as const,
      policy: 'never' as const,
      projectRoot: ws,
    };
    expect(decidePermission(writeReq(join(outside, 'secret.txt')), full)).toBe(
      'allow',
    );
  });
});

// ---------------------------------------------------------------------------
// 管线 ③ Authorize 集成：带 path 工具按边界裁决
// ---------------------------------------------------------------------------

/** 测试用 write 工具（risk: write，不真的落盘）。 */
const writeStub: Tool = {
  name: 'write-stub',
  description: '写入（测试用）',
  risk: 'write',
  schema: z.object({ path: z.string().min(1), content: z.string() }),
  execute: async () => ({ ok: true, forModel: '已写入（stub）' }),
};

function buildRegistry(): ToolRegistry {
  return new ToolRegistry().register(writeStub);
}

describe('管线 ③ Authorize × 目录边界', () => {
  test('工作区内写：矩阵 allow 直通执行，无审批事件', async () => {
    let calls = 0;
    const gate = new ApprovalGate({
      decider: async () => {
        calls += 1;
        return { decision: 'deny', source: 'user' };
      },
      permission: wsConfig(),
    });
    const events: Array<{ type: string }> = [];
    const outcome = await runToolPipeline(
      {
        id: 'c-inside',
        name: 'write-stub',
        input: { path: join(ws, 'inside.txt'), content: 'x' },
      },
      {
        registry: buildRegistry(),
        authorize: gate,
        emit: (e) => events.push(e),
      },
    );
    expect(outcome.ok).toBe(true);
    expect(calls).toBe(0); // allow 直通，decider 不被调用
    expect(events.some((e) => e.type === 'approval_request')).toBe(false);
  });

  test('越界写（符号链接逃逸）：ask → 审批 deny → 策略性拒绝', async () => {
    const gate = new ApprovalGate({
      decider: async () => ({ decision: 'deny', source: 'user' }),
      permission: wsConfig(),
    });
    const outcome = await runToolPipeline(
      {
        id: 'c-outside',
        name: 'write-stub',
        input: { path: join(ws, 'link-to-etc/passwd'), content: 'x' },
      },
      { registry: buildRegistry(), authorize: gate },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('被拒绝');
  });

  test('越界写经 --add-dir 白名单后：矩阵 allow 直通执行', async () => {
    let calls = 0;
    const gate = new ApprovalGate({
      decider: async () => {
        calls += 1;
        return { decision: 'deny', source: 'user' };
      },
      permission: wsConfig({ addDirs: [outside] }),
    });
    const outcome = await runToolPipeline(
      {
        id: 'c-adddir',
        name: 'write-stub',
        input: { path: join(outside, 'secret.txt'), content: 'x' },
      },
      { registry: buildRegistry(), authorize: gate },
    );
    expect(outcome.ok).toBe(true);
    expect(calls).toBe(0);
  });
});
