/**
 * App：Claude Desktop 式布局的 GUI 主组件。
 *
 * 消费模型与 TUI App 完全一致：事件流是唯一输入（dispatch → reducer），
 * 用户输入转成 Command 经 sendCommand 回传 core（002 3.3 反向通道）。
 * UI 模态（模型 / 设置 / 上下文 / 帮助 / 计划 / 快照 / 成本 / MCP / init）是
 * 渲染进程驱动的本地弹窗，拉取型数据走 invoke 查询。
 *
 * 0.10–0.17 功能接线：
 * - /rewind /snapshots /cost /mcp /init → 本地面板（invoke 拉取）；
 * - /plan → 发送 slash（进入/退出计划模式），计划产出经 PLAN 通道自动弹面板；
 * - todo_update / 子代理信封（agent ≠ main）由 reducer 规约，ChatThread 渲染。
 */
import {
  useCallback,
  useEffect,
  useReducer,
  useState,
  type ReactNode,
} from 'react';
import type { ResumeCandidate } from '@modou/core';
import type { PlanPayload, ReadyPayload } from '../electron/ipc';
import { PERMISSION_MODE_LABEL } from '../electron/status';
import { guiReducer, initialGuiState } from './lib/state';
import { ApprovalDialog } from './components/ApprovalDialog';
import { ChatThread } from './components/ChatThread';
import { ContextPanel } from './components/ContextPanel';
import { CostPanel } from './components/CostPanel';
import { HelpPanel } from './components/HelpPanel';
import { InitPanel } from './components/InitPanel';
import { InputBox } from './components/InputBox';
import { McpPanel } from './components/McpPanel';
import { ModelPicker } from './components/ModelPicker';
import { PlanPanel } from './components/PlanPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { Sidebar } from './components/Sidebar';
import { SnapshotPanel } from './components/SnapshotPanel';
import { StatusBar } from './components/StatusBar';
import { Welcome } from './components/Welcome';

type ModalKind =
  | 'none'
  | 'settings'
  | 'model'
  | 'context'
  | 'help'
  | 'rewind'
  | 'cost'
  | 'mcp'
  | 'init';

export function App(): ReactNode {
  const [state, dispatch] = useReducer(guiReducer, undefined, initialGuiState);
  // 配置摘要（READY 通道 + 挂载时 getConfig 兜底；null = 尚无项目目录）
  const [ready, setReady] = useState<ReadyPayload | null>(null);
  const [sessions, setSessions] = useState<readonly ResumeCandidate[]>([]);
  const [modal, setModal] = useState<ModalKind>('none');
  // 计划面板（PLAN 通道：计划产出后自动弹出；null = 面板关闭）
  const [planPayload, setPlanPayload] = useState<PlanPayload | null>(null);

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
    const offPlan = window.modou.onPlan((payload) => {
      setPlanPayload(payload);
      if (payload.plan !== null) setModal('none'); // 计划面板单独渲染，盖住其他模态
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
  }, []);

  // 会话列表：挂载 + 项目/运行状态变化后刷新
  const refreshSessions = useCallback(() => {
    void window.modou.listSessions().then((value) => setSessions(value));
  }, []);
  useEffect(() => {
    refreshSessions();
  }, [refreshSessions, ready?.cwd, state.running]);

  // ---- 项目目录 ----
  const handleSelectDirectory = (): void => {
    void window.modou.selectDirectory().then((result) => {
      if (result.ok) {
        setModal('none');
        setPlanPayload(null);
        dispatch({ type: 'app_reset' });
        refreshSessions(); // READY 会随后到达并更新 ready
      }
    });
  };

  // ---- 输入提交（普通文本 → submit；/ 开头 → 斜杠命令 / 本地 UI 模态）----
  const handleSubmit = (raw: string): void => {
    if (state.running) return;
    const text = raw.trim();
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
        setModal('help');
        return;
      case 'model':
        if (args === undefined || args.trim().length === 0) {
          setModal('model');
          return;
        }
        window.modou.sendCommand({ type: 'slash', name, args: args.trim() });
        return;
      case 'context':
        setModal('context');
        return;
      case 'rewind':
        setModal('rewind');
        return;
      case 'snapshots':
        // 快照占用报告并入 /rewind 面板（含 --cleanup 由主进程处理）
        window.modou.sendCommand({ type: 'slash', name });
        setModal('rewind');
        return;
      case 'cost':
        setModal('cost');
        return;
      case 'mcp':
        setModal('mcp');
        return;
      case 'init':
        setModal('init');
        return;
      case 'plan':
        // 进入/退出计划模式；计划产出经 PLAN 通道弹面板
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
  const handleNewChat = (): void => {
    if (state.running) return;
    window.modou.sendCommand({ type: 'slash', name: 'clear' });
  };

  const handleResume = (sessionId: string): void => {
    window.modou.sendCommand({
      type: 'slash',
      name: 'resume',
      args: sessionId,
    });
    setModal('none');
  };

  const handleDeleteSession = (sessionId: string): void => {
    void window.modou.deleteSession(sessionId).then(() => refreshSessions());
  };

  const hasProject = ready !== null;
  const modelName = ready?.modelName ?? '';
  const permissionMode = ready?.permissionMode;
  const projectName = ready?.projectName ?? '';
  const isEmpty =
    state.history.length === 0 && !state.running && state.error === null;

  return (
    <div className="app">
      <Sidebar
        projectName={projectName}
        hasProject={hasProject}
        currentSessionId={ready?.sessionId ?? null}
        sessions={sessions}
        running={state.running}
        modelName={modelName}
        onNewChat={handleNewChat}
        onResume={handleResume}
        onDelete={handleDeleteSession}
        onSelectDirectory={handleSelectDirectory}
        onOpenModel={() => setModal('model')}
        onOpenSettings={() => setModal('settings')}
      />

      <div className="main">
        {!hasProject ? (
          <Welcome
            hasProject={false}
            onSelectDirectory={handleSelectDirectory}
            onSubmit={() => {}}
          />
        ) : (
          <>
            {isEmpty ? (
              <Welcome
                hasProject
                onSelectDirectory={handleSelectDirectory}
                onSubmit={handleSubmit}
              />
            ) : (
              <ChatThread
                history={state.history}
                streamingText={state.streamingText}
                thinking={state.thinking}
                tools={state.tools}
                todo={state.todo}
                subagents={state.subagents}
                notices={state.notices}
                error={state.error}
                running={state.running}
              />
            )}
            <InputBox
              running={state.running}
              onSubmit={handleSubmit}
              onStop={() => window.modou.sendCommand({ type: 'interrupt' })}
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

      {/* 审批弹窗（模态；打开时其他交互让位） */}
      {state.approval !== null && (
        <ApprovalDialog
          request={state.approval}
          onApprove={(requestId, decision) =>
            window.modou.sendCommand({ type: 'approve', requestId, decision })
          }
        />
      )}

      {/* 计划面板（PLAN 通道驱动；批准/修改/拒绝经 plan_* 命令回传） */}
      {planPayload !== null && planPayload.plan !== null && (
        <PlanPanel
          plan={planPayload.plan}
          onApprove={() => {
            window.modou.sendCommand({ type: 'plan_approve' });
            setPlanPayload(null);
          }}
          onModify={() => {
            window.modou.sendCommand({ type: 'plan_modify' });
            setPlanPayload(null);
          }}
          onReject={() => {
            window.modou.sendCommand({ type: 'plan_reject' });
            setPlanPayload(null);
          }}
          onClose={() => setPlanPayload(null)}
        />
      )}

      {modal === 'settings' && (
        <SettingsPanel
          onClose={() => setModal('none')}
          onSelectDirectory={handleSelectDirectory}
        />
      )}
      {modal === 'model' && (
        <ModelPicker
          currentModel={modelName}
          onClose={() => setModal('none')}
        />
      )}
      {modal === 'context' && <ContextPanel onClose={() => setModal('none')} />}
      {modal === 'help' && <HelpPanel onClose={() => setModal('none')} />}
      {modal === 'rewind' && <SnapshotPanel onClose={() => setModal('none')} />}
      {modal === 'cost' && <CostPanel onClose={() => setModal('none')} />}
      {modal === 'mcp' && <McpPanel onClose={() => setModal('none')} />}
      {modal === 'init' && <InitPanel onClose={() => setModal('none')} />}
    </div>
  );
}
