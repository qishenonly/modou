/**
 * 配置系统（T-080）离线测试。
 *
 * 覆盖：内置默认；全局 / 项目覆盖（标量、permission 深合并、数组替换）；
 * 坏 schema 报错（字段 / 期望 / 文件 / 行号）；JSON 语法错误；未知字段拒绝；
 * 环境变量（MODOU_*）覆盖与非法值报错；显式覆盖最高优先；文件不存在跳过。
 *
 * 全部离线：临时 HOME / 项目目录注入，不读写真实用户目录。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  resolveConfig,
  SettingsValidationError,
} from './settings';

// ---------------------------------------------------------------------------
// 测试辅助：临时目录 + 写设置文件
// ---------------------------------------------------------------------------

let dirCount = 0;

/** 建一个隔离的临时目录（homeDir 或 projectRoot 用），返回后由 afterEach 清理。 */
function makeTempDir(label: string): string {
  dirCount += 1;
  return mkdtempSync(join(tmpdir(), `modou-settings-${label}-${dirCount}-`));
}

/** 在当前测试目录树里写一个 settings.json（父目录自动创建）。 */
function writeSettings(root: string, sub: string, content: unknown): string {
  const dir = join(root, sub);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify(content, null, 2), 'utf8');
  return file;
}

// ---------------------------------------------------------------------------
// 内置默认 + 文件不存在跳过
// ---------------------------------------------------------------------------

describe('loadSettings：默认值与文件跳过', () => {
  test('目录下无设置文件时跳过，回落内置默认', () => {
    const home = makeTempDir('home');
    const project = makeTempDir('proj');
    try {
      const result = loadSettings({ homeDir: home, projectRoot: project });
      expect(result.globalFile).toBeUndefined();
      expect(result.projectFile).toBeUndefined();
      // 内置默认：供应商 / 权限组合 / 轮次 / 压缩保留
      expect(result.settings.provider).toBe('openai-compat');
      expect(result.settings.maxTurns).toBe(DEFAULT_SETTINGS.maxTurns);
      expect(result.settings.keepTurns).toBe(DEFAULT_SETTINGS.keepTurns);
      expect(result.settings.permission?.sandbox).toBe('workspace-write');
      expect(result.settings.permission?.policy).toBe('on-request');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('只有全局 / 只有项目设置文件时，缺失的另一层跳过', () => {
    const home = makeTempDir('home');
    const project = makeTempDir('proj');
    try {
      writeSettings(home, '.modou', { maxTurns: 5 });
      const result = loadSettings({ homeDir: home, projectRoot: project });
      expect(result.globalFile).toBeDefined();
      expect(result.projectFile).toBeUndefined();
      expect(result.settings.maxTurns).toBe(5);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 全局 / 项目覆盖
// ---------------------------------------------------------------------------

describe('loadSettings：全局 → 项目逐层覆盖', () => {
  test('项目覆盖全局的标量字段，未覆盖字段保留全局值', () => {
    const home = makeTempDir('home');
    const project = makeTempDir('proj');
    try {
      const globalFile = writeSettings(home, '.modou', {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        maxTurns: 5,
      });
      const projectFile = writeSettings(project, '.modou', { maxTurns: 20 });
      const result = loadSettings({ homeDir: home, projectRoot: project });
      expect(result.globalFile).toBe(globalFile);
      expect(result.projectFile).toBe(projectFile);
      expect(result.settings.maxTurns).toBe(20); // 项目覆盖
      expect(result.settings.provider).toBe('anthropic'); // 全局保留
      expect(result.settings.model).toBe('claude-sonnet-4-5');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('permission 对象深合并：键级覆盖，未覆盖键保留', () => {
    const home = makeTempDir('home');
    const project = makeTempDir('proj');
    try {
      writeSettings(home, '.modou', { permission: { sandbox: 'read-only' } });
      writeSettings(project, '.modou', { permission: { policy: 'never' } });
      const result = loadSettings({ homeDir: home, projectRoot: project });
      expect(result.settings.permission?.sandbox).toBe('read-only');
      expect(result.settings.permission?.policy).toBe('never');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('数组字段整体替换（addDirs / rules 不是追加合并）', () => {
    const home = makeTempDir('home');
    const project = makeTempDir('proj');
    try {
      writeSettings(home, '.modou', {
        permission: { addDirs: ['/global-a', '/global-b'] },
      });
      writeSettings(project, '.modou', {
        permission: { addDirs: ['/proj-a'] },
      });
      const result = loadSettings({ homeDir: home, projectRoot: project });
      expect(result.settings.permission?.addDirs).toEqual(['/proj-a']);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 坏 schema 报错
// ---------------------------------------------------------------------------

describe('loadSettings：schema 校验失败报友好错误', () => {
  test('类型错误：指出字段 / 期望 / 文件 / 行号', () => {
    const home = makeTempDir('home');
    const project = makeTempDir('proj');
    try {
      const file = writeSettings(home, '.modou', { maxTurns: 'abc' });
      try {
        loadSettings({ homeDir: home, projectRoot: project });
        throw new Error('应当抛出 SettingsValidationError');
      } catch (caught) {
        expect(caught).toBeInstanceOf(SettingsValidationError);
        const error = caught as SettingsValidationError;
        expect(error.field).toBe('settings.maxTurns');
        expect(error.file).toBe(file);
        expect(error.line).toBe(2); // maxTurns 在第 2 行（首行是 {）
        expect(error.message).toContain('期望');
        expect(error.message).toContain('settings.maxTurns');
        expect(error.message).toContain('settings.json');
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('枚举错误：permission.policy 不在合法取值内', () => {
    const home = makeTempDir('home');
    const project = makeTempDir('proj');
    try {
      writeSettings(project, '.modou', {
        permission: { policy: 'aggressive' },
      });
      try {
        loadSettings({ homeDir: home, projectRoot: project });
        throw new Error('应当抛出 SettingsValidationError');
      } catch (caught) {
        const error = caught as SettingsValidationError;
        expect(error.field).toBe('settings.permission.policy');
        expect(error.expected).toContain('untrusted');
        expect(error.line).toBe(3); // permission 对象内 policy 键所在行
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('未知字段拒绝（strict）：拼写错误立刻可见', () => {
    const home = makeTempDir('home');
    const project = makeTempDir('proj');
    try {
      writeSettings(project, '.modou', { maxTurn: 3 }); // 拼错：应为 maxTurns
      try {
        loadSettings({ homeDir: home, projectRoot: project });
        throw new Error('应当抛出 SettingsValidationError');
      } catch (caught) {
        const error = caught as SettingsValidationError;
        expect(error.field).toContain('maxTurn');
        expect(error.expected).toContain('未知字段');
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('JSON 语法错误：报来源文件与行号', () => {
    const home = makeTempDir('home');
    const project = makeTempDir('proj');
    try {
      const file = writeSettings(home, '.modou', {}); // 先写合法占位
      // 覆盖为坏 JSON：`}` 出现在第 3 行，即为首个语法错误所在行
      writeFileSync(file, '{\n  "maxTurns": \n}', 'utf8');
      try {
        loadSettings({ homeDir: home, projectRoot: project });
        throw new Error('应当抛出 SettingsValidationError');
      } catch (caught) {
        const error = caught as SettingsValidationError;
        expect(error.file).toBe(file);
        expect(error.line).toBe(3);
        expect(error.message).toContain('JSON');
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('homeDir 必须是绝对路径', () => {
    const home = makeTempDir('home');
    const project = makeTempDir('proj');
    try {
      writeSettings(home, '.modou', { homeDir: 'relative/home' });
      try {
        loadSettings({ homeDir: home, projectRoot: project });
        throw new Error('应当抛出 SettingsValidationError');
      } catch (caught) {
        const error = caught as SettingsValidationError;
        expect(error.field).toBe('settings.homeDir');
        expect(error.expected).toContain('绝对路径');
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// resolveConfig：默认值 / 环境变量 / 显式覆盖
// ---------------------------------------------------------------------------

describe('resolveConfig：默认值与逐层覆盖', () => {
  test('无任何来源时回落内置默认', () => {
    const config = resolveConfig({ homeDir: '/tmp/fake-home', env: {} });
    expect(config.provider).toBe('openai-compat');
    expect(config.maxTurns).toBe(10);
    expect(config.keepTurns).toBe(6);
    expect(config.permission.sandbox).toBe('workspace-write');
    expect(config.permission.policy).toBe('on-request');
    expect(config.homeDir).toBe('/tmp/fake-home');
    expect(config.model).toBeUndefined();
  });

  test('settings 文件的 provider / model / baseURL 生效', () => {
    const config = resolveConfig({
      homeDir: '/tmp/fake-home',
      env: {},
      settings: {
        provider: 'anthropic',
        model: 'claude-x',
        baseURL: 'https://proxy',
      },
    });
    expect(config.provider).toBe('anthropic');
    expect(config.model).toBe('claude-x');
    expect(config.baseURL).toBe('https://proxy');
  });

  test('settings.homeDir 覆盖引导主目录（会话/日志根迁移）', () => {
    const config = resolveConfig({
      homeDir: '/tmp/bootstrap',
      env: {},
      settings: { homeDir: '/tmp/elsewhere' },
    });
    expect(config.homeDir).toBe('/tmp/elsewhere');
  });

  test('MODOU_* 环境变量覆盖 settings', () => {
    const config = resolveConfig({
      homeDir: '/tmp/fake-home',
      env: {
        MODOU_PROVIDER: 'anthropic',
        MODOU_MODEL: 'claude-env',
        MODOU_MAX_TURNS: '20',
        MODOU_KEEP_TURNS: '3',
        MODOU_SANDBOX: 'read-only',
        MODOU_POLICY: 'untrusted',
      },
      settings: { provider: 'openai-compat', maxTurns: 5, keepTurns: 6 },
    });
    expect(config.provider).toBe('anthropic');
    expect(config.model).toBe('claude-env');
    expect(config.maxTurns).toBe(20);
    expect(config.keepTurns).toBe(3);
    expect(config.permission.sandbox).toBe('read-only');
    expect(config.permission.policy).toBe('untrusted');
  });

  test('MODOU_ADD_DIRS 逗号分隔解析为 addDirs 数组', () => {
    const config = resolveConfig({
      homeDir: '/tmp/fake-home',
      env: { MODOU_ADD_DIRS: '/a, /b/c ,/d' },
    });
    expect(config.permission.addDirs).toEqual(['/a', '/b/c', '/d']);
  });

  test('显式覆盖（CLI / TUI 选项）最高优先', () => {
    const config = resolveConfig({
      homeDir: '/tmp/fake-home',
      env: { MODOU_MAX_TURNS: '20' },
      settings: { maxTurns: 5 },
      overrides: { maxTurns: 30, policy: 'never' },
    });
    expect(config.maxTurns).toBe(30); // 覆盖 > 环境变量 > settings
    expect(config.permission.policy).toBe('never');
  });

  test('非法 MODOU_* 值报错并指明来源变量', () => {
    try {
      resolveConfig({
        homeDir: '/tmp/fake-home',
        env: { MODOU_MAX_TURNS: 'abc' },
      });
      throw new Error('应当抛出 SettingsValidationError');
    } catch (caught) {
      expect(caught).toBeInstanceOf(SettingsValidationError);
      const error = caught as SettingsValidationError;
      expect(error.field).toBe('settings.maxTurns');
      expect(error.source).toContain('MODOU_MAX_TURNS');
      expect(error.file).toBeUndefined(); // 环境变量错误无文件
    }
  });
});
