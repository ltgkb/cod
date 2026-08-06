import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';

afterEach(() => cleanup());

describe('COD workspace', () => {
  it('renders the core task, conversation, and review surfaces', () => {
    render(<App />);
    expect(screen.getByText('COD')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '打磨 COD 桌面工作台' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /改动/ })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/让 COD 修改/)).toBeInTheDocument();
  });
});
