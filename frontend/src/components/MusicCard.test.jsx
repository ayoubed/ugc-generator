import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import MusicCard from './MusicCard';
import { updateProjectSettings } from '../hooks/useProject';

vi.mock('../hooks/useProject', () => ({ updateProjectSettings: vi.fn(async () => {}) }));
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { uid: 'u1' } }) }));
vi.mock('../hooks/useModels', () => ({ useModels: () => ({ musicModels: [], defaultMusicModel: '' }) }));
vi.mock('../services/api', () => ({ generateMusic: vi.fn() }));

const project = (volume) => ({
  id: 'p1',
  settings: { music: { source: 'upload', storageRef: 'm.mp3', url: 'https://files.test/m.mp3', name: 'Track', volume } },
});
const slider = () => screen.getByLabelText('Volume under the voice');

beforeEach(() => vi.clearAllMocks());

describe('music volume', () => {
  it('shows a level saved before the slider existed at the same loudness', () => {
    render(<MusicCard project={project('high')} now={Date.now()} />);
    expect(slider().value).toBe('64');
    expect(screen.getByText('64%')).toBeTruthy();
  });

  it('saves the new volume as a number when the slider is let go, not while dragging', () => {
    render(<MusicCard project={project(40)} now={Date.now()} />);
    fireEvent.change(slider(), { target: { value: '55' } });
    fireEvent.change(slider(), { target: { value: '70' } });
    expect(screen.getByText('70%')).toBeTruthy();
    expect(updateProjectSettings).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider());
    expect(updateProjectSettings).toHaveBeenCalledTimes(1);
    expect(updateProjectSettings.mock.calls[0][1].music.volume).toBe(70);
  });

  it('saves nothing when the volume ends where it was', () => {
    render(<MusicCard project={project(40)} now={Date.now()} />);
    fireEvent.change(slider(), { target: { value: '40' } });
    fireEvent.blur(slider());
    expect(updateProjectSettings).not.toHaveBeenCalled();
  });

  it('has no slider without a track', () => {
    render(<MusicCard project={{ id: 'p1', settings: {} }} now={Date.now()} />);
    expect(screen.queryByLabelText('Volume under the voice')).toBeNull();
  });
});
