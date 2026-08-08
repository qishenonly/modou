/**
 * 欢迎页（Claude Desktop 空状态）：无项目目录时的首屏——
 * 大 logo + 「选择项目目录」主按钮（一个目录 = 一个项目），
 * 以及有项目但会话为空时的建议卡片。
 */
import { type ReactNode } from 'react';
import { LogoMark } from './LogoMark';

const SUGGESTIONS: readonly string[] = [
  '介绍一下这个项目的结构',
  '帮我找出项目里的 bug 并修复',
  '给核心模块补充单元测试',
  '写一个 README 说明如何运行',
];

export function Welcome({
  hasProject,
  onSelectDirectory,
  onSubmit,
}: {
  readonly hasProject: boolean;
  readonly onSelectDirectory: () => void;
  readonly onSubmit: (text: string) => void;
}): ReactNode {
  return (
    <main className="welcome">
      <div className="welcome-inner">
        <LogoMark size={64} className="welcome-logo" />
        <h1 className="welcome-title">
          {hasProject ? '有什么我可以帮你？' : '选择项目目录以开始'}
        </h1>
        <p className="welcome-sub">
          {hasProject
            ? 'modou 会读懂你的项目，替你在目录里改文件、跑命令。'
            : '一个目录 = 一个项目；modou 只在所选目录内读写文件与执行命令。'}
        </p>

        {!hasProject && (
          <button
            type="button"
            className="btn btn-primary btn-lg"
            onClick={onSelectDirectory}
          >
            选择项目目录
          </button>
        )}

        {hasProject && (
          <div className="suggestions">
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className="suggestion-card"
                onClick={() => onSubmit(suggestion)}
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}

        <p className="welcome-hint">
          {hasProject
            ? '或直接在下方输入任务，Enter 发送。'
            : '选择后 modou 会在该目录启动一个 agent；随时可在左侧切换项目。'}
        </p>
      </div>
    </main>
  );
}
