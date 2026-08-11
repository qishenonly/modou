/**
 * 底部细状态栏：模型（可点击下拉切换）/ 权限模式 / 运行状态 / 当前轮次 /
 * 累计 token。Claude Desktop 没有状态栏，这里是 modou 的最小信息条（细、弱化）；
 * 模型下拉复用 getProviders / setActiveModel（与模型管理面板同一数据面）。
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { ProviderState } from '../../electron/ipc';
import { formatTokens } from '../lib/format';

export function StatusBar({
  modelName,
  permissionMode,
  totals,
  running,
  turn,
}: {
  readonly modelName?: string;
  readonly permissionMode?: string;
  readonly totals: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
  };
  readonly running: boolean;
  readonly turn: number;
}): ReactNode {
  const [modelOpen, setModelOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderState | null>(null);

  // 打开模型下拉时拉取供应商 + 候选模型（轻量；与模型管理面板同源）
  useEffect(() => {
    if (modelOpen && providers === null) {
      void window.modou.getProviders().then(setProviders);
    }
  }, [modelOpen, providers]);

  const segments: string[] = [];
  if (permissionMode !== undefined) segments.push(permissionMode);
  segments.push(running ? '运行中' : '就绪');
  segments.push(`turn ${turn}`);
  segments.push(
    `in ${formatTokens(totals.inputTokens)} / out ${formatTokens(totals.outputTokens)}`,
  );
  if (totals.cacheReadTokens > 0) {
    segments.push(`cache +${formatTokens(totals.cacheReadTokens)}`);
  }

  // 模型候选：各供应商的模型 ID，当前生效的标记「当前」
  const candidates: readonly {
    readonly providerName: string;
    readonly providerId: string;
    readonly model: string;
    readonly active: boolean;
  }[] =
    providers === null
      ? []
      : providers.providers.flatMap((provider) =>
          provider.models.map((model) => ({
            providerName: provider.name,
            providerId: provider.id,
            model,
            active:
              providers.active?.providerId === provider.id &&
              providers.active.model === model,
          })),
        );

  return (
    <footer className="statusbar">
      <span className={`status-dot${running ? ' status-running' : ''}`}>
        {running ? '●' : '○'}
      </span>

      {/* 模型名 → 下拉切换（Claude/Codex 顶部模型选择器的极简版） */}
      <div className="status-model-wrap">
        <button
          type="button"
          className="status-model"
          onClick={() => setModelOpen((prev) => !prev)}
          title="切换模型"
        >
          {modelName ?? '未配置模型'}
          <svg
            viewBox="0 0 16 16"
            className="status-model-chevron"
            aria-hidden="true"
          >
            <path
              d="M4.5 6.5 8 10l3.5-3.5"
              stroke="currentColor"
              strokeWidth="1.5"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        {modelOpen && (
          <>
            <div
              className="status-model-overlay"
              onClick={() => setModelOpen(false)}
            />
            <div className="status-model-pop">
              {candidates.length === 0 ? (
                <div className="status-model-empty">
                  {providers === null
                    ? '加载中…'
                    : '还没有模型；到「设置 → 模型」添加。'}
                </div>
              ) : (
                candidates.map((candidate, index) => (
                  <button
                    key={`${candidate.providerId}-${candidate.model}-${index}`}
                    type="button"
                    className={`status-model-option${candidate.active ? ' status-model-active' : ''}`}
                    onClick={() => {
                      setModelOpen(false);
                      void window.modou.setActiveModel({
                        providerId: candidate.providerId,
                        model: candidate.model,
                      });
                    }}
                  >
                    <span className="status-model-id">{candidate.model}</span>
                    <span className="status-model-provider">
                      {candidate.providerName}
                    </span>
                    {candidate.active && (
                      <span className="picker-tag">当前</span>
                    )}
                  </button>
                ))
              )}
            </div>
          </>
        )}
      </div>

      <span>{segments.join(' · ')}</span>
    </footer>
  );
}
