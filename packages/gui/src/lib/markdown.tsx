/**
 * 流式 markdown 渲染（react-markdown + remark-gfm + highlight.js）。
 *
 * 安全：react-markdown 默认不渲染 raw HTML（模型输出里的标签按文本显示）；
 * 代码块用 highlight.js 高亮——hljs 先转义代码内容再生成带 class 的 span，
 * 不会把模型输出里的脚本当 HTML 注入。代码块带语言标签与复制按钮；链接新窗口打开。
 */
import { memo, useState, useMemo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js';
import 'highlight.js/styles/github.css';

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

  // 语言自动高亮：有语言标签用对应语法，否则自动检测
  const html = useMemo(() => {
    try {
      if (language.length > 0 && hljs.getLanguage(language)) {
        return hljs.highlight(text, { language }).value;
      }
      return hljs.highlightAuto(text).value;
    } catch {
      return text;
    }
  }, [language, text]);

  return (
    <div className="code-block">
      <div className="code-block-head">
        <span className="code-lang">{language || 'code'}</span>
        <button type="button" className="code-copy" onClick={() => void copy()}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="code-body">
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
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
          // 块级代码（含无语言标签的 fenced block）统一走 CodeBlock：带语言标签
          // 用对应语法，无标签自动检测；两者都保留「复制」按钮。行内代码仍由
          // code 组件兜底渲染（无 pre 包裹的才是行内）。
          pre({ children }) {
            const child = Array.isArray(children) ? children[0] : children;
            if (
              child !== null &&
              typeof child === 'object' &&
              'props' in child
            ) {
              const props = (
                child as {
                  readonly props?: {
                    readonly className?: unknown;
                    readonly children?: unknown;
                  };
                }
              ).props;
              if (props !== undefined && typeof props === 'object') {
                const className =
                  typeof props.className === 'string' ? props.className : '';
                const language = /language-(\w+)/.exec(className)?.[1] ?? '';
                const raw = props.children;
                const code = (
                  Array.isArray(raw)
                    ? raw.join('')
                    : typeof raw === 'string'
                      ? raw
                      : ''
                ).replace(/\n$/, '');
                return <CodeBlock language={language} text={code} />;
              }
            }
            // 非代码块内容（罕见）回退默认 pre
            return <pre>{children}</pre>;
          },
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
