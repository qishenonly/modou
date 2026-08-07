import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { ProtocolEvent } from '../protocol/events';
import { ApprovalGate } from './approval';
import { matchRule, ruleMatches } from './rules';
import type { PermissionRule } from './rules';
import { decidePermission } from './policy';
import type {
  ApprovalPolicy,
  PermissionConfig,
  PermissionRequest,
  SandboxScope,
} from './policy';
import { runToolPipeline } from '../tools/pipeline';
import { ToolRegistry } from '../tools/registry';
import type { Tool } from '../tools/types';

/**
 * T-052 规则表测试（离线）：allow/deny 命令前缀匹配 + 内置危险命令黑名单的
 * 叠加语义（design 002 6.1 裁决顺序，kickoff 0.5.0 3.1）。
 *
 * 覆盖：
 * - 匹配单元：命令前缀 / 工具名整串 / 路径分隔符边界 / tool 限定 / 命令归一；
 * - 裁决顺序接入：deny 命中拒绝（即使 never 策略 / autoApprove）、allow 命中
 *   放行、allow 不能推翻危险黑名单 / 目录边界 / read-only 沙箱、deny > allow；
 * - ApprovalGate 接入：deny 直通不弹窗、allow 直通不弹窗；
 * - 管线 ③ Authorize 集成：deny 规则命中 → 策略性拒绝回喂模型。
 */

const PROJECT_ROOT = '/repo';

/** 构造权限配置（projectRoot 固定 /repo）。 */
function cfg(
  sandbox: SandboxScope,
  policy: ApprovalPolicy,
  rules: readonly PermissionRule[] = [],
): PermissionConfig {
  return { sandbox, policy, projectRoot: PROJECT_ROOT, rules };
}

/** bash exec 请求。 */
function execReq(command: string): PermissionRequest {
  return { toolName: 'bash', risk: 'exec', args: { command } };
}

/** 写请求（目标路径）。 */
function writeReq(path: string): PermissionRequest {
  return { toolName: 'write', risk: 'write', args: { path, content: 'x' } };
}

/** 读请求（目标路径）。 */
function readReq(path: string): PermissionRequest {
  return { toolName: 'read', risk: 'read', args: { path } };
}

// ---------------------------------------------------------------------------
// 匹配单元（rules.ts ruleMatches / matchRule）
// ---------------------------------------------------------------------------

describe('ruleMatches / matchRule：匹配语义', () => {
  test('命令前缀匹配：git status 命中 git status -s，不命中 git push', () => {
    const rule: PermissionRule = { effect: 'allow', match: 'git status' };
    expect(ruleMatches(rule, execReq('git status -s'))).toBe(true);
    expect(ruleMatches(rule, execReq('git status'))).toBe(true);
    expect(ruleMatches(rule, execReq('git push origin main'))).toBe(false);
  });

  test('工具名整串匹配：match "write" 命中全部 write 调用（任意 path）', () => {
    const rule: PermissionRule = { effect: 'deny', match: 'write' };
    expect(ruleMatches(rule, writeReq('/repo/a.ts'))).toBe(true);
    expect(ruleMatches(rule, writeReq('/etc/passwd'))).toBe(true);
    // 工具名是整串匹配：read 工具 / 无关 path 不命中
    expect(ruleMatches(rule, readReq('/repo/a.ts'))).toBe(false);
    // match 也是命令前缀：bash 命令以 write 开头同样命中（deny 多拦是 fail-closed 安全侧）
    expect(ruleMatches(rule, execReq('write a note'))).toBe(true);
  });

  test('路径前缀匹配：分隔符边界（/repo/src 命中 /repo/src/a.ts，不误命中 /repo/src2）', () => {
    const rule: PermissionRule = { effect: 'allow', match: '/repo/src' };
    expect(ruleMatches(rule, writeReq('/repo/src/a.ts'))).toBe(true);
    expect(ruleMatches(rule, writeReq('/repo/src'))).toBe(true);
    expect(ruleMatches(rule, writeReq('/repo/src2/a.ts'))).toBe(false);
    expect(ruleMatches(rule, writeReq('/repo/src-other/a.ts'))).toBe(false);
  });

  test('tool 限定：规则只作用于指定工具', () => {
    // read 工具的 deny 规则：命中 read，不影响同路径的 write
    const denyReadSecret: PermissionRule = {
      effect: 'deny',
      match: '/repo/secret',
      tool: 'read',
    };
    expect(ruleMatches(denyReadSecret, readReq('/repo/secret/x.txt'))).toBe(
      true,
    );
    expect(ruleMatches(denyReadSecret, writeReq('/repo/secret/x.txt'))).toBe(
      false,
    );
    // bash 的 deny 规则：不影响 write 工具
    const denyBashGit: PermissionRule = {
      effect: 'deny',
      match: 'git status',
      tool: 'bash',
    };
    expect(ruleMatches(denyBashGit, execReq('git status -s'))).toBe(true);
    expect(ruleMatches(denyBashGit, writeReq('/repo/git status'))).toBe(false);
  });

  test('命令归一：rm -rf 命中 sudo 前缀与折叠空白，与 danger.ts 同一份实现', () => {
    const rule: PermissionRule = { effect: 'deny', match: 'rm -rf' };
    expect(ruleMatches(rule, execReq('rm -rf /repo/tmp'))).toBe(true);
    expect(ruleMatches(rule, execReq('sudo rm -rf /repo/tmp'))).toBe(true);
    expect(ruleMatches(rule, execReq('rm  -rf  /repo/tmp'))).toBe(true);
  });

  test('防御性：空 match / 非法 effect 不命中', () => {
    expect(
      ruleMatches({ effect: 'deny', match: '' }, execReq('rm -rf /x')),
    ).toBe(false);
    expect(
      ruleMatches({ effect: 'deny', match: '   ' }, execReq('rm -rf /x')),
    ).toBe(false);
    // matchRule 按 effect 过滤：非法 effect 的规则不参与任何一方
    expect(
      matchRule(
        execReq('rm -rf /x'),
        [
          { effect: 'deny', match: 'rm -rf' },
          { effect: 'allow', match: 'rm -rf' },
        ],
        'deny',
      ),
    ).toBe(true);
    expect(
      matchRule(
        execReq('rm -rf /x'),
        [{ effect: 'allow', match: 'rm -rf' }],
        'deny',
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 裁决顺序接入（policy.ts decidePermission）
// ---------------------------------------------------------------------------

describe('decidePermission × 规则表：裁决顺序（deny ① > 危险黑名单 ② > 沙箱 ③ > allow ④ > 策略 ⑤）', () => {
  test('deny 命中拒绝：即使 never 策略 / autoApprove 语义', () => {
    // never 策略：默认放手，但 deny 规则仍然拒绝
    expect(
      decidePermission(
        execReq('npm run test'),
        cfg('workspace-write', 'never', [{ effect: 'deny', match: 'npm run' }]),
      ),
    ).toBe('deny');
    // read-only 沙箱：read 也问的组合下 deny 优先
    expect(
      decidePermission(
        readReq('/repo/a.ts'),
        cfg('read-only', 'never', [{ effect: 'deny', match: 'read' }]),
      ),
    ).toBe('deny');
    // full-access + never：完全放手组合下 deny 仍拒绝
    expect(
      decidePermission(
        writeReq('/repo/a.ts'),
        cfg('full-access', 'never', [{ effect: 'deny', match: 'write' }]),
      ),
    ).toBe('deny');
  });

  test('allow 命中放行：默认组合下原本要问的 exec 直通', () => {
    // 默认组合 workspace-write + on-request：无规则时 exec 是 ask（保守近似）
    expect(
      decidePermission(
        execReq('git status -s'),
        cfg('workspace-write', 'on-request'),
      ),
    ).toBe('ask');
    // allow 规则命中 → 放行审批策略层
    expect(
      decidePermission(
        execReq('git status -s'),
        cfg('workspace-write', 'on-request', [
          { effect: 'allow', match: 'git status' },
        ]),
      ),
    ).toBe('allow');
  });

  test('allow 不能推翻危险命令黑名单：rm -rf 仍强制确认', () => {
    // 即使 allow 规则匹配 rm -rf、never 策略完全放手，危险黑名单（②）仍先于
    // allow（④）强制 ask——「我信任 agent」≠「我同意 rm -rf」
    expect(
      decidePermission(
        execReq('rm -rf /repo/tmp'),
        cfg('workspace-write', 'never', [{ effect: 'allow', match: 'rm -rf' }]),
      ),
    ).toBe('ask');
    expect(
      decidePermission(
        execReq('rm -rf /repo/tmp'),
        cfg('full-access', 'never', [{ effect: 'allow', match: 'rm -rf' }]),
      ),
    ).toBe('ask');
  });

  test('allow 不能推翻目录边界：allow /etc 后写 /etc/passwd 仍转 ask', () => {
    expect(
      decidePermission(
        writeReq('/etc/passwd'),
        cfg('workspace-write', 'never', [{ effect: 'allow', match: '/etc' }]),
      ),
    ).toBe('ask');
  });

  test('allow 不能推翻 read-only 沙箱：read-only 下 exec 即使 allow 规则也 deny', () => {
    expect(
      decidePermission(
        execReq('git status'),
        cfg('read-only', 'never', [{ effect: 'allow', match: 'bash' }]),
      ),
    ).toBe('deny');
  });

  test('deny > allow：同前缀同时命中时 deny 优先（裁决顺序 ① 先于 ④）', () => {
    const rules: readonly PermissionRule[] = [
      { effect: 'allow', match: 'git' },
      { effect: 'deny', match: 'git push' },
    ];
    // git push 命中 deny → 拒绝
    expect(
      decidePermission(
        execReq('git push origin main'),
        cfg('workspace-write', 'never', rules),
      ),
    ).toBe('deny');
    // git status 只命中 allow → 放行
    expect(
      decidePermission(
        execReq('git status -s'),
        cfg('workspace-write', 'on-request', rules),
      ),
    ).toBe('allow');
  });

  test('workspace-write 越界 + deny：deny 优先返回拒绝（不降级为 ask）', () => {
    // 越界目标本应转 ask（边界 ③），但 deny 规则（①）直接拒绝
    expect(
      decidePermission(
        writeReq('/etc/passwd'),
        cfg('workspace-write', 'never', [{ effect: 'deny', match: '/etc' }]),
      ),
    ).toBe('deny');
  });

  test('tool 限定的 allow：只放行限定工具的写', () => {
    // 限定 tool: write，路径 /repo/src 前缀放行 write；同前缀的 read 不受影响
    const config = cfg('workspace-write', 'on-request', [
      { effect: 'allow', match: '/repo/src', tool: 'write' },
    ]);
    expect(decidePermission(writeReq('/repo/src/a.ts'), config)).toBe('allow');
    // read 本就放行，此处断言 read 不受 write 的 allow 规则影响（仍按矩阵）
    expect(decidePermission(readReq('/repo/src/a.ts'), config)).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// ApprovalGate 接入：deny 直通不弹窗 / allow 直通不弹窗
// ---------------------------------------------------------------------------

function collect(): {
  events: ProtocolEvent[];
  emit: (e: ProtocolEvent) => void;
} {
  const events: ProtocolEvent[] = [];
  return { events, emit: (e) => events.push(e) };
}

function approvalEvents(events: ProtocolEvent[]): ProtocolEvent[] {
  return events.filter(
    (e) => e.type === 'approval_request' || e.type === 'approval_resolved',
  );
}

describe('ApprovalGate × 规则表（T-052 接入）', () => {
  test('deny 规则命中：即使 decider 始终 allow_once（autoApprove 语义）也直接拒绝，不发事件', async () => {
    let calls = 0;
    const gate = new ApprovalGate({
      decider: async () => {
        calls += 1;
        return { decision: 'allow_once', source: 'policy' };
      },
      permission: cfg('workspace-write', 'never', [
        { effect: 'deny', match: 'npm run' },
      ]),
    });
    const { events, emit } = collect();
    const decision = await gate.requestApproval(
      {
        toolName: 'bash',
        risk: 'exec',
        description: '执行命令：npm run test',
        command: 'npm run test',
        prefix: 'npm run test',
        args: { command: 'npm run test' },
      },
      emit,
    );
    expect(decision).toBe('deny');
    expect(calls).toBe(0); // deny 直通，decider 不被调用
    expect(approvalEvents(events)).toHaveLength(0);
  });

  test('allow 规则命中：默认组合下原本要问的 exec 直通放行，不发事件', async () => {
    let calls = 0;
    const gate = new ApprovalGate({
      decider: async () => {
        calls += 1;
        return { decision: 'deny', source: 'user' };
      },
      permission: cfg('workspace-write', 'on-request', [
        { effect: 'allow', match: 'git status' },
      ]),
    });
    const { events, emit } = collect();
    const decision = await gate.requestApproval(
      {
        toolName: 'bash',
        risk: 'exec',
        description: '执行命令：git status -s',
        command: 'git status -s',
        prefix: 'git status -s',
        args: { command: 'git status -s' },
      },
      emit,
    );
    expect(decision).toBe('allow_once');
    expect(calls).toBe(0); // allow 直通，decider 不被调用
    expect(approvalEvents(events)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 管线 ③ Authorize 集成（runToolPipeline × 规则表）
// ---------------------------------------------------------------------------

/** 测试用 write 工具（risk: write，不真的落盘）。 */
const writeStub: Tool = {
  name: 'write-stub',
  description: '写入（测试用）',
  risk: 'write',
  schema: z.object({ path: z.string().min(1), content: z.string() }),
  execute: async () => ({ ok: true, forModel: '已写入（stub）' }),
};

describe('runToolPipeline × 规则表（T-052 集成）', () => {
  test('deny 规则命中：工具被拒回「被拒绝，别重试」，事件流无审批对', async () => {
    const gate = new ApprovalGate({
      decider: async () => ({ decision: 'allow_once', source: 'policy' }),
      permission: cfg('workspace-write', 'never', [
        { effect: 'deny', match: 'write-stub' },
      ]),
    });
    const { events, emit } = collect();
    const outcome = await runToolPipeline(
      {
        id: 'call-1',
        name: 'write-stub',
        input: { path: '/a.ts', content: 'x' },
      },
      {
        registry: new ToolRegistry().register(writeStub),
        authorize: gate,
        emit,
      },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('被拒绝');
    expect(outcome.forModel).toContain('别重试');
    // deny 直通：不发 approval_request / approval_resolved
    expect(approvalEvents(events)).toHaveLength(0);
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'tool_result']);
  });
});
