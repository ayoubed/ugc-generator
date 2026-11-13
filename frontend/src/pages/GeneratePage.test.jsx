import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import GeneratePage from './GeneratePage';
import { cancelGenerateAll, generateAllScenes } from '../services/api';

// The page reads the project and its scenes through these hooks; each test sets what they return.
const data = { project: null, scenes: [] };
vi.mock('../hooks/useProject', () => ({
  useProject: () => ({ project: data.project, loading: false }),
  useScenes: () => ({ scenes: data.scenes, loading: false }),
  updateProjectSettings: vi.fn(async () => {}),
  updateScene: vi.fn(async () => {}),
}));
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { uid: 'u1' } }) }));
vi.mock('../hooks/useModels', async (original) => ({
  ...(await original()),
  useModels: () => ({ videoModels: [] }),
}));
vi.mock('../hooks/useStorageUrl', () => ({ useStorageUrl: () => '' }));
vi.mock('../hooks/useDoneNotifications', () => ({ useDoneNotifications: () => {} }));
vi.mock('../utils/notify', () => ({ askToNotify: vi.fn(), notifyDone: vi.fn() }));
vi.mock('../services/api', () => ({
  generateAllScenes: vi.fn(async () => ({})),
  cancelGenerateAll: vi.fn(async () => ({})),
  cancelSceneGeneration: vi.fn(),
  generateVideo: vi.fn(),
  selectAttempt: vi.fn(),
  resolveStorageUrl: vi.fn(async (path) => `https://files.test/${path}`),
}));
// The scene cards have their own behaviour; these tests are about the page around them.
vi.mock('../components/GenerateSceneCard', () => ({
  default: ({ sceneNumber }) => <article>Scene card {sceneNumber}</article>,
}));

const scene = (id, extra = {}) => ({ id, script: `Line ${id}.`, prompt: `Prompt ${id}.`, ...extra });
const done = (id, extra = {}) => scene(id, { storageRef: `scene${id}.mp4`, activeAttempt: 1, ...extra });

function open({ project = {}, scenes = [scene('0'), scene('1')] } = {}) {
  data.project = { id: 'p1', userId: 'u1', title: 'Mug ad', status: 'scripted', settings: {}, ...project };
  data.scenes = scenes;
  render(
    <MemoryRouter initialEntries={['/project/p1/generate']}>
      <Routes>
        <Route path="/project/:id/generate" element={<GeneratePage />} />
        <Route path="/project/:id/video" element={<p>video page</p>} />
        <Route path="/project/:id/scenes" element={<p>script page</p>} />
      </Routes>
    </MemoryRouter>,
  );
  const region = (name) => {
    const found = screen.queryByRole('region', { name });
    return found ? within(found) : null;
  };
  return { run: region('Generate all scenes'), bar: region('Stitch the final video') };
}

beforeEach(() => vi.clearAllMocks());

describe('Generate step: generating every scene at once', () => {
  it('stitches at the end and does not retake unless asked', async () => {
    const { run } = open();
    expect(run.getByText(/2 scenes still need a video/)).toBeTruthy();
    expect(run.getByLabelText('Stitch the final video when they are done').checked).toBe(true);
    expect(run.getByLabelText(/Make one more take when the automatic check finds a problem/).checked).toBe(false);

    await userEvent.click(run.getByRole('button', { name: 'Generate all 2' }));
    expect(generateAllScenes).toHaveBeenCalledWith('p1', { stitch: true, retake: false, remake: [] });
  });

  it('sends the retake choice when its box is ticked', async () => {
    const { run } = open();
    await userEvent.click(run.getByLabelText(/Make one more take when the automatic check finds a problem/));
    await userEvent.click(run.getByRole('button', { name: 'Generate all 2' }));
    expect(generateAllScenes).toHaveBeenCalledWith('p1', { stitch: true, retake: true, remake: [] });
  });

  it('does not stitch at the end when that box is cleared', async () => {
    const { run } = open();
    await userEvent.click(run.getByLabelText('Stitch the final video when they are done'));
    await userEvent.click(run.getByRole('button', { name: 'Generate all 2' }));
    expect(generateAllScenes).toHaveBeenCalledWith('p1', { stitch: false, retake: false, remake: [] });
  });

  it('names the scene when only one is missing', () => {
    const { run } = open({ scenes: [done('0'), scene('1')] });
    expect(run.getByText('Scene 2 still needs a video.')).toBeTruthy();
    expect(run.getByRole('button', { name: 'Generate it' })).toBeTruthy();
  });

  it('says so when the run could not be started', async () => {
    generateAllScenes.mockRejectedValueOnce(new Error('Failed to fetch'));
    const { run } = open();
    await userEvent.click(run.getByRole('button', { name: 'Generate all 2' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(run.getByRole('button', { name: 'Generate all 2' }).disabled).toBe(false);
  });

  it('offers no "generate" once every scene has a video', () => {
    const { run } = open({ scenes: [done('0'), done('1')] });
    expect(run.queryByRole('button', { name: /^Generate/ })).toBeNull();
  });
});

describe('Generate step: while a run is going', () => {
  const running = (extra = {}) => ({
    generateAll: { status: 'running', currentNumber: 2, stitch: true, updatedAt: Date.now(), ...extra },
  });
  const scenes = [done('0'), scene('1', { videoStatus: 'generating', updatedAt: Date.now() })];

  it('says which scene is being made and lets you stop', async () => {
    const { run } = open({ project: running(), scenes });
    expect(run.getByText('Generating all scenes: scene 2 now, 1 left, then stitching.')).toBeTruthy();
    expect(run.queryByRole('button', { name: /Generate/ })).toBeNull();

    await userEvent.click(run.getByRole('button', { name: 'Stop' }));
    expect(cancelGenerateAll).toHaveBeenCalledWith('p1');
  });

  it('says when a scene is being retaken', () => {
    const { run } = open({ project: running({ retaking: true, stitch: false }), scenes });
    expect(run.getByText('Generating all scenes: retaking scene 2 now, 1 left.')).toBeTruthy();
  });
});

describe('Generate step: the bottom bar', () => {
  it('says what is missing and does not let you continue', () => {
    const { bar } = open({ scenes: [done('0'), scene('1')] });
    expect(bar.getByText('1/2 ready')).toBeTruthy();
    expect(bar.getByText('Scene 2 needs a video before stitching.')).toBeTruthy();
    expect(bar.getByRole('button', { name: 'Finish the video' }).disabled).toBe(true);
  });

  it('continues to the Video step once every scene has a video', async () => {
    const { bar } = open({ scenes: [done('0'), done('1')] });
    expect(bar.getByText('Every scene has a video.')).toBeTruthy();
    await userEvent.click(bar.getByRole('button', { name: 'Finish the video' }));
    expect(await screen.findByText('video page')).toBeTruthy();
  });

  it('leaves skipped scenes out of the count', () => {
    const { bar } = open({ scenes: [done('0'), scene('1', { skipped: true })] });
    expect(bar.getByText('1/1 ready')).toBeTruthy();
    expect(bar.getByRole('button', { name: 'Finish the video' }).disabled).toBe(false);
  });

  it('goes back to the script', async () => {
    const { bar } = open();
    await userEvent.click(bar.getByRole('button', { name: '← Script' }));
    expect(await screen.findByText('script page')).toBeTruthy();
  });
});

describe('Generate step: nothing to show', () => {
  it('points to the Script step when there are no scenes', () => {
    const { bar } = open({ scenes: [] });
    expect(screen.getByRole('heading', { name: 'No scenes yet' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Go to Script' })).toBeTruthy();
    expect(bar).toBeNull();
  });

  it('shows one card per scene', () => {
    open();
    expect(screen.getByText('Scene card 1')).toBeTruthy();
    expect(screen.getByText('Scene card 2')).toBeTruthy();
  });
});

describe('Generate step: new takes of scenes that already have one', () => {
  // A take records the prompt it was made from; a different prompt now means the scene changed.
  const taken = (id, extra = {}) => done(id, { history: [{ attempt: 1, scenePrompt: `Prompt ${id}.`, sceneAudio: 'voice_only' }], ...extra });
  const edited = (id, extra = {}) => taken(id, { prompt: `A rewritten prompt ${id}.`, ...extra });

  beforeEach(() => {
    window.confirm = vi.fn(() => true);
  });

  it('offers new takes of the scenes that changed, and sends exactly those', async () => {
    const { run } = open({ scenes: [taken('0'), edited('1'), taken('2', { imageSource: 'creator' })] });
    expect(run.getByText(/1 scene changed since its take/)).toBeTruthy();
    await userEvent.click(run.getByRole('button', { name: 'Make 1 new take' }));
    expect(generateAllScenes).toHaveBeenCalledWith('p1', { stitch: true, retake: false, remake: ['1'] });
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('includes a scene that continues from one that changed, so the cut still matches', async () => {
    const { run } = open({ scenes: [edited('0'), taken('1', { imageSource: 'last_frame' }), taken('2', { imageSource: 'creator' })] });
    expect(run.getByText(/2 scenes changed since their take .* or continue from one that did/)).toBeTruthy();
    await userEvent.click(run.getByRole('button', { name: 'Make 2 new takes' }));
    expect(generateAllScenes.mock.calls[0][1].remake).toEqual(['0', '1']);
  });

  it('after the whole script was rewritten, one button remakes every scene', async () => {
    const { run } = open({ scenes: [edited('0'), edited('1'), edited('2')] });
    await userEvent.click(run.getByRole('button', { name: 'Make 3 new takes' }));
    expect(generateAllScenes.mock.calls[0][1].remake).toEqual(['0', '1', '2']);
    expect(run.queryByRole('button', { name: /New takes of all/ })).toBeNull();   // it would be the same thing
  });

  it('can remake all scenes when nothing changed, after asking', async () => {
    const { run } = open({ scenes: [taken('0'), taken('1'), taken('2', { skipped: true })] });
    expect(run.queryByText(/changed since/)).toBeNull();
    await userEvent.click(run.getByRole('button', { name: 'New takes of all 2 scenes' }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('That is 2 new takes. The takes you have now are kept.'));
    expect(generateAllScenes).toHaveBeenCalledWith('p1', { stitch: true, retake: false, remake: ['0', '1'] });
  });

  it('does nothing when the question is declined', async () => {
    window.confirm = vi.fn(() => false);
    const { run } = open({ scenes: [taken('0'), taken('1')] });
    await userEvent.click(run.getByRole('button', { name: 'New takes of all 2 scenes' }));
    expect(generateAllScenes).not.toHaveBeenCalled();
  });

  it('adds the changed scenes to a run that makes the missing ones, unless unticked', async () => {
    const { run } = open({ scenes: [edited('0'), scene('1', { imageSource: 'creator' })] });
    const also = run.getByLabelText(/Also make a new take of the 1 scene that changed since its take/);
    expect(also.checked).toBe(true);
    await userEvent.click(run.getByRole('button', { name: 'Generate all 2' }));
    expect(generateAllScenes.mock.calls[0][1].remake).toEqual(['0']);

    await userEvent.click(also);
    await userEvent.click(run.getByRole('button', { name: 'Generate it' }));
    expect(generateAllScenes.mock.calls[1][1].remake).toEqual([]);
  });

  it('is not offered while a scene is making a take', () => {
    const { run } = open({ scenes: [edited('0'), taken('1', { videoStatus: 'generating', updatedAt: Date.now() })] });
    expect(run).toBeNull();
  });

  it('shows why the last run of new takes stopped', () => {
    const { run } = open({
      project: { generateAll: { status: 'failed', remake: ['1'], error: 'The new take of scene 2 failed: busy. Its earlier take is still in use.' } },
      scenes: [taken('0'), edited('1')],
    });
    expect(run.getByRole('alert').textContent).toMatch(/The new take of scene 2 failed/);
  });
});
