import { describe, expect, test } from 'bun:test';
import type { ProtocolEvent } from '../protocol/events';
import { ApprovalGate } from './approval';
import type { ApprovalRequestInput } from './approval';
import { decidePermission, defaultPermissionConfig } from './policy';
import type {
  ApprovalPolicy,
  PermissionConfig,
  PermissionDecision,
  PermissionRequest,
  SandboxScope,
} from './policy';

/**
 * T-050 权限内核测试（离线）：矩阵全组合 + 裁决顺序 + 危险命令强制 + 目录边界
 * 近似（T-051 占位）+ 默认组合等价 0.3.0 + ApprovalGate 接入。
 */

const PROJECT_ROOT = '/repo';

/** 构造一个正交权限配置（projectRoot 固定 /repo）。 */
function cfg(
  sandbox: SandboxScope,
  policy: ApprovalPolicy,
  overrides: Partial<PermissionConfig> = {},
): PermissionConfig {
  return { sandbox, policy, projectRoot: PROJECT_ROOT, ...overrides };
}

/** 常规写请求（目标在工作区内）。 */
const WRITE_REQ: PermissionRequest = {
  toolName: 'write',
  risk: 'write',
  args: { path: '/repo/a.ts', content: 'x' },
};

/** 常规 exec 请求（非危险命令）。 */
const EXEC_REQ: PermissionRequest = {
  toolName: 'bash',
  risk: 'exec',
  args: { command: 'npm run test' },
};

/** 常规读请求。 */
const READ_REQ: PermissionRequest = {
  toolName: 'read',
  risk: 'read',
  args: { path: '/repo/a.ts' },
};

/** 危险命令请求（rm 递归+强制，命中 danger.ts 黑名单）。 */
const DANGEROUS_REQ: PermissionRequest = {
  toolName: 'bash',
  risk: 'exec',
  args: { command: 'rm -rf /repo/tmp' },
};

const SANDBOXES: readonly SandboxScope[] = [
  'read-only',
  'workspace-write',
  'full-access',
];
const POLICIES: readonly ApprovalPolicy[] = [
  'untrusted',
  'on-request',
  'never',
];

/**
 * 矩阵期望（002 6.1 正交表，本版实现）。
 *
 * 写 / 执行（非危险、工作区内）：
 * - read-only：全部 deny（沙箱拒绝非读操作，read 类除外）；
 * - workspace-write：untrusted/on-request 都问（on-request 为保守近似），
 *   never 工作区内放行；
 * - full-access：untrusted 问，on-request 危险才问（危险已在裁决顺序 ② 强制
 *   ask，余下放行），never 完全放手。
 */
const WRITE_EXPECTED: Record<
  SandboxScope,
  Record<ApprovalPolicy, PermissionDecision>
> = {
  'read-only': { untrusted: 'deny', 'on-request': 'deny', never: 'deny' },
  'workspace-write': {
    untrusted: 'ask',
    'on-request': 'ask',
    never: 'allow',
  },
  'full-access': {
    untrusted: 'ask',
    'on-request': 'allow',
    never: 'allow',
  },
};

/** 读的期望：只有 read-only + untrusted = 「读也问」，其余全部 allow。 */
const READ_EXPECTED: Record<
  SandboxScope,
  Record<ApprovalPolicy, PermissionDecision>
> = {
  'read-only': {
    untrusted: 'ask',
    'on-request': 'allow',
    never: 'allow',
  },
  'workspace-write': {
    untrusted: 'allow',
    'on-request': 'allow',
    never: 'allow',
  },
  'full-access': {
    untrusted: 'allow',
    'on-request': 'allow',
    never: 'allow',
  },
};

describe('decidePermission：矩阵全组合（三沙箱 × 三策略 × 读/写/exec）', () => {
  test('写 / 执行：read-only 全拒；workspace-write / full-access 按策略', () => {
    for (const sandbox of SANDBOXES) {
      for (const policy of POLICIES) {
        const c = cfg(sandbox, policy);
        expect(decidePermission(WRITE_REQ, c)).toBe(
          WRITE_EXPECTED[sandbox][policy],
        );
        expect(decidePermission(EXEC_REQ, c)).toBe(
          WRITE_EXPECTED[sandbox][policy],
        );
      }
    }
  });

  test('读：read-only + untrusted 才问，其余组合不问', () => {
    for (const sandbox of SANDBOXES) {
      for (const policy of POLICIES) {
        expect(decidePermission(READ_REQ, cfg(sandbox, policy))).toBe(
          READ_EXPECTED[sandbox][policy],
        );
      }
    }
  });
});

describe('decidePermission：裁决顺序与危险命令强制', () => {
  test('危险命令优先于一切：三沙箱 × 三策略全部强制 ask', () => {
    for (const sandbox of SANDBOXES) {
      for (const policy of POLICIES) {
        // 即使 read-only（沙箱拒绝 exec）或 never（完全放手）也强制逐次确认
        expect(decidePermission(DANGEROUS_REQ, cfg(sandbox, policy))).toBe(
          'ask',
        );
      }
    }
  });

  test('never 策略下危险命令仍强制确认（「我信任 agent」≠「我同意 rm -rf /」）', () => {
    expect(
      decidePermission(DANGEROUS_REQ, cfg('workspace-write', 'never')),
    ).toBe('ask');
    expect(decidePermission(DANGEROUS_REQ, cfg('full-access', 'never'))).toBe(
      'ask',
    );
    // 对照：同一 never 配置下非危险命令放行
    expect(decidePermission(EXEC_REQ, cfg('workspace-write', 'never'))).toBe(
      'allow',
    );
  });

  test('read-only 拒绝写 / exec：三策略全 deny（非危险）', () => {
    for (const policy of POLICIES) {
      expect(decidePermission(WRITE_REQ, cfg('read-only', policy))).toBe(
        'deny',
      );
      expect(decidePermission(EXEC_REQ, cfg('read-only', policy))).toBe('deny');
    }
  });

  test('规则表占位（T-052）：deny/allow 规则本版不参与裁决', () => {
    const withRules = cfg('workspace-write', 'never', {
      rules: { deny: [{ pattern: 'write' }], allow: [{ pattern: 'read' }] },
    });
    // 规则匹配未实现（T-052），本版仍按矩阵走（deny 规则第一位结构已就位）
    expect(decidePermission(WRITE_REQ, withRules)).toBe('allow');
    expect(decidePermission(READ_REQ, withRules)).toBe('allow');
  });
});

describe('decidePermission：目录边界近似（T-051 占位）', () => {
  test('workspace-write + never：工作区内放行、边界外 ask', () => {
    const c = cfg('workspace-write', 'never');
    // 工作区内（含根目录本身）
    expect(
      decidePermission(
        { ...WRITE_REQ, args: { path: '/repo/a.ts', content: 'x' } },
        c,
      ),
    ).toBe('allow');
    expect(
      decidePermission(
        { ...WRITE_REQ, args: { path: '/repo/src/deep/a.ts', content: 'x' } },
        c,
      ),
    ).toBe('allow');
    // 越界：绝对路径在根外
    expect(
      decidePermission(
        { ...WRITE_REQ, args: { path: '/etc/passwd', content: 'x' } },
        c,
      ),
    ).toBe('ask');
    // 越界：`..` 逃逸
    expect(
      decidePermission(
        { ...WRITE_REQ, args: { path: '/repo/../outside.txt', content: 'x' } },
        c,
      ),
    ).toBe('ask');
    expect(
      decidePermission(
        { ...WRITE_REQ, args: { path: '../outside.txt', content: 'x' } },
        c,
      ),
    ).toBe('ask');
    // bash 无路径参数：本版近似放行（T-051 硬化命令级边界）
    expect(
      decidePermission({ ...EXEC_REQ, args: { command: 'echo hi' } }, c),
    ).toBe('allow');
  });

  test('addDirs 扩展白名单：边界外目录经 addDirs 纳入工作区', () => {
    const c = cfg('workspace-write', 'never', { addDirs: ['/tmp/shared'] });
    expect(
      decidePermission(
        { ...WRITE_REQ, args: { path: '/tmp/shared/x.txt', content: 'x' } },
        c,
      ),
    ).toBe('allow');
    // 白名单之外仍越界
    expect(
      decidePermission(
        { ...WRITE_REQ, args: { path: '/tmp/other/x.txt', content: 'x' } },
        c,
      ),
    ).toBe('ask');
  });

  test('full-access + never：完全放手，不做目录边界检查', () => {
    const c = cfg('full-access', 'never');
    expect(
      decidePermission(
        { ...WRITE_REQ, args: { path: '/etc/passwd', content: 'x' } },
        c,
      ),
    ).toBe('allow');
  });
});

describe('默认组合（kickoff 0.5.0：workspace-write + on-request）', () => {
  test('defaultPermissionConfig 产出正确组合', () => {
    const d = defaultPermissionConfig(PROJECT_ROOT);
    expect(d).toEqual({
      sandbox: 'workspace-write',
      policy: 'on-request',
      projectRoot: PROJECT_ROOT,
    });
  });

  test('等价 0.3.0：写 / exec 全问、read 不问、危险命令强制问', () => {
    const d = defaultPermissionConfig(PROJECT_ROOT);
    expect(decidePermission(WRITE_REQ, d)).toBe('ask');
    expect(decidePermission(EXEC_REQ, d)).toBe('ask');
    expect(decidePermission(READ_REQ, d)).toBe('allow');
    expect(decidePermission(DANGEROUS_REQ, d)).toBe('ask');
  });
});

// ---------------------------------------------------------------------------
// ApprovalGate × PermissionConfig（T-050 接入：allow 直通 / deny 拒绝 / ask 才问）
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

function requestById(
  events: ProtocolEvent[],
  type: 'approval_request' | 'approval_resolved',
): ProtocolEvent[] {
  return events.filter((e) => e.type === type);
}

function gateInput(
  overrides: Partial<ApprovalRequestInput> = {},
): ApprovalRequestInput {
  return {
    toolName: 'write',
    risk: 'write',
    description: '写入/编辑文件：/repo/a.ts',
    prefix: '/repo/a.ts',
    args: { path: '/repo/a.ts', content: 'x' },
    ...overrides,
  };
}

describe('ApprovalGate × PermissionConfig（T-050 接入）', () => {
  test('allow：直通放行，不发事件、不调 decider', async () => {
    let calls = 0;
    const gate = new ApprovalGate({
      decider: async () => {
        calls += 1;
        return { decision: 'deny', source: 'user' };
      },
      permission: defaultPermissionConfig(PROJECT_ROOT), // read → allow
    });
    const { events, emit } = collect();
    const decision = await gate.requestApproval(
      { ...gateInput(), toolName: 'read', risk: 'read', prefix: '/repo/a.ts' },
      emit,
    );
    expect(decision).toBe('allow_once');
    expect(calls).toBe(0);
    expect(approvalEvents(events)).toHaveLength(0);
  });

  test('deny：直接拒绝，不发事件、不调 decider', async () => {
    let calls = 0;
    const gate = new ApprovalGate({
      decider: async () => {
        calls += 1;
        return { decision: 'allow_once', source: 'user' };
      },
      permission: cfg('read-only', 'on-request'), // write → deny
    });
    const { events, emit } = collect();
    const decision = await gate.requestApproval(gateInput(), emit);
    expect(decision).toBe('deny');
    expect(calls).toBe(0);
    expect(approvalEvents(events)).toHaveLength(0);
  });

  test('ask：走审批流程，发 approval_request / approval_resolved 配对', async () => {
    const gate = new ApprovalGate({
      decider: async () => ({ decision: 'allow_once', source: 'user' }),
      permission: defaultPermissionConfig(PROJECT_ROOT), // write → ask
    });
    const { events, emit } = collect();
    const decision = await gate.requestApproval(gateInput(), emit);
    expect(decision).toBe('allow_once');
    expect(requestById(events, 'approval_request')).toHaveLength(1);
    expect(requestById(events, 'approval_resolved')).toHaveLength(1);
  });

  test('never + 危险命令：即使 decider 始终 allow_once 也逐次强制确认', async () => {
    const gate = new ApprovalGate({
      decider: async () => ({ decision: 'allow_once', source: 'policy' }),
      permission: cfg('full-access', 'never'),
    });
    const dangerous = gateInput({
      toolName: 'bash',
      risk: 'exec',
      description: '执行命令：rm -rf /repo/x',
      command: 'rm -rf /repo/x',
      prefix: 'rm -rf /repo/x',
      args: { command: 'rm -rf /repo/x' },
    });
    const { events, emit } = collect();
    await gate.requestApproval(dangerous, emit);
    await gate.requestApproval(dangerous, emit);
    // 危险命令跳过 allow_always 记忆：两次调用都发请求（强制逐次确认）
    expect(requestById(events, 'approval_request')).toHaveLength(2);
    // 可选项不含「始终允许此前缀」
    const request = requestById(events, 'approval_request')[0];
    if (request.type === 'approval_request') {
      expect(request.data.options.some((o) => o.id === 'allow_always')).toBe(
        false,
      );
    }
  });

  test('未注入 permission：保持 0.3.0 行为（read/network 不拦、write/exec 全问）', async () => {
    const gate = new ApprovalGate({
      decider: async () => ({ decision: 'deny', source: 'user' }),
    });
    const read = await gate.requestApproval({
      ...gateInput(),
      toolName: 'read',
      risk: 'read',
    });
    const network = await gate.requestApproval({
      ...gateInput(),
      toolName: 'http',
      risk: 'network',
    });
    const write = await gate.requestApproval(gateInput());
    expect(read).toBe('allow_once');
    expect(network).toBe('allow_once');
    expect(write).toBe('deny');
  });

  test('permission 下 allow_always 记忆仍生效：同前缀第二次直接放行', async () => {
    let calls = 0;
    const gate = new ApprovalGate({
      decider: async () => {
        calls += 1;
        return { decision: 'allow_always', source: 'user' };
      },
      permission: defaultPermissionConfig(PROJECT_ROOT), // write → ask
    });
    const { events, emit } = collect();
    await gate.requestApproval(gateInput(), emit);
    const second = await gate.requestApproval(gateInput(), emit);
    expect(second).toBe('allow_always');
    expect(calls).toBe(1); // 第二次记忆命中，decider 不再被调
    expect(requestById(events, 'approval_request')).toHaveLength(1);
  });
});
