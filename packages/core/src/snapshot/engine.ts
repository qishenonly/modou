/**
 * 快照引擎（T-100）：影子 git 仓库方案（ADR 0009，design 002 §4.2 snapshot 条目 / §12 用户侧布局）。
 *
 * 核心思想：每个项目维护一个**影子 git 仓库**——快照内容存在影子仓库里，工作树仍是
 * 项目目录：
 *
 *   - 影子仓库位于 `<homeDir>/.modou/snapshots/<project-hash>/git`，对用户完全不可见；
 *   - 所有 git 命令显式设 `GIT_DIR=<影子仓库>/.git`、`GIT_WORK_TREE=<项目目录>`，
 *     git 据此在**影子索引**里记录项目当前状态，**绝不触碰用户仓库**（不用 stash、
 *     不建提交、不改用户的 index / HEAD / reflog / 分支）；
 *   - 项目目录本身不是 git 仓库也完全可用（影子仓库独立 init，与用户仓库无关）。
 *
 * 为什么不用 `git stash` / 在用户仓库建提交：那会污染用户 reflog、干扰用户自己的 git
 * 操作，一旦与用户手动 commit 交错就是灾难（0.10.0 开工纪要 §三）。
 *
 * 工作树含用户仓库 `.git` 目录时的行为（已实测）：git 隐式排除 `.git`，影子仓库只记录
 * 用户仓库的工作树文件，`.git` 本体不会被加入影子索引。
 *
 * 存储布局（与 002 §12 一致）：
 *
 *   ~/.modou/snapshots/<project-hash>/
 *     git/           影子仓库（非 bare，固定分支 modou；GIT_WORK_TREE 恒指向项目目录）
 *     manifest.json  快照清单（id / ts / 摘要 / sessionId / degraded…）
 *
 * 影子 git 负责「存内容」，manifest 负责「记语义」——清单是列表的唯一真相：摘要 /
 * 会话归属 / 降级标记这些 git commit 不携带的元数据都放这里。清理（T-103）重写清单并
 * 用 `git commit-tree` 重建影子历史，旧 commit 经 `git gc --prune=now` 回收。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { projectHash } from '../session/log';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 快照保留策略（T-103；缺省用 DEFAULT_RETENTION）。 */
export interface SnapshotRetention {
  /** 快照超过 maxAgeMs 视为过期（0 = 不限时间；缺省 30 天）。 */
  readonly maxAgeMs?: number;
  /** 每个会话至少保留最近 N 条快照（缺省 10）。 */
  readonly keepPerSession?: number;
  /** 单个项目最多保留的快照总数（超出删最旧，缺省 200）。 */
  readonly maxPerProject?: number;
}

/** 单次快照的体积 / 耗时上限（T-101；超限降级为仅记录 diff 摘要并告警）。 */
export interface SnapshotLimits {
  /** 变更路径数上限（缺省 2000）。 */
  readonly maxChangedPaths?: number;
  /** 变更文件总字节上限（缺省 128 MB）。 */
  readonly maxBytes?: number;
  /** 单个变更文件字节上限（缺省 50 MB；超限整次降级——影子仓库不存超大文件）。 */
  readonly maxSingleFileBytes?: number;
  /** 单条 git 命令超时（毫秒；超时视为降级，缺省 30 秒）。 */
  readonly maxDurationMs?: number;
}

/** 一个快照点：manifest 里的条目（列表的唯一真相）。 */
export interface SnapshotPoint {
  /** 影子仓库 commit 哈希（完整 40 位；degraded 时为 null）。 */
  readonly id: string | null;
  /** 快照时间（epoch ms）。 */
  readonly ts: number;
  /** 提交信息（git commit 标题）。 */
  readonly message: string;
  /** 改动摘要（人类可读，如「3 个文件变更：a.ts(修改)、b.ts(新增)」）。 */
  readonly summary: string;
  /** 变更文件数。 */
  readonly filesChanged: number;
  /** 所属会话 ID（TUI 自动快照时注入；手动 / 无会话时为 undefined）。 */
  readonly sessionId?: string;
  /**
   * 降级标记：true = 超限未存储完整内容（仅记录 diff 摘要），**不可还原**。
   * 列表 / /rewind 时用 `restorable()` 判断。
   */
  readonly degraded: boolean;
  /** 降级原因（degraded 时存在）。 */
  readonly reason?: string;
  /** 所属项目哈希。 */
  readonly projectHash: string;
}

/** 一次回滚的预览（T-102）：还原前告知用户「会动哪些文件」。 */
export interface RewindPreview {
  /** 目标快照 id。 */
  readonly snapshotId: string;
  /** 将被还原的文件（内容变回目标快照的版本）。 */
  readonly restoreFiles: readonly string[];
  /** 将被删除的文件（目标快照之后新增、影子已跟踪的）。 */
  readonly deleteFiles: readonly string[];
  /**
   * 将被 reset --hard 覆盖的脏已跟踪文件全集（工作树 / 索引与 HEAD 不同的文件，
   * 含用户手动改过、未入快照的改动）——还原会丢失这些改动，回滚前必须提示差异。
   */
  readonly overwriteFiles: readonly string[];
}

/** 一次回滚的产物。 */
export interface RewindResult {
  /** 回滚到的快照 id。 */
  readonly snapshotId: string;
  /** 被还原的文件（内容已回到目标快照）。 */
  readonly restored: readonly string[];
  /** 被删除的文件（目标快照之后新增）。 */
  readonly deleted: readonly string[];
  /** 影子 HEAD 现指向的快照 id。 */
  readonly headId: string;
}

/** 清理产物（T-103）。 */
export interface SnapshotCleanupResult {
  /** 删除的快照数。 */
  readonly removed: number;
  /** 保留的快照数。 */
  readonly kept: number;
  /** 清理前的影子仓库字节数。 */
  readonly beforeBytes: number;
  /** 清理后的影子仓库字节数。 */
  readonly afterBytes: number;
  /** 释放的字节数（before - after，非负）。 */
  readonly freedBytes: number;
}

/** 单个项目的快照占用报告（T-103 /snapshots）。 */
export interface ProjectSnapshotReport {
  readonly projectHash: string;
  /** 可还原（非降级）的快照数。 */
  readonly snapshotCount: number;
  /** 降级（仅摘要）条目数。 */
  readonly degradedCount: number;
  /** 影子仓库目录字节数。 */
  readonly bytes: number;
  /** 最近一次快照时间（无快照时为 0）。 */
  readonly lastTs: number;
  /** 保留策略（生效值）。 */
  readonly retention: Required<SnapshotRetention>;
}

/** 全部项目的占用报告（/snapshots 展示）。 */
export interface SnapshotUsageReport {
  readonly projects: readonly ProjectSnapshotReport[];
  readonly totalBytes: number;
  /** 快照根目录。 */
  readonly root: string;
}

/** 快照引擎错误（git 缺失 / 影子仓库损坏等不可恢复故障）。 */
export class SnapshotError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// ---------------------------------------------------------------------------
// 常量与默认值
// ---------------------------------------------------------------------------

/** 影子仓库固定分支名（跨 git 版本确定，清理重写历史时据此 update-ref）。 */
export const SHADOW_BRANCH = 'modou';

/** 缺省保留策略：30 天 / 每会话 10 条 / 每项目 200 条。 */
export const DEFAULT_RETENTION: Required<SnapshotRetention> = {
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  keepPerSession: 10,
  maxPerProject: 200,
};

/** 缺省单次快照上限（T-101）。 */
export const DEFAULT_LIMITS: Required<SnapshotLimits> = {
  maxChangedPaths: 2000,
  maxBytes: 128 * 1024 * 1024,
  maxSingleFileBytes: 50 * 1024 * 1024,
  maxDurationMs: 30_000,
};

/** 写入影子仓库 `info/exclude` 的默认排除（T-101：node_modules 与临时产物不进快照）。 */
const DEFAULT_EXCLUDES = `# modou 快照默认排除（T-101）——只影响影子仓库，不触碰用户仓库
node_modules/
.DS_Store
*.modou-*.tmp
`;

// ---------------------------------------------------------------------------
// git 命令执行
// ---------------------------------------------------------------------------

/** 一条 git 命令的执行结果。 */
interface GitResult {
  readonly ok: boolean;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** 是否超时被杀死（timeoutMs 触发）。 */
  readonly timedOut: boolean;
}

/** 执行一条 git 命令（异步 spawn，事件循环不被阻塞）。 */
function runGit(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options: { timeoutMs?: number; cwd?: string } = {},
): Promise<GitResult> {
  return new Promise<GitResult>((resolve) => {
    // 全局选项须在子命令之前（git -c core.quotepath=false <子命令>），
    // 否则被当成子命令的选项。core.quotepath=false 让非 ASCII 路径原样输出。
    const child = spawn('git', ['-c', 'core.quotepath=false', ...args], {
      env,
      cwd: options.cwd,
      timeout: options.timeoutMs,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    let timedOut = false;
    child.on('error', (caught: NodeJS.ErrnoException) => {
      if (caught.code === 'ENOENT') {
        resolve({
          ok: false,
          status: null,
          stdout,
          stderr: '',
          timedOut: false,
        });
        return;
      }
      // git 二进制存在但 spawn 失败（罕见）：按命令失败处理
      resolve({
        ok: false,
        status: null,
        stdout,
        stderr: caught.message,
        timedOut: false,
      });
    });
    child.on('close', (code, signal) => {
      // spawn 超时被 Node 杀死 → code null + signal SIGTERM
      if (code === null && signal === 'SIGTERM') timedOut = true;
      resolve({
        ok: code === 0,
        status: code,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// 解析 git status --porcelain -z 输出
// ---------------------------------------------------------------------------

/** 一条变更：状态码 + 路径。 */
export interface ChangeEntry {
  /** 双字符状态码（如 `??` / `M ` / ` M` / `D ` / `R `）。 */
  readonly status: string;
  /** 变更路径（相对工作树根）。 */
  readonly path: string;
}

/** 变更类型的人类可读描述（改动摘要用）。 */
export function describeChange(status: string): string {
  if (status === '??') return '新增';
  if (status.includes('D')) return '删除';
  if (status.includes('R')) return '重命名';
  if (status.includes('M')) return '修改';
  return '变更';
}

/**
 * 解析 `git status --porcelain -z` 输出：NUL 分隔、路径不转义。
 * 重命名条目是 `<XY> <新路径>\0<旧路径>\0`，旧路径是下一条目，消费时跳过。
 */
export function parsePorcelainZ(output: string): ChangeEntry[] {
  const chunks = output.split('\0');
  const entries: ChangeEntry[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk.length < 3) continue; // 空条目 / 结尾
    const status = chunk.slice(0, 2);
    const path = chunk.slice(3); // `<XY> <path>` 的第 3 位起是路径
    if (status.includes('R')) {
      index += 1; // 跳过旧路径条目
    }
    if (path.length === 0) continue;
    entries.push({ status, path });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// SnapshotStore
// ---------------------------------------------------------------------------

/** SnapshotStore 构造选项。 */
export interface SnapshotStoreOptions {
  /** 用户主目录：快照根为 `<homeDir>/.modou/snapshots`（缺省 os.homedir()）。 */
  readonly homeDir?: string;
  /** 项目工作目录（影子仓库的 GIT_WORK_TREE；缺省 process.cwd()）。 */
  readonly cwd?: string;
  /** 时钟注入口（测试用；缺省 Date.now）。 */
  readonly now?: () => number;
  /** 保留策略（T-103；缺省 DEFAULT_RETENTION）。 */
  readonly retention?: SnapshotRetention;
  /** 单次快照上限（T-101；缺省 DEFAULT_LIMITS）。 */
  readonly limits?: SnapshotLimits;
}

/** snapshot() 的选项。 */
export interface SnapshotOptions {
  /** 仅快照这些路径（相对工作树根或绝对路径；T-101 触碰路径模式）。 */
  readonly paths?: readonly string[];
  /** 会话 ID（TUI 自动快照时注入，供 T-103 按会话清理）。 */
  readonly sessionId?: string;
  /** 覆盖本实例的缺省上限（一次快照内生效）。 */
  readonly limits?: SnapshotLimits;
}

/**
 * 快照引擎：影子 git 仓库的初始化 / 快照 / 列表 / 回滚 / 清理。
 *
 * 写路径（snapshot / rewindTo / cleanup）串行化：内部 promise 链保证并发调用不互相
 * 踩踏（快照间共享影子索引，并发 add+commit 会丢变更）。
 */
export class SnapshotStore {
  /** 快照根目录：`<homeDir>/.modou/snapshots`。 */
  readonly snapshotsRoot: string;
  /** 项目哈希（影子仓库与清单的目录名）。 */
  readonly projectHash: string;
  /** 本项目快照存储目录（影子仓库与清单所在）。 */
  readonly projectDir: string;
  /** 影子仓库路径（`git init` 的目录）。 */
  readonly shadowRoot: string;
  /** 影子仓库 git 目录（GIT_DIR 的值）。 */
  readonly gitDir: string;
  /** 快照清单文件。 */
  readonly manifestPath: string;

  private readonly cwd: string;
  private readonly clock: () => number;
  private readonly retention: Required<SnapshotRetention>;
  private readonly defaultLimits: Required<SnapshotLimits>;
  /** 清单缓存（append 序 = 时间序，旧 → 新；写路径 mutate 后落盘）。 */
  private entries: SnapshotPoint[];
  /** 写路径串行队列（快照 / 回滚 / 清理共用）。 */
  private writeChain: Promise<void>;

  constructor(options: SnapshotStoreOptions = {}) {
    const home = options.homeDir ?? homedir();
    this.cwd = options.cwd ?? process.cwd();
    this.clock = options.now ?? (() => Date.now());
    this.retention = { ...DEFAULT_RETENTION, ...options.retention };
    this.defaultLimits = { ...DEFAULT_LIMITS, ...options.limits };
    this.projectHash = projectHash(this.cwd);
    this.snapshotsRoot = join(home, '.modou', 'snapshots');
    this.projectDir = join(this.snapshotsRoot, this.projectHash);
    this.shadowRoot = join(this.projectDir, 'git');
    this.gitDir = join(this.shadowRoot, '.git');
    this.manifestPath = join(this.projectDir, 'manifest.json');
    this.entries = this.readManifest();
    this.writeChain = Promise.resolve();
  }

  // -------------------------------------------------------------------------
  // 内部：git 环境 / 清单 / 初始化
  // -------------------------------------------------------------------------

  /** 影子仓库的环境变量：GIT_DIR + GIT_WORK_TREE 指向项目目录。 */
  private gitEnv(): NodeJS.ProcessEnv {
    return { ...process.env, GIT_DIR: this.gitDir, GIT_WORK_TREE: this.cwd };
  }

  /** 串行化执行一个写操作（快照 / 回滚 / 清理互斥）。 */
  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(task, task);
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 读取清单（损坏 / 缺失时退回空数组，不抛出——列表是 best-effort 视图）。 */
  private readManifest(): SnapshotPoint[] {
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(this.manifestPath, 'utf8'),
      );
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isSnapshotPoint);
    } catch {
      return [];
    }
  }

  /** 落盘清单（append 序 = 时间序）。 */
  private async saveManifest(): Promise<void> {
    await mkdir(dirname(this.manifestPath), { recursive: true });
    await writeFile(
      this.manifestPath,
      `${JSON.stringify(this.entries, null, 2)}\n`,
      'utf8',
    );
  }

  /** 影子仓库就绪：git init + 固定分支 + 本地身份 + 默认排除（幂等）。 */
  private async ensureInit(): Promise<void> {
    if (existsSync(join(this.gitDir, 'HEAD'))) return;
    await mkdir(this.projectDir, { recursive: true });
    const env = { ...process.env };
    const init = await runGit(['init', '--quiet', this.shadowRoot], env, {
      timeoutMs: this.defaultLimits.maxDurationMs,
    });
    if (!init.ok) {
      throw new SnapshotError(
        `初始化影子仓库失败：${init.stderr.trim() || 'git init 退出非零'}`,
      );
    }
    const configs: string[][] = [
      ['symbolic-ref', 'HEAD', `refs/heads/${SHADOW_BRANCH}`], // 固定分支名（跨 git 版本）
      ['config', 'user.name', 'modou'],
      ['config', 'user.email', 'modou@modou.local'],
      ['config', 'commit.gpgsign', 'false'], // 关闭签名（无密钥环境提交不失败）
    ];
    for (const args of configs) {
      const res = await runGit(['--git-dir', this.gitDir, ...args], env, {
        timeoutMs: this.defaultLimits.maxDurationMs,
      });
      if (!res.ok) {
        throw new SnapshotError(
          `初始化影子仓库失败：git ${args.join(' ')} 退出非零`,
        );
      }
    }
    // 默认排除（node_modules / 临时产物）——只影响影子仓库，不触碰用户仓库
    writeFileSync(
      join(this.gitDir, 'info', 'exclude'),
      DEFAULT_EXCLUDES,
      'utf8',
    );
  }

  // -------------------------------------------------------------------------
  // 快照（T-100 / T-101）
  // -------------------------------------------------------------------------

  /**
   * 记录一次快照：影子仓库里把当前工作树状态落为一个 commit。
   *
   * - `paths` 提供时为触碰路径模式：只快照这些路径（T-101），否则全量（尊重
   *   工作树 .gitignore + 影子 info/exclude 的 node_modules 等排除）；
   * - 无变更返回 null（不产生空 commit）；
   * - 超限（变更路径数 / 字节 / 单文件 / 耗时）降级为仅记录 diff 摘要，返回
   *   `degraded: true` 的点（不可还原，id 为 null）；
   * - 绝不触碰用户仓库的 git 状态 / index / 分支。
   */
  snapshot(options: SnapshotOptions = {}): Promise<SnapshotPoint | null> {
    return this.serialized(async () => this.snapshotInner(options));
  }

  private async snapshotInner(
    options: SnapshotOptions,
  ): Promise<SnapshotPoint | null> {
    await this.ensureInit();
    const limits: Required<SnapshotLimits> = {
      ...this.defaultLimits,
      ...options.limits,
    };
    const paths = this.relativizePaths(options.paths ?? []);

    // 1) 变更探测（触碰路径模式下只统计这些路径）
    const statusRes = await runGit(
      [
        'status',
        '--porcelain',
        '-z',
        ...(paths.length > 0 ? ['--', ...paths] : []),
      ],
      this.gitEnv(),
      { timeoutMs: limits.maxDurationMs },
    );
    if (!statusRes.ok) {
      return this.degradedPoint(
        options.sessionId,
        'git status 失败，无法收集变更',
        0,
      );
    }
    const entries = parsePorcelainZ(statusRes.stdout);
    if (entries.length === 0) return null;

    // 2) 上限检查：路径数
    if (entries.length > limits.maxChangedPaths) {
      return this.degradedPoint(
        options.sessionId,
        `变更路径数 ${entries.length} 超过上限 ${limits.maxChangedPaths}`,
        entries.length,
      );
    }

    // 3) 上限检查：字节（只统计工作树现存文件；删除的路径不存在，跳过）
    let totalBytes = 0;
    for (const entry of entries) {
      const st = await stat(join(this.cwd, entry.path)).catch(() => null);
      if (st === null || !st.isFile()) continue;
      totalBytes += st.size;
      if (st.size > limits.maxSingleFileBytes) {
        return this.degradedPoint(
          options.sessionId,
          `文件 ${entry.path}（${st.size} 字节）超过单文件上限 ${limits.maxSingleFileBytes}，为免影子仓库膨胀放弃快照`,
          entries.length,
        );
      }
    }
    if (totalBytes > limits.maxBytes) {
      return this.degradedPoint(
        options.sessionId,
        `变更文件合计 ${totalBytes} 字节超过上限 ${limits.maxBytes}`,
        entries.length,
      );
    }

    // 4) add + commit（被忽略的路径会导致 add 失败：筛掉后重试一次）
    let addRes = await runGit(
      ['add', '-A', ...(paths.length > 0 ? ['--', ...paths] : [])],
      this.gitEnv(),
      { timeoutMs: limits.maxDurationMs },
    );
    if (!addRes.ok && paths.length > 0) {
      const ignored = await runGit(
        ['check-ignore', '-z', '--', ...paths],
        this.gitEnv(),
        {
          timeoutMs: limits.maxDurationMs,
        },
      );
      const ignoredSet = new Set(
        ignored.stdout.split('\0').filter((p) => p.length > 0),
      );
      const filtered = paths.filter((p) => !ignoredSet.has(p));
      if (filtered.length === 0) {
        return this.degradedPoint(
          options.sessionId,
          '触碰路径全部被忽略（.gitignore / info/exclude），无可快照内容',
          entries.length,
        );
      }
      addRes = await runGit(['add', '-A', '--', ...filtered], this.gitEnv(), {
        timeoutMs: limits.maxDurationMs,
      });
    }
    if (!addRes.ok) {
      return this.degradedPoint(
        options.sessionId,
        `git add 失败：${addRes.stderr.trim() || '未知错误'}`,
        entries.length,
      );
    }

    // 5) commit
    const ts = this.clock();
    const title = `modou 快照 ${new Date(ts).toISOString()}`;
    const summary = buildChangeSummary(entries);
    const commitRes = await runGit(
      ['commit', '-m', title, '-m', summary],
      this.gitEnv(),
      { timeoutMs: limits.maxDurationMs },
    );
    if (!commitRes.ok) {
      // 「nothing to commit」（并发竞态）按无变更处理
      if (commitRes.stderr.includes('nothing to commit')) return null;
      return this.degradedPoint(
        options.sessionId,
        `git commit 失败：${commitRes.stderr.trim() || '未知错误'}`,
        entries.length,
      );
    }
    const headRes = await runGit(['rev-parse', 'HEAD'], this.gitEnv(), {
      timeoutMs: limits.maxDurationMs,
    });
    const id = headRes.ok ? headRes.stdout.trim() : '';
    const point: SnapshotPoint = {
      id: id.length > 0 ? id : null,
      ts,
      message: title,
      summary,
      filesChanged: entries.length,
      projectHash: this.projectHash,
      ...(options.sessionId !== undefined
        ? { sessionId: options.sessionId }
        : {}),
      degraded: false,
    };
    this.entries.push(point);
    await this.saveManifest();
    return point;
  }

  /** 构造一个降级快照点（仅记录 diff 摘要，不入影子仓库）。 */
  private degradedPoint(
    sessionId: string | undefined,
    reason: string,
    filesChanged: number,
  ): SnapshotPoint {
    const point: SnapshotPoint = {
      id: null,
      ts: this.clock(),
      message: 'modou 快照（已降级）',
      summary: reason,
      filesChanged,
      projectHash: this.projectHash,
      ...(sessionId !== undefined ? { sessionId } : {}),
      degraded: true,
      reason,
    };
    this.entries.push(point);
    void this.saveManifest();
    return point;
  }

  /** 把路径统一为相对工作树根（git pathspec 用相对路径最稳）。 */
  private relativizePaths(paths: readonly string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of paths) {
      // resolve：绝对路径原样、相对路径相对工作树根解析（join 对绝对路径不重置）
      const normalized = resolve(this.cwd, raw);
      const rel = relative(this.cwd, normalized);
      if (rel.startsWith('..') || rel.length === 0) continue; // 工作树外 / 工作树本身
      if (seen.has(rel)) continue;
      seen.add(rel);
      result.push(rel);
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // 列表（T-102 的数据源）
  // -------------------------------------------------------------------------

  /** 当前项目全部快照点，按时间倒序（新 → 旧）。 */
  listSnapshots(): Promise<SnapshotPoint[]> {
    return Promise.resolve([...this.entries].reverse());
  }

  /** 按 id 找快照点（manifest 里存在且 id 匹配）。 */
  findSnapshot(id: string): SnapshotPoint | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  // -------------------------------------------------------------------------
  // 回滚（T-102）
  // -------------------------------------------------------------------------

  /**
   * 回滚预览：列出还原 / 删除 / 覆盖文件，供回滚前提示差异（用户手动改过的文件
   * 会出现在 overwriteFiles——回滚会丢失这些改动，必须先让用户确认）。
   */
  async previewRewind(id: string): Promise<RewindPreview> {
    const snapshotId = await this.resolveSnapshotId(id);
    const env = this.gitEnv();
    // 目标快照与当前 HEAD 之间变动的文件（还原 / 删除对象）。
    // --no-renames：rename 拆成 D+A 两条，还原语义更直白（旧名还原 / 新名删除）。
    const diffRes = await runGit(
      ['diff', '--name-status', '--no-renames', '-z', `${snapshotId}..HEAD`],
      env,
      { timeoutMs: this.defaultLimits.maxDurationMs },
    );
    const changed = diffRes.ok ? parseNameStatusZ(diffRes.stdout) : [];
    const restoreFiles: string[] = [];
    const deleteFiles: string[] = [];
    for (const item of changed) {
      if (item.status === 'A') deleteFiles.push(item.path);
      else restoreFiles.push(item.path);
    }
    // 工作树 / 索引与 HEAD 不同的已跟踪文件（会被 reset --hard 覆盖）——
    // 「脏的已跟踪文件全集」（git diff HEAD 与 git diff --cached 的并集）。
    // 不与被还原文件求交：用户手动改过的文件（无论是否在 restore/delete 集）
    // 都会被 reset --hard 覆盖，必须全部在回滚前提示差异。
    const dirty = new Set<string>();
    const collectDirty = async (args: string[]): Promise<void> => {
      const res = await runGit(args, env, {
        timeoutMs: this.defaultLimits.maxDurationMs,
      });
      if (!res.ok) return;
      for (const path of res.stdout.split('\0')) {
        if (path.length > 0) dirty.add(path);
      }
    };
    await collectDirty(['diff', '--name-only', '-z', 'HEAD']);
    await collectDirty(['diff', '--cached', '--name-only', '-z']);
    // overwriteFiles = 脏文件全集（不是 restoreFiles ∩ dirty）：还原会覆盖所有
    // 脏文件——即使某文件不在「目标快照→HEAD 的变更集」里（用户手动改过），
    // reset --hard 同样把它打回目标点，不提示差异就会悄悄丢改动。
    const overwriteFiles = [...dirty];
    return { snapshotId, restoreFiles, deleteFiles, overwriteFiles };
  }

  /**
   * 还原到指定快照点：影子仓库 `git reset --hard <id>`——
   *   - 工作树文件回到该点内容（符号链接与权限由 git 保留）；
   *   - 该点之后新增的影子已跟踪文件被删除；
   *   - 影子从未跟踪的文件（未触碰路径 / 用户自己的文件）原样保留；
   *   - 影子 HEAD 移到该点（后续快照从此继续；更旧 / 更新的快照对象仍可还原）。
   */
  rewindTo(id: string): Promise<RewindResult> {
    return this.serialized(async () => {
      await this.ensureInit();
      const snapshotId = await this.resolveSnapshotId(id);
      const env = this.gitEnv();
      const preview = await this.previewRewind(snapshotId);
      const resetRes = await runGit(['reset', '--hard', snapshotId], env, {
        timeoutMs: this.defaultLimits.maxDurationMs,
      });
      if (!resetRes.ok) {
        throw new SnapshotError(
          `还原失败：${resetRes.stderr.trim() || 'git reset 退出非零'}`,
        );
      }
      const headRes = await runGit(['rev-parse', 'HEAD'], env, {
        timeoutMs: this.defaultLimits.maxDurationMs,
      });
      const headId = headRes.ok ? headRes.stdout.trim() : snapshotId;
      return {
        snapshotId,
        restored: [...preview.restoreFiles],
        deleted: [...preview.deleteFiles],
        headId,
      };
    });
  }

  /** 解析快照 id（manifest 存在性 + git 对象存在性），返回完整哈希。 */
  private async resolveSnapshotId(id: string): Promise<string> {
    const entry = this.findSnapshot(id);
    if (entry === undefined || entry.degraded || entry.id === null) {
      throw new SnapshotError(
        `快照 ${id} 不存在或未存储完整内容（degraded），无法还原`,
      );
    }
    const res = await runGit(['rev-parse', `${id}^{commit}`], this.gitEnv(), {
      timeoutMs: this.defaultLimits.maxDurationMs,
    });
    if (!res.ok) {
      throw new SnapshotError(
        `快照 ${id} 的影子 commit 不存在（可能已被清理）`,
      );
    }
    return res.stdout.trim();
  }

  // -------------------------------------------------------------------------
  // 生命周期（T-103）
  // -------------------------------------------------------------------------

  /**
   * 清理过期快照：按保留策略（maxAgeMs + keepPerSession + maxPerProject）计算应删
   * 集合，重写清单，并用 `git commit-tree` 重建影子历史（只保留应留的快照 commit，
   * 被删 commit 经 `git gc --prune=now` 回收磁盘）。
   */
  cleanup(): Promise<SnapshotCleanupResult> {
    return this.serialized(async () => {
      const beforeBytes = await dirBytes(this.projectDir);
      const before = [...this.entries];
      const kept = this.selectKept(before);
      const removed = before.filter((entry) => !kept.includes(entry));
      if (removed.length === 0) {
        return {
          removed: 0,
          kept: kept.length,
          beforeBytes,
          afterBytes: beforeBytes,
          freedBytes: 0,
        };
      }
      // 重建影子历史（只保留 kept 中可还原的 commit；degraded 条目无 commit）
      const restorable = kept.filter(
        (entry) => entry.id !== null && !entry.degraded,
      );
      const newIds = await this.rebuildShadowHistory(
        restorable.map((entry) => entry.id as string),
      );
      // 用新 commit id 回填清单（id 在重建后变化）
      const idMap = new Map<string, string>();
      for (let index = 0; index < restorable.length; index += 1) {
        const oldId = restorable[index]?.id as string;
        const newId = newIds[index];
        if (newId !== undefined) idMap.set(oldId, newId);
      }
      this.entries = kept.map((entry) =>
        entry.id !== null && idMap.has(entry.id)
          ? { ...entry, id: idMap.get(entry.id) as string }
          : entry,
      );
      await this.saveManifest();
      const afterBytes = await dirBytes(this.projectDir);
      return {
        removed: removed.length,
        kept: kept.length,
        beforeBytes,
        afterBytes,
        freedBytes: Math.max(0, beforeBytes - afterBytes),
      };
    });
  }

  /** 按保留策略选出应保留的快照（分组 → 时间窗口 → 每会话下限 → 每项目上限）。 */
  private selectKept(entries: readonly SnapshotPoint[]): SnapshotPoint[] {
    const now = this.clock();
    // 每会话至少保留最近 N 条（保护最近工作点不被时间窗口误删）
    const bySession = new Map<string, SnapshotPoint[]>();
    for (const entry of entries) {
      const key = entry.sessionId ?? '';
      const group = bySession.get(key) ?? [];
      group.push(entry);
      bySession.set(key, group);
    }
    const protectedRecent = new Set<SnapshotPoint>();
    for (const group of bySession.values()) {
      group.sort((a, b) => a.ts - b.ts); // 旧 → 新
      const keep = this.retention.keepPerSession;
      for (const entry of group.slice(-keep)) protectedRecent.add(entry);
    }
    // 时间窗口：过期且不在保护集 → 删
    const kept = entries.filter((entry) => {
      if (this.retention.maxAgeMs === 0) return true;
      if (protectedRecent.has(entry)) return true;
      return now - entry.ts <= this.retention.maxAgeMs;
    });
    // 每项目上限：仍超出则删最旧
    if (kept.length > this.retention.maxPerProject) {
      const overflow = kept.length - this.retention.maxPerProject;
      const sorted = [...kept].sort((a, b) => a.ts - b.ts);
      return sorted.slice(overflow);
    }
    return kept;
  }

  /**
   * 重建影子历史：把保留的 commit 按序重链为一条新线性历史。
   * 每个新 commit 复用原 commit 的 tree / message，只改父指针；返回新 commit id。
   */
  private async rebuildShadowHistory(
    commitIds: readonly string[],
  ): Promise<string[]> {
    if (commitIds.length === 0) {
      // 全部被删：清空分支（影子仓库回到空历史）
      await runGit(
        ['update-ref', `refs/heads/${SHADOW_BRANCH}`, '--delete'],
        this.gitEnv(),
        {
          timeoutMs: this.defaultLimits.maxDurationMs,
        },
      );
      return [];
    }
    const env = this.gitEnv();
    const newIds: string[] = [];
    let parent: string | undefined;
    for (const id of commitIds) {
      const treeRes = await runGit(['rev-parse', `${id}^{tree}`], env, {
        timeoutMs: this.defaultLimits.maxDurationMs,
      });
      const msgRes = await runGit(['log', '-1', '--format=%B', id], env, {
        timeoutMs: this.defaultLimits.maxDurationMs,
      });
      if (!treeRes.ok || !msgRes.ok) {
        throw new SnapshotError(
          `重建影子历史失败：无法读取 commit ${id} 的树 / 消息`,
        );
      }
      const args = [
        'commit-tree',
        treeRes.stdout.trim(),
        '-m',
        msgRes.stdout.trim(),
      ];
      if (parent !== undefined) args.push('-p', parent);
      const newRes = await runGit(args, env, {
        timeoutMs: this.defaultLimits.maxDurationMs,
      });
      if (!newRes.ok) {
        throw new SnapshotError(`重建影子历史失败：commit-tree 退出非零`);
      }
      const newId = newRes.stdout.trim();
      newIds.push(newId);
      parent = newId;
    }
    const updateRes = await runGit(
      ['update-ref', `refs/heads/${SHADOW_BRANCH}`, parent as string],
      env,
      { timeoutMs: this.defaultLimits.maxDurationMs },
    );
    if (!updateRes.ok) {
      throw new SnapshotError(`重建影子历史失败：update-ref 退出非零`);
    }
    // 回收被删 commit 的对象
    await runGit(['gc', '--prune=now', '--quiet'], env, {
      timeoutMs: Math.max(this.defaultLimits.maxDurationMs, 60_000),
    });
    return newIds;
  }

  // -------------------------------------------------------------------------
  // 占用报告（T-103 /snapshots）
  // -------------------------------------------------------------------------

  /** 全部项目的快照占用报告（/snapshots 展示；含本项目与其他项目）。 */
  async reportUsage(): Promise<SnapshotUsageReport> {
    const projects: ProjectSnapshotReport[] = [];
    let totalBytes = 0;
    for (const project of await listProjectHashes(this.snapshotsRoot)) {
      const entries = readManifestFile(
        join(this.snapshotsRoot, project, 'manifest.json'),
      );
      const bytes = await dirBytes(join(this.snapshotsRoot, project));
      totalBytes += bytes;
      projects.push({
        projectHash: project,
        snapshotCount: entries.filter((entry) => !entry.degraded).length,
        degradedCount: entries.filter((entry) => entry.degraded).length,
        bytes,
        lastTs: entries.reduce((max, entry) => Math.max(max, entry.ts), 0),
        retention: { ...this.retention },
      });
    }
    projects.sort((a, b) => b.lastTs - a.lastTs);
    return { projects, totalBytes, root: this.snapshotsRoot };
  }
}

// ---------------------------------------------------------------------------
// 模块级工具函数
// ---------------------------------------------------------------------------

/**
 * 解析 `git diff --name-status -z` 输出：条目为 `状态\0路径\0`（rename/copy 为
 * `R100\0旧路径\0新路径\0`）。调用方用 `--no-renames` 避免 rename 形态，这里仍
 * 处理 R/C 以防御性取新路径（rename 后文件以新名存在于 HEAD）。
 */
function parseNameStatusZ(
  output: string,
): Array<{ status: string; path: string }> {
  const chunks = output.split('\0');
  const items: Array<{ status: string; path: string }> = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const status = chunks[index];
    if (status === undefined || status.length === 0) continue;
    const kind = status[0] ?? '';
    let path = chunks[index + 1] ?? '';
    if (kind === 'R' || kind === 'C') {
      path = chunks[index + 2] ?? ''; // rename/copy：新路径在后
      index += 2;
    } else {
      index += 1;
    }
    if (path.length > 0) items.push({ status, path });
  }
  return items;
}

/** 改动摘要文本（commit body 与快照点 summary 共用）。 */
function buildChangeSummary(entries: readonly ChangeEntry[]): string {
  const head = entries.slice(0, 5);
  const detail = head
    .map((entry) => `${entry.path}(${describeChange(entry.status)})`)
    .join('、');
  return entries.length > 5
    ? `${entries.length} 个文件变更：${detail} 等 ${entries.length} 个`
    : `${entries.length} 个文件变更：${detail}`;
}

/** 运行时结构守卫：判断一个值是否合法的快照点。 */
function isSnapshotPoint(value: unknown): value is SnapshotPoint {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as {
    id?: unknown;
    ts?: unknown;
    message?: unknown;
    summary?: unknown;
    filesChanged?: unknown;
    degraded?: unknown;
    projectHash?: unknown;
  };
  return (
    (candidate.id === null || typeof candidate.id === 'string') &&
    typeof candidate.ts === 'number' &&
    typeof candidate.message === 'string' &&
    typeof candidate.summary === 'string' &&
    typeof candidate.filesChanged === 'number' &&
    typeof candidate.degraded === 'boolean' &&
    typeof candidate.projectHash === 'string'
  );
}

/** 读取清单文件为快照点数组（缺失 / 损坏退回空数组）。 */
function readManifestFile(path: string): SnapshotPoint[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSnapshotPoint);
  } catch {
    return [];
  }
}

/** 列出快照根下的项目哈希目录（含 manifest.json 的目录）。 */
async function listProjectHashes(root: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const projects: string[] = [];
  for (const name of names) {
    if (existsSync(join(root, name, 'manifest.json'))) projects.push(name);
  }
  return projects;
}

/** 目录占用字节数（递归统计；目录不存在返回 0）。 */
async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let names: string[];
    try {
      names = await readdir(current);
    } catch {
      continue; // 目录被并发删除等：跳过
    }
    for (const name of names) {
      const entryStat = await stat(join(current, name)).catch(() => null);
      if (entryStat === null) continue;
      if (entryStat.isDirectory()) stack.push(join(current, name));
      else total += entryStat.size;
    }
  }
  return total;
}
