import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { openCodExternalUrl } from './runtime';

export function MarkdownContent({ children, className = '' }: { children: string; className?: string }): ReactNode {
  return (
    <div className={`markdown-content ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children: label, href }) => <button type="button" className="markdown-link" onClick={() => { if (href) void openCodExternalUrl(href); }}>{label}</button>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
