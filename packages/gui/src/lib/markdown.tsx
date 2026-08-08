/**
 * 流式 markdown 渲染（react-markdown + remark-gfm）。
 *
 * 只做展示，绝不注入原始 HTML（react-markdown 默认不渲染 raw HTML，规避模型
 * 输出里混入脚本的风险）。代码块带语言标签与复制按钮；链接新窗口打开。
 */
import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function CodeBlock({
  language,
  text,
}: {
  readonly language: string;
  readonly text: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用（权限/环境）时静默降级，不打断阅读
    }
  };

  return (
    <div className="code-block">
      <div className="code-block-head">
        <span className="code-lang">{language}</span>
        <button type="button" className="code-copy" onClick={() => void copy()}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="code-body">
        <code>{text}</code>
      </pre>
    </div>
  );
}

/** Markdown 组件（memo：流式增量时只重渲染内容变化的实例）。 */
export const Markdown = memo(function Markdown({
  text,
}: {
  readonly text: string;
}): ReactNode {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          code({ className, children }) {
            const language = /language-(\w+)/.exec(className ?? '')?.[1] ?? '';
            const code = String(children).replace(/\n$/, '');
            if (language.length > 0) {
              return <CodeBlock language={language} text={code} />;
            }
            return <code className="md-inline-code">{children}</code>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
