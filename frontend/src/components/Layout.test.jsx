import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Layout from './Layout';

vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { uid: 'u1', displayName: 'Ana', email: 'ana@example.com' }, signOut: vi.fn() }) }));

const openMenu = async () => {
  render(<MemoryRouter><Layout><p>page</p></Layout></MemoryRouter>);
  await userEvent.click(screen.getByRole('button', { name: /Ana/ }));
  return within(screen.getByRole('group', { name: 'Theme' }));
};

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe('theme switch in the account menu', () => {
  it('starts on light', async () => {
    const theme = await openMenu();
    expect(theme.getByRole('button', { name: 'Light' }).getAttribute('aria-pressed')).toBe('true');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('switches the page to dark and remembers it', async () => {
    const theme = await openMenu();
    await userEvent.click(theme.getByRole('button', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(theme.getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe('true');
    expect(window.localStorage.getItem('eleviat-theme')).toBe('dark');
  });

  it('opens in the theme chosen last time', async () => {
    window.localStorage.setItem('eleviat-theme', 'dark');
    const theme = await openMenu();
    expect(theme.getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe('true');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('can follow the device', async () => {
    window.matchMedia = (query) => ({ matches: query === '(prefers-color-scheme: dark)', addEventListener() {}, removeEventListener() {} });
    try {
      const theme = await openMenu();
      await userEvent.click(theme.getByRole('button', { name: 'Device' }));
      expect(document.documentElement.dataset.theme).toBe('dark');
    } finally {
      delete window.matchMedia;
    }
  });
});
