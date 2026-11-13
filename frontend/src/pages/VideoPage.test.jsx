import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import VideoPage from './VideoPage';
import { stitchVideos } from '../services/api';

// The page reads the project and its scenes through these hooks; each test sets what they return.
const data = { project: null, scenes: [] };
// What the voice service offers; a test replaces the fields it needs.
const voiceList = { available: false, voices: [], loading: false, error: '' };
vi.mock('../hooks/useProject', () => ({
  useProject: () => ({ project: data.project, loading: false }),
  useScenes: () => ({ scenes: data.scenes, loading: false }),
  updateProjectSettings: vi.fn(async () => {}),
  createProject: vi.fn(async () => 'new-project'),
}));
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { uid: 'u1' } }) }));
vi.mock('../hooks/useModels', () => ({ useModels: () => ({ musicModels: [], defaultMusicModel: '' }) }));
vi.mock('../hooks/useVoices', () => ({ useVoices: () => voiceList }));
vi.mock('../hooks/useDoneNotifications', () => ({ useDoneNotifications: () => {} }));
vi.mock('../utils/notify', () => ({ askToNotify: vi.fn(), notifyDone: vi.fn() }));
vi.mock('../services/api', () => ({
  stitchVideos: vi.fn(async () => ({})),
  generateMusic: vi.fn(),
  exportPackage: vi.fn(async () => ({})),
  resolveStorageUrl: vi.fn(async (path) => `https://files.test/${path}`),
}));

const scene = (id, extra = {}) => ({ id, script: `Line ${id}.`, storageRef: `scene${id}.mp4`, activeAttempt: 1, ...extra });
const version = (number, extra = {}) => ({
  version: number,
  storageRef: `final_v${number}.mp4`,
  createdAt: '2026-11-12T10:00:00Z',
  scenes: [{ sceneId: '0', attempt: 1 }, { sceneId: '1', attempt: 1 }],
  captions: 'highlight',
  tightCuts: true,
  endCard: null,
  music: null,
  captionTexts: { 0: 'Line 0.', 1: 'Line 1.' },
  ...extra,
});

function open({ project = {}, scenes = [scene('0'), scene('1')] } = {}) {
  data.project = { id: 'p1', userId: 'u1', title: 'Mug ad', status: 'scripted', settings: {}, ...project };
  data.scenes = scenes;
  render(
    <MemoryRouter initialEntries={['/project/p1/video']}>
      <Routes>
        <Route path="/project/:id/video" element={<VideoPage />} />
        <Route path="/project/:id/generate" element={<p>generate page</p>} />
      </Routes>
    </MemoryRouter>,
  );
  // The bottom bar, when the page has one (it has none without scenes).
  const bar = screen.queryByRole('region', { name: 'Stitch the final video' });
  return bar ? within(bar) : null;
}

beforeEach(() => vi.clearAllMocks());

describe('Video step: before the first stitch', () => {
  it('offers to stitch when every scene has a video, and starts the stitch in place', async () => {
    const bar = open();
    const stitch = bar.getByRole('button', { name: 'Stitch final video' });
    expect(stitch.disabled).toBe(false);
    expect(bar.getByText('2/2 ready')).toBeTruthy();
    expect(screen.getByText('Your video appears here once it is stitched.')).toBeTruthy();

    await userEvent.click(stitch);
    expect(stitchVideos).toHaveBeenCalledWith('p1');
    expect(screen.queryByText('generate page')).toBeNull();   // still on the Video step
  });

  it('says which scene is missing and does not let you stitch', () => {
    const bar = open({ scenes: [scene('0'), scene('1', { storageRef: '' })] });
    expect(bar.getByRole('button', { name: 'Stitch final video' }).disabled).toBe(true);
    expect(bar.getByText(/Scene 2 needs a video\. Finish them on the Generate step first\./)).toBeTruthy();
  });

  it('leaves skipped scenes out of the count', () => {
    const bar = open({ scenes: [scene('0'), scene('1', { storageRef: '', skipped: true })] });
    expect(bar.getByText('1/1 ready')).toBeTruthy();
    expect(bar.getByRole('button', { name: 'Stitch final video' }).disabled).toBe(false);
  });

  it('shows the choices on the same page: captions, music and end card', () => {
    open();
    expect(screen.getByRole('heading', { name: 'Captions and cuts' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Background music' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'End card' })).toBeTruthy();
  });

  it('goes back to Generate from the bar', async () => {
    const bar = open();
    await userEvent.click(bar.getByRole('button', { name: '← Generate' }));
    expect(await screen.findByText('generate page')).toBeTruthy();
  });
});

describe('Video step: with a final video', () => {
  const stitched = { finalVideos: [version(1)], finalVideoVersion: 1, status: 'completed' };

  it('offers the download, not another stitch, when the video is up to date', async () => {
    const bar = open({ project: stitched });
    expect(screen.getByRole('heading', { name: 'Version 1' })).toBeTruthy();
    expect(bar.queryByRole('button', { name: /stitch/i })).toBeNull();
    expect(bar.getByText('Version 1 already has these choices.')).toBeTruthy();
    await waitFor(() => expect(bar.getByRole('button', { name: 'Download' }).disabled).toBe(false));
  });

  it('asks for a new stitch and says why after a choice changed', () => {
    const bar = open({ project: { ...stitched, settings: { captions: { style: 'pop' } } } });
    expect(bar.getByRole('button', { name: 'Stitch new version' }).disabled).toBe(false);
    expect(bar.getByText('The caption style changed since this version was stitched.')).toBeTruthy();
    expect(screen.getByText('Out of date.')).toBeTruthy();
  });

  it('asks for a new stitch after a scene switched to another take', () => {
    const bar = open({ project: stitched, scenes: [scene('0'), scene('1', { activeAttempt: 2 })] });
    expect(bar.getByText('Scene 2 uses a different take than this version.')).toBeTruthy();
    expect(screen.getByText('Now uses take 2')).toBeTruthy();
  });

  it('shows progress and blocks a second stitch while one is running', () => {
    const bar = open({ project: { ...stitched, status: 'stitching', stitchStartedAt: Date.now() } });
    expect(bar.getByRole('button', { name: 'Stitching…' }).disabled).toBe(true);
    expect(screen.getByText(/Stitching a new version/)).toBeTruthy();
  });

  it('reports a failed stitch in plain words and lets you try again', () => {
    const bar = open({ project: { ...stitched, stitchError: 'The model is busy. Try again.' } });
    expect(bar.getByText('The last stitch failed: The model is busy. Try again.')).toBeTruthy();
    expect(bar.getByRole('button', { name: 'Stitch new version' }).disabled).toBe(false);
  });

  it('keeps earlier versions and lets you look at one', async () => {
    open({ project: { finalVideos: [version(1), version(2)], finalVideoVersion: 2, status: 'completed' } });
    expect(screen.getByRole('heading', { name: 'Version 2' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Version 1/ }));
    expect(screen.getByRole('heading', { name: 'Version 1' })).toBeTruthy();
    expect(screen.getByText('Older version')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Show the latest version' }));
    expect(screen.getByRole('heading', { name: 'Version 2' })).toBeTruthy();
  });
});

describe('Video step: nothing to show', () => {
  it('points to the Script step when there are no scenes', () => {
    const bar = open({ scenes: [] });
    expect(screen.getByRole('heading', { name: 'No scenes yet' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Go to Script' })).toBeTruthy();
    expect(bar).toBeNull();
  });
});

describe('Video step: one voice', () => {
  const stitched = { finalVideos: [version(1, { voice: null })], finalVideoVersion: 1, status: 'completed' };

  it('does not show the voice choice without a voice service', () => {
    Object.assign(voiceList, { available: false, voices: [] });
    open();
    expect(screen.queryByRole('heading', { name: 'Voice' })).toBeNull();
  });

  it('offers it next to captions and music when the service is set up', () => {
    Object.assign(voiceList, { available: true, voices: [{ id: 'v1', name: 'Rachel', description: '', previewUrl: '' }] });
    open();
    expect(screen.getByRole('heading', { name: 'Voice' })).toBeTruthy();
    expect(screen.getByLabelText('Voice for the whole video').value).toBe('');
    Object.assign(voiceList, { available: false, voices: [] });
  });

  it('asks for a new stitch after a voice was picked', () => {
    const bar = open({ project: { ...stitched, settings: { voice: { id: 'v1', name: 'Rachel' } } } });
    expect(bar.getByText('The voice changed since this version was stitched.')).toBeTruthy();
    expect(bar.getByRole('button', { name: 'Stitch new version' }).disabled).toBe(false);
  });
});
