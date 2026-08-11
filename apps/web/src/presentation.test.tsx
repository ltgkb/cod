import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { chatFailureMessage } from './chat-errors';
import { MarkdownContent } from './presentation';

describe('MarkdownContent', () => {
  it('renders Markdown lists and GFM tables instead of exposing syntax markers', () => {
    const { container } = render(<MarkdownContent>{'* 第一项\n* 第二项\n\n| 列一 | 列二 |\n| --- | --- |\n| A | B |'}</MarkdownContent>);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('table')).not.toBeNull();
    expect(container.textContent).not.toContain('* 第一项');
    expect(container.textContent).not.toContain('| 列一 |');
  });

  it('does not render raw HTML from model output', () => {
    const { container } = render(<MarkdownContent>{'<script>window.pwned = true</script>安全内容'}</MarkdownContent>);
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('安全内容');
  });
});

describe('chatFailureMessage', () => {
  it('maps COD balance errors returned through the API', () => {
    expect(chatFailureMessage(new ApiError('Insufficient balance', 402, 'insufficient_balance'))).toContain('COD 可用额度不足');
  });

  it('maps Goose provider-credit wording back to the COD wallet', () => {
    expect(chatFailureMessage(new Error('Please check your account with your provider to add more credits, then resend your message to continue.'))).toContain('最后一次失败请求未扣费');
  });
});
