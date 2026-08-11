import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function MarkdownContent({ children, className = '' }: { children: string; className?: string }): ReactNode {
  return (
    <div className={`markdown-content ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children: label, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{label}</a>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
