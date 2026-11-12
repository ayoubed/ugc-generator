import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';

const authState = { user: { uid: 'u1', email: 'ana@example.com' }, loading: false, access: 'allowed', signOut: vi.fn(), retryAccessCheck: vi.fn() };
vi.mock('./hooks/useAuth', () => ({ useAuth: () => authState }));
vi.mock('./pages/LoginPage', () => ({ default: () => <p>login page</p> }));
vi.mock('./pages/DashboardPage', () => ({ default: () => <p>dashboard page</p> }));
vi.mock('./pages/CreatePage', () => ({ default: () => <p>idea page</p> }));
vi.mock('./pages/EditScenesPage', () => ({ default: () => <p>script page</p> }));
vi.mock('./pages/GeneratePage', () => ({ default: () => <p>generate page</p> }));
vi.mock('./pages/VideoPage', () => ({ default: () => <p>video page</p> }));

const open = (path) => render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);

beforeEach(() => {
  Object.assign(authState, { user: { uid: 'u1', email: 'ana@example.com' }, loading: false, access: 'allowed' });
});

describe('routes', () => {
  it('opens the four steps', () => {
    open('/project/p1/create');
    expect(screen.getByText('idea page')).toBeTruthy();
    open('/project/p1/video');
    expect(screen.getByText('video page')).toBeTruthy();
  });

  it.each(['/project/p1/finish', '/project/p1/export'])('sends the old %s link to the Video step', (path) => {
    open(path);
    expect(screen.getByText('video page')).toBeTruthy();
  });

  it('sends a signed-out visitor to the sign-in page', () => {
    authState.user = null;
    open('/project/p1/video');
    expect(screen.getByText('login page')).toBeTruthy();
  });
});

describe('access', () => {
  it('shows a short no-access screen with a way to reach the team', () => {
    authState.access = 'denied';
    open('/');
    expect(screen.queryByText('dashboard page')).toBeNull();
    expect(screen.getByRole('heading', { name: /doesn.t have access/i })).toBeTruthy();
    expect(screen.getByText(/ana@example\.com isn.t on the access list/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Talk to the team' }).getAttribute('href')).toBe('https://eleviat.com/#apply');
    expect(screen.getByRole('button', { name: 'Use a different account' })).toBeTruthy();
  });

  it('offers a retry when access could not be checked', () => {
    authState.access = 'error';
    open('/');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Talk to the team' })).toBeNull();
  });
});
