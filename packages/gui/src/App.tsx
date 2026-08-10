/**
 * App：Claude Desktop 式布局的 GUI 主组件。
 *
 * 消费模型与 TUI App 完全一致：事件流是唯一输入（dispatch → reducer），
 * 用户输入转成 Command 经 sendCommand 回传 core（002 3.3 反向通道）。
 *
 * 命令结果内联化（Claude 式「像问答一样」）：斜杠命令（/help /context /cost
 * /mcp /init /rewind /snapshots /plan）的结果以**对话内卡片**呈现——紧跟用户
 * 命令消息之后，不弹窗。数据经 invoke 拉取（getContext / getCost / …），
 * 计划产出经 PLAN 通道驱动。仅保留两类模态：模型选择器、设置面板
 * （交互选择类，不是「命令结果」）。
 */
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ResumeCandidate } from '@modou/core';
import type { PlanPayload, ReadyPayload } from '../electron/ipc';
import { PERMISSION_MODE_LABEL } from '../electron/status';
import { guiReducer, initialGuiState } from './lib/state';
import { ApprovalDialog } from './components/ApprovalDialog';
import { ChatThread, type GuiCardEntry } from './components/ChatThread';
import { InputBox } from './components/InputBox';
import { SettingsPanel } from './components/SettingsPanel';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { TasksPanel, UsagePanel } from './components/UtilityPanels';
import { Welcome } from './components/Welcome';
import type { GuiCard } from './components/CommandCards';
import { applyTheme } from './lib/theme';

type ModalKind = 'none' | 'settings' | 'tasks' | 'usage';

export function App(): ReactNode {
  const [state, dispatch] = useReducer(guiReducer, undefined, initialGuiState);
  // 配置摘要（READY 通道 + 挂载时 getConfig 兜底；null = 尚无项目目录）
  const [ready, setReady] = useState<ReadyPayload | null>(null);
  const [sessions, setSessions] = useState<readonly ResumeCandidate[]>([]);
  const [modal, setModal] = useState<ModalKind>('none');
  // 命令结果卡片（对话内展示；/help /context /cost /mcp /init /rewind /plan）
  const [cards, setCards] = useState<readonly GuiCardEntry[]>([]);
  const cardSeq = useRef(0);
  // 输入框引用（Cmd+K 聚焦用）
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // 编辑消息回填（用户点消息「编辑」后写入输入框）
  const [editText, setEditText] = useState<string | null>(null);
  // 侧栏折叠（Claude 式）
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const appendCard = useCallback((card: GuiCard): void => {
    cardSeq.current += 1;
    setCards((prev) => [...prev, { id: cardSeq.current, card }]);
  }, []);
  const closeCard = useCallback((id: number): void => {
    setCards((prev) => prev.filter((entry) => entry.id !== id));
  }, []);

  // 订阅事件流 + 配置摘要 + 计划产出；挂载时用 getConfig 兜底初始状态
  useEffect(() => {
    const offEvent = window.modou.onEvent((envelope) =>
      dispatch({ type: 'envelope', envelope }),
    );
    const offReady = window.modou.onReady((payload) => {
      setReady((prev) => {
        // 切换项目 / 恢复会话：线程整体替换 + 校准累计（T-061：显示是日志的投影）
        const projectChanged = prev?.cwd !== payload.cwd;
        const sessionChanged = prev?.sessionId !== payload.sessionId;
        if (projectChanged) {
          dispatch({ type: 'app_reset' });
          setCards([]);
        } else if (sessionChanged) {
          void window.modou.getThread().then((thread) => {
            if (thread !== null) {
              dispatch({ type: 'seed_thread', messages: thread });
            }
          });
        }
        if (payload.totals !== undefined) {
          dispatch({ type: 'set_totals', totals: payload.totals });
        }
        return payload;
      });
    });
    const offPlan = window.modou.onPlan((payload: PlanPayload) => {
      // 计划产出 → 对话内计划卡片（批准/修改/拒绝）
      if (payload.plan !== null) {
        appendCard({ kind: 'plan', data: payload.plan });
      }
    });
    void window.modou.getConfig().then((config) => {
      if (config !== null) {
        setReady((prev) => ({
          ...(prev ?? { cwd: '', homeDir: '', sessionId: null, version: '' }),
          modelName: config.modelName,
          permissionMode: config.permissionMode,
          projectName: config.projectName,
        }));
      }
    });
    return () => {
      offEvent();
      offReady();
      offPlan();
    };
  }, [appendCard]);

  // 会话列表：挂载 + 项目/运行状态变化后刷新
  const refreshSessions = useCallback(() => {
    void window.modou.listSessions().then((value) => setSessions(value));
  }, []);
  useEffect(() => {
    refreshSessions();
  }, [refreshSessions, ready?.cwd, state.running]);

  // 会话标题映射（重命名；gui-state 持久化）
  const [titles, setTitles] = useState<Readonly<Record<string, string>>>({});
  const loadTitles = useCallback(() => {
    void window.modou.getSessionTitles().then((value) => setTitles(value));
  }, []);
  useEffect(() => {
    loadTitles();
  }, [loadTitles, ready?.cwd]);
  const handleRename = (sessionId: string, title: string): void => {
    void window.modou
      .renameSession(sessionId, title)
      .then((value) => setTitles(value));
  };

  // 外观：启动时恢复主题
  useEffect(() => {
    void window.modou.getTheme().then((theme) => applyTheme(theme));
  }, []);

  // ---- 侧栏操作 ----
  const handleNewChat = useCallback((): void => {
    if (state.running) return;
    window.modou.sendCommand({ type: 'slash', name: 'clear' });
  }, [state.running]);

  // 快捷键：Cmd+K 聚焦输入、Cmd+N 新对话、Cmd+, 设置、Esc 关模态
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey) {
        const key = event.key.toLowerCase();
        if (key === 'k') {
          event.preventDefault();
          inputRef.current?.focus();
          return;
        }
        if (key === 'n') {
          event.preventDefault();
          handleNewChat();
          return;
        }
        if (key === ',') {
          event.preventDefault();
          setModal('settings');
          return;
        }
        if (key === 'o' && event.shiftKey) {
          event.preventDefault();
          setModal('settings'); // 默认「模型」分类即完整模型管理
          return;
        }
        if (key === 't' && event.shiftKey) {
          event.preventDefault();
          setModal('tasks');
          return;
        }
        if (key === 'u') {
          event.preventDefault();
          setModal('usage');
          return;
        }
        if (key === '\\') {
          event.preventDefault();
          setSidebarOpen((prev) => !prev);
          return;
        }
        return;
      }
      if (event.key === 'Escape' && modal !== 'none') {
        setModal('none');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal, handleNewChat, setSidebarOpen]);

  // ---- 项目目录 ----
  const handleSelectDirectory = (): void => {
    void window.modou.selectDirectory().then((result) => {
      if (result.ok) {
        setModal('none');
        setCards([]);
        dispatch({ type: 'app_reset' });
        refreshSessions(); // READY 会随后到达并更新 ready
      }
    });
  };

  // ---- 输入提交（普通文本 → submit；/ 开头 → 斜杠命令 / 对话内结果；附件 → 多模态）----
  const handleSubmit = (raw: string, images?: readonly string[]): void => {
    if (state.running) return;
    const text = raw.trim();
    if (images !== undefined && images.length > 0) {
      dispatch({
        type: 'user_submit',
        text: text.length > 0 ? text : '（图片附件）',
      });
      window.modou.sendCommand({
        type: 'submit',
        text,
        attachments: images.map((uri) => ({ uri })),
      });
      return;
    }
    if (text.length === 0) return;
    if (text.startsWith('/')) {
      handleSlash(text);
      return;
    }
    dispatch({ type: 'user_submit', text });
    window.modou.sendCommand({ type: 'submit', text });
  };

  const handleSlash = (raw: string): void => {
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(raw);
    const name = match?.[1] ?? '';
    const args = match?.[2];
    dispatch({ type: 'user_slash', text: raw }); // 命令可见（Claude 式）
    switch (name) {
      case 'help':
        appendCard({ kind: 'help' });
        return;
      case 'model':
        if (args === undefined || args.trim().length === 0) {
          setModal('settings'); // 设置面板默认「模型」分类即完整模型管理
          return;
        }
        window.modou.sendCommand({ type: 'slash', name, args: args.trim() });
        return;
      case 'context':
        void window.modou.getContext().then((data) => {
          if (data !== null) appendCard({ kind: 'context', data });
        });
        return;
      case 'rewind':
        void window.modou
          .getSnapshots()
          .then((points) => appendCard({ kind: 'rewind', data: points }));
        return;
      case 'snapshots':
        if ((args ?? '').includes('cleanup')) {
          void window.modou.snapshotCleanup();
        }
        void window.modou.snapshotReport().then((report) => {
          if (report !== null) appendCard({ kind: 'snapshots', data: report });
        });
        return;
      case 'cost':
        void window.modou.getCost().then((data) => {
          if (data !== null) appendCard({ kind: 'cost', data });
        });
        return;
      case 'mcp':
        void window.modou
          .getMcpStatus()
          .then((data) => appendCard({ kind: 'mcp', data }));
        return;
      case 'init':
        void window.modou.planInit().then((data) => {
          if (data !== null) appendCard({ kind: 'init', data });
        });
        return;
      case 'plan':
        // 进入/退出计划模式（状态机在 bridge）；计划产出经 PLAN 通道弹卡片
        window.modou.sendCommand(
          args === undefined
            ? { type: 'slash', name }
            : { type: 'slash', name, args },
        );
        return;
      case 'clear':
        window.modou.sendCommand({ type: 'slash', name });
        return;
      default:
        window.modou.sendCommand(
          args === undefined
            ? { type: 'slash', name }
            : { type: 'slash', name, args },
        );
        return;
    }
  };

  // ---- 侧栏操作 ----
  const handleResume = (sessionId: string): void => {
    window.modou.sendCommand({
      type: 'slash',
      name: 'resume',
      args: sessionId,
    });
  };

  const handleDeleteSession = (sessionId: string): void => {
    void window.modou.deleteSession(sessionId).then(() => refreshSessions());
  };

  const handlePlanAction = (action: 'approve' | 'modify' | 'reject'): void => {
    window.modou.sendCommand({
      type:
        action === 'approve'
          ? 'plan_approve'
          : action === 'modify'
            ? 'plan_modify'
            : 'plan_reject',
    });
    setCards((prev) => prev.filter((entry) => entry.card.kind !== 'plan'));
  };

  const handleRegenerate = (): void => {
    if (state.running) return;
    dispatch({ type: 'remove_last_assistant' });
    void window.modou.regenerate();
  };

  const handleEditUser = (text: string): void => {
    setEditText(text);
    inputRef.current?.focus();
  };

  const hasProject = ready !== null;
  const modelName = ready?.modelName ?? '';
  const permissionMode = ready?.permissionMode;
  const projectName = ready?.projectName ?? '';
  const isEmpty =
    state.timeline.length === 0 && !state.running && state.error === null;

  return (
    <div className="app">
      {sidebarOpen && (
        <Sidebar
          projectName={projectName}
          hasProject={hasProject}
          currentSessionId={ready?.sessionId ?? null}
          sessions={sessions}
          running={state.running}
          titles={titles}
          onNewChat={handleNewChat}
          onResume={handleResume}
          onDelete={handleDeleteSession}
          onRename={handleRename}
          onSelectDirectory={handleSelectDirectory}
          onOpenSettings={() => setModal('settings')}
          onCollapse={() => setSidebarOpen(false)}
          onOpenTasks={() => setModal('tasks')}
          onOpenUsage={() => setModal('usage')}
        />
      )}

      <div className="main">
        {!sidebarOpen && (
          <button
            type="button"
            className="sidebar-expand"
            onClick={() => setSidebarOpen(true)}
            title="展开侧栏"
          >
            ☰
          </button>
        )}
        {!hasProject ? (
          <Welcome
            hasProject={false}
            onSelectDirectory={handleSelectDirectory}
            onSubmit={() => {}}
          />
        ) : (
          <>
            {isEmpty && cards.length === 0 ? (
              <Welcome
                hasProject
                onSelectDirectory={handleSelectDirectory}
                onSubmit={handleSubmit}
              />
            ) : (
              <ChatThread
                timeline={state.timeline}
                streamingText={state.streamingText}
                thinking={state.thinking}
                todo={state.todo}
                subagents={state.subagents}
                cards={cards}
                notices={state.notices}
                error={state.error}
                running={state.running}
                onCloseCard={closeCard}
                onPlanAction={handlePlanAction}
                onRegenerate={handleRegenerate}
                onEditUser={handleEditUser}
              />
            )}
            {state.approval !== null && (
              <ApprovalDialog
                request={state.approval}
                onApprove={(requestId, decision) =>
                  window.modou.sendCommand({
                    type: 'approve',
                    requestId,
                    decision,
                  })
                }
              />
            )}
            <InputBox
              running={state.running}
              onSubmit={handleSubmit}
              onStop={() => window.modou.sendCommand({ type: 'interrupt' })}
              inputRef={inputRef}
              externalValue={editText ?? undefined}
            />
            <StatusBar
              modelName={modelName}
              permissionMode={
                permissionMode !== undefined
                  ? PERMISSION_MODE_LABEL[permissionMode]
                  : undefined
              }
              totals={state.totals}
              running={state.running}
              turn={state.turn}
            />
          </>
        )}
      </div>

      {modal === 'settings' && (
        <SettingsPanel
          onClose={() => setModal('none')}
          onSelectDirectory={handleSelectDirectory}
          onSaved={(needRestart) => {
            if (needRestart) {
              dispatch({ type: 'app_reset' });
              setCards([]);
              refreshSessions(); // 重建后的 READY 会刷新 ready / sessionId
            }
          }}
        />
      )}
      {modal === 'tasks' && <TasksPanel onClose={() => setModal('none')} />}
      {modal === 'usage' && <UsagePanel onClose={() => setModal('none')} />}
    </div>
  );
}
