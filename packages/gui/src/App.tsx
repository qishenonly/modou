/**
 * App：Claude Desktop 式布局的 GUI 主组件。
 *
 * 消费模型与 TUI App 完全一致：事件流是唯一输入（dispatch → reducer），
 * 用户输入转成 Command 经 sendCommand 回传 core（002 3.3 反向通道）。
 * UI 模态（模型选择 / 设置 / 上下文 / 帮助）是渲染进程驱动的本地弹窗。
 *
 * 项目目录：无项目时显示欢迎页（选择项目目录）；选定后 READY 携带 cwd，
 * 切换项目时整体重置（app_reset）并重新拉取会话列表。
 */
import {
  useCallback,
  useEffect,
  useReducer,
  useState,
  type ReactNode,
} from 'react';
import type { ResumeCandidate } from '@modou/core';
import type { ReadyPayload } from '../electron/ipc';
import { PERMISSION_MODE_LABEL } from '../electron/status';
import { guiReducer, initialGuiState } from './lib/state';
import { ApprovalDialog } from './components/ApprovalDialog';
import { ChatThread } from './components/ChatThread';
import { ContextPanel } from './components/ContextPanel';
import { HelpPanel } from './components/HelpPanel';
import { InputBox } from './components/InputBox';
import { ModelPicker } from './components/ModelPicker';
import { SettingsPanel } from './components/SettingsPanel';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { Welcome } from './components/Welcome';

type ModalKind = 'none' | 'settings' | 'model' | 'context' | 'help';

export function App(): ReactNode {
  const [state, dispatch] = useReducer(guiReducer, undefined, initialGuiState);
  // 配置摘要（READY 通道 + 挂载时 getConfig 兜底；null = 尚无项目目录）
  const [ready, setReady] = useState<ReadyPayload | null>(null);
  const [sessions, setSessions] = useState<readonly ResumeCandidate[]>([]);
  const [modal, setModal] = useState<ModalKind>('none');

  // 订阅事件流 + 配置摘要；挂载时用 getConfig 兜底初始状态（主进程启动期 READY
  // 可能在渲染进程挂载前发出——getConfig 与 READY 同源，漏掉也不影响）
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
    </div>
  );
}
