/**
 * TUI 启动装配（T-080 配置接入）离线测试。
 *
 * 覆盖：无配置文件时默认装配；项目 settings.json 按配置装配 provider /
 * permission / maxTurns / keepTurns；全局 settings.json 被项目覆盖；显式
 * 选项最高优先；MODOU_* 环境变量覆盖 settings。
 *
 * 全部离线：临时 HOME / 项目目录注入，provider 装配只构造不联网（API Key
 * 由测试 env 提供）。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelProvider, PermissionConfig } from '@modou/core';
import { assembleTuiStartup } from './startup';

let dirCount = 0;

/** 建一个隔离的临时目录（homeDir 或项目用）。 */
function makeTempDir(label: string): string {
  dirCount += 1;
  return mkdtempSync(join(tmpdir(), `modou-tui-config-${label}-${dirCount}-`));
}

/** 写一个 settings.json（父目录自动创建）。 */
function writeSettings(root: string, sub: string, content: unknown): void {
  const dir = join(root, sub);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify(content, null, 2),
    'utf8',
  );
}

/** 最小 provider stub（验证「显式实例优先」用；不联网）。 */
function stubProvider(): ModelProvider {
  return {
    id: 'stub',
    modelId: 'stub-model',
    capabilities: {
      maxContext: 64_000,
      parallelToolCalls: true,
      cacheBreakpoints: false,
      images: false,
      thinking: 'none',
      strictJsonArgs: true,
    },
    async *streamChat() {
      return;
    },
  };
}

describe('assembleTuiStartup（T-080 配置接入）', () => {
  test('无设置文件：内置默认装配（homeDir / projectRoot 注入）', () => {
    const home = makeTempDir('home');
    const project = makeTempDir('proj');
    try {
      const startup = assembleTuiStartup(
        { cwd: project, homeDir: home },
        { OPENAI_API_KEY: 'test-key' },
      );
      expect(startup.homeDir).toBe(home);
      expect(startup.projectRoot).toBe(project);
      expect(startup.provider.id).toBe('openai-compat');
      expect(startup.maxTurns).toBe(10);
      expect(startup.keepTurns).toBe(6);
      expect(startup.permission.sandbox).toBe('workspace-write');
      expect(startup.permission.policy).toBe('on-request');
      expect(startup.permission.projectRoot).toBe(project);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('项目 settings.json 按配置装配 provider / permission / 轮次', () => {
    const home = makeTempDir('home');
    const project = makeTempDir('proj');
    try {
      writeSettings(project, '.modou', {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        maxTurns: 3,
        permission: { policy: 'never' },
      });
      const startup = assembleTuiStartup(
        { cwd: project, homeDir: home },
        { ANTHROPIC_API_KEY: 'test-key' },
      );
      expect(startup.provider.id).toBe('anthropic');
      expect(startup.provider.modelId).toBe('claude-sonnet-4-5');
      expect(startup.maxTurns).toBe(3);
      expect(startup.permission.policy).toBe('never');
      expect(startup.permission.sandbox).toBe('workspace-write'); // 全局默认保留
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('全局 settings.json 被项目设置覆盖', () => {
    const home = makeTempDir('home');
    const project = makeTempDir('proj');
    try {
      writeSettings(home, '.modou', { maxTurns: 5 });
      writeSettings(project, '.modou', { maxTurns: 9 });
      const startup = assembleTuiStartup(
        { cwd: project, homeDir: home },
        { OPENAI_API_KEY: 'test-key' },
      );
      expect(startup.maxTurns).toBe(9);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('显式选项最高优先（provider 实例 / permission / maxTurns）', () => {
    const home = makeTempDir('home');
    const project = makeTempDir('proj');
    try {
      const provider = stubProvider();
      const permission: PermissionConfig = {
        sandbox: 'read-only',
        policy: 'untrusted',
        projectRoot: project,
      };
      const startup = assembleTuiStartup(
        { cwd: project, homeDir: home, provider, permission, maxTurns: 4 },
        { OPENAI_API_KEY: 'test-key' },
      );
      expect(startup.provider).toBe(provider);
      expect(startup.permission).toBe(permission);
      expect(startup.maxTurns).toBe(4);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('MODOU_* 环境变量覆盖 settings', () => {
    const home = makeTempDir('home');
    const project = makeTempDir('proj');
    try {
      writeSettings(project, '.modou', { maxTurns: 3 });
      const startup = assembleTuiStartup(
        { cwd: project, homeDir: home },
        {
          OPENAI_API_KEY: 'test-key',
          MODOU_MAX_TURNS: '7',
          MODOU_MODEL: 'deepseek-v4-flash',
        },
      );
      expect(startup.maxTurns).toBe(7);
      expect(startup.provider.modelId).toBe('deepseek-v4-flash');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});
