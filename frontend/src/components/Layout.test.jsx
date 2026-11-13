import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Layout from './Layout';

const auth = { user: { uid: 'u1', displayName: 'Ana', email: 'ana@example.com' }, signOut: vi.fn() };
vi.mock('../hooks/useAuth', () => ({ useAuth: () => auth }));

const show = () => {
  render(<MemoryRouter><Layout><p>page</p></Layout></MemoryRouter>);
  return screen.getByRole('button', { name: 'Dark theme' });
};

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  auth.user = { uid: 'u1', displayName: 'Ana', email: 'ana@example.com' };
});

describe('theme toggle in the header', () => {
  it('starts on light', () => {
    const toggle = show();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.getAttribute('title')).toBe('Switch to the dark theme');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('switches to dark and back with one click each, and remembers it', async () => {
    const toggle = show();
    await userEvent.click(toggle);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(window.localStorage.getItem('eleviat-theme')).toBe('dark');

    await userEvent.click(toggle);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem('eleviat-theme')).toBe('light');
  });

  it('opens in the theme chosen last time', () => {
    window.localStorage.setItem('eleviat-theme', 'dark');
    expect(show().getAttribute('aria-pressed')).toBe('true');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('sits next to the account menu, not inside it', async () => {
    show();
    await userEvent.click(screen.getByRole('button', { name: /Ana/ }));
    expect(screen.queryByRole('group', { name: 'Theme' })).toBeNull();
    expect(screen.getByText('Sign Out')).toBeTruthy();
  });

  it('is there before signing in too', () => {
    auth.user = null;
    expect(show()).toBeTruthy();
  });
});
