/**
 * 渲染进程对 `window.modou` 的类型声明（与 electron/preload.ts 的 API 对应）。
 *
 * 渲染进程是事件流的纯消费者 + Command 的发送者（002 3.3）：不持有 core 内部
 * 对象，一切状态来自协议信封 / READY 摘要 / invoke 查询结果。
 */
import type {
  Command,
  ContextStateData,
  CostTotals,
  DayCostTotals,
  Envelope,
  InitResult,
  McpServerStatus,
  ResumeCandidate,
  RewindPreview,
  RewindResult,
  SnapshotPoint,
  SnapshotUsageReport,
} from '@modou/core';
import type {
  FileTreeResult,
  GitDiffResult,
  GitStatusResult,
  GuiConfigSummary,
  GuiSettings,
  GuiSettingsPatch,
  GuiTheme,
  PlanPayload,
  ProviderEntry,
  ProviderState,
  ReadFileResult,
  ReadyPayload,
  RemoteModelsResult,
  SaveSettingsResult,
  ScheduledTask,
  SessionSearchResult,
  ThreadMessage,
} from '../../electron/ipc';

/** preload 暴露的桥（window.modou）。 */
export interface ModouApi {
  /** 订阅协议信封流；返回退订函数。 */
  onEvent(callback: (envelope: Envelope) => void): () => void;
  /** 订阅配置摘要（启动一次 + 模型/会话切换后刷新）；返回退订函数。 */
  onReady(callback: (payload: ReadyPayload) => void): () => void;
  /** 订阅计划产出（/plan 面板开合）；返回退订函数。 */
  onPlan(callback: (payload: PlanPayload) => void): () => void;
  /** 发送 core Command（submit / approve / interrupt / steer / slash / plan_*）。 */
  sendCommand(command: Command): void;
  /** 可恢复会话列表（侧栏）。 */
  listSessions(): Promise<readonly ResumeCandidate[]>;
  /** 当前线程的展示消息（resume/clear 后播种历史）。 */
  getThread(): Promise<readonly ThreadMessage[] | null>;
  /** 会话内容级搜索（侧栏全文检索；Claude Desktop 式历史搜索）。 */
  searchSessions(query: string): Promise<readonly SessionSearchResult[]>;
  /** /model 候选模型 ID（模型选择器）。 */
  listModels(): Promise<readonly string[]>;
  /** 已发现技能清单（设置面板）。 */
  listSkills(): Promise<readonly { name: string; description: string }[]>;
  /** 当前上下文分项核算（/context 面板）。 */
  getContext(): Promise<ContextStateData | null>;
  /** 配置摘要（设置面板 / 顶栏）。 */
  getConfig(): Promise<GuiConfigSummary | null>;
  /** 可编辑设置（设置面板表单初值）。 */
  getSettings(): Promise<GuiSettings | null>;
  /** 保存设置到项目 .modou/settings.json。 */
  saveSettings(patch: GuiSettingsPatch): Promise<SaveSettingsResult>;
  /** 读取主题（gui-state 持久化）。 */
  getTheme(): Promise<GuiTheme>;
  /** 设置主题。 */
  setTheme(theme: GuiTheme): Promise<void>;
  /** 删除一条会话（侧栏）。 */
  deleteSession(sessionId: string): Promise<boolean>;
  /** 重命名会话（标题映射存 gui-state；空标题 = 恢复默认）。返回新映射。 */
  renameSession(
    sessionId: string,
    title: string,
  ): Promise<Record<string, string>>;
  /** 读取会话标题映射。 */
  getSessionTitles(): Promise<Record<string, string>>;
  /** 重新生成最后一条回复（重试）。 */
  regenerate(): Promise<boolean>;
  /** 用系统文件管理器打开路径。 */
  openPath(path: string): void;
  /** 读取供应商列表 + 当前模型（ccswitch 式模型管理）。 */
  getProviders(): Promise<ProviderState>;
  /** 保存供应商列表（不切换当前模型）。 */
  saveProviders(providers: readonly ProviderEntry[]): Promise<void>;
  /** 切换当前模型（写 active + 重建 bridge）。 */
  setActiveModel(input: {
    readonly providerId: string;
    readonly model: string;
  }): Promise<{ readonly ok: boolean; readonly message?: string }>;
  /** 从上游 /models 拉取模型列表。 */
  listRemoteModels(input: {
    readonly baseURL: string;
    readonly apiKey: string;
  }): Promise<RemoteModelsResult>;
  /** 读取额外技能扫描目录。 */
  getSkillDirs(): Promise<readonly string[]>;
  /** 保存额外技能扫描目录（重建 bridge 生效）。 */
  setSkillDirs(dirs: readonly string[]): void;
  /** 读取自定义 agent 文件内容（不存在返回 null）。 */
  readAgent(name: string): Promise<string | null>;
  /** 写入自定义 agent 文件（重建 bridge 生效）。 */
  writeAgent(name: string, content: string): Promise<boolean>;
  /** 删除自定义 agent 文件（重建 bridge 生效）。 */
  deleteAgent(name: string): Promise<boolean>;
  /** 读取定时任务列表。 */
  getTasks(): Promise<readonly ScheduledTask[]>;
  /** 保存定时任务列表。 */
  saveTasks(tasks: readonly ScheduledTask[]): Promise<boolean>;
  /** 选择图片附件（系统对话框，返回 data URI 数组）。 */
  selectImages(): Promise<readonly string[]>;
  /** 读取 bash 默认超时（ms）。 */
  getBashTimeout(): Promise<number>;
  /** 设置 bash 默认超时（ms；重建 bridge 生效）。 */
  setBashTimeout(ms: number): void;
  /** 打开目录选择器选项目目录（选定后主进程重建 bridge，READY 会随后到达）。 */
  selectDirectory(): Promise<{ ok: boolean; cwd: string | null }>;
  /** 快照点列表（/rewind 面板）。 */
  getSnapshots(): Promise<readonly SnapshotPoint[]>;
  /** 回滚预览（/rewind 确认态）。 */
  previewRewind(snapshotId: string): Promise<RewindPreview | null>;
  /** 执行还原到某快照点。 */
  rewindTo(snapshotId: string): Promise<RewindResult | null>;
  /** 快照占用与保留报告（/snapshots）。 */
  snapshotReport(): Promise<SnapshotUsageReport | null>;
  /** 快照过期清理（/snapshots --cleanup）。 */
  snapshotCleanup(): Promise<unknown>;
  /** 成本统计（/cost）。 */
  getCost(): Promise<{
    readonly session: CostTotals;
    readonly days: readonly DayCostTotals[];
  } | null>;
  /** MCP 服务器状态（/mcp）。 */
  getMcpStatus(): Promise<readonly McpServerStatus[]>;
  /** 探测仓库并生成 AGENTS.md 初稿（/init 预览）。 */
  planInit(): Promise<InitResult | null>;
  /** 写入 /init 生成的 AGENTS.md 初稿。 */
  writeInit(): Promise<boolean>;
  /** 当前计划模式状态（/plan 面板拉取）。 */
  getPlan(): Promise<PlanPayload>;
  /** 项目文件树（根 = cwd 下的直接子项）。 */
  getFileTree(): Promise<FileTreeResult>;
  /** 读取文件预览（相对 cwd；二进制/超限兜底）。 */
  readFile(path: string): Promise<ReadFileResult>;
  /** git 工作区未提交改动状态。 */
  getGitStatus(): Promise<GitStatusResult>;
  /** 逐文件 unified diff（相对 cwd；untracked 返回全文）。 */
  getGitDiff(path: string): Promise<GitDiffResult>;
  /** 退出应用。 */
  quit(): void;
}

declare global {
  interface Window {
    readonly modou: ModouApi;
  }
}
