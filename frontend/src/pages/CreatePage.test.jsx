import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import CreatePage from './CreatePage';
import { saveProjectWithSettings } from '../hooks/useProject';
import { extractAssets, generateScenes } from '../services/api';

// The page reads the project and its scenes through these hooks; each test sets what they return.
const data = { project: null, scenes: [] };
vi.mock('../hooks/useProject', () => ({
  useProject: () => ({ project: data.project, loading: false }),
  useScenes: () => ({ scenes: data.scenes, loading: false }),
  updateProject: vi.fn(async () => {}),
  updateProjectSettings: vi.fn(async () => {}),
  saveProjectWithSettings: vi.fn(async () => {}),
}));
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { uid: 'u1' } }) }));
vi.mock('../hooks/useModels', async (original) => ({
  ...(await original()),
  useModels: () => ({
    videoModels: [],
    scriptModels: [{ id: 'script-model', label: 'Script model' }],
    defaultScriptModel: 'script-model',
    error: '',
  }),
}));
vi.mock('../services/api', () => ({
  extractAssets: vi.fn(async () => ({ hero_props: 'A blue mug.', character: 'A woman in her 30s.', setting: 'A kitchen.', voice: 'Warm.' })),
  generateScenes: vi.fn(async () => ({})),
  analyseReference: vi.fn(),
  resolveStorageUrl: vi.fn(async (path) => `https://files.test/${path}`),
}));

const DETAILS = { hero_props: 'A blue mug.', character: 'A woman in her 30s.', setting: 'A kitchen.', voice: 'Warm.' };
const BREAKDOWN = {
  scenes: [
    { start: 0, end: 4, purpose: 'Hook', happens: 'Holds up the product.', framing: 'Close selfie', said: 'Their exact words.' },
    { start: 4, end: 8, purpose: 'Proof', happens: 'Shows it in use.', framing: 'Over the shoulder', said: 'More of their words.' },
  ],
  pacing: 'Fast cuts.',
  call_to_action: 'Points at the link.',
};

function open({ project = {}, scenes = [] } = {}) {
  data.project = {
    id: 'p1',
    userId: 'u1',
    title: 'Mug ad',
    status: 'draft',
    idea: 'A mug that keeps coffee hot all day.',
    startingImageRef: 'users/u1/projects/p1/starting_image.jpg',
    settings: {},
    ...project,
  };
  data.scenes = scenes;
  render(
    <MemoryRouter initialEntries={['/project/p1/create']}>
      <Routes>
        <Route path="/project/:id/create" element={<CreatePage />} />
        <Route path="/project/:id/scenes" element={<p>script page</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return within(screen.getByRole('region', { name: 'Write the script' }));
}

/** The saved project is copied into the form a moment after the page opens. */
const formLoaded = () => waitFor(() => expect(screen.getByRole('textbox', { name: 'Your idea' }).value).not.toBe(''));

beforeEach(() => vi.clearAllMocks());

describe('Idea step: writing the script', () => {
  it('writes the consistent details first when they are empty, then the script', async () => {
    const bar = open();
    await formLoaded();
    expect(screen.getByText('Written for you with the script')).toBeTruthy();

    await userEvent.click(bar.getByRole('button', { name: 'Write the script →' }));
    expect(await screen.findByText('script page')).toBeTruthy();

    expect(extractAssets).toHaveBeenCalledWith('A mug that keeps coffee hot all day.', 'script-model');
    const [, saved, savedSettings] = saveProjectWithSettings.mock.calls.at(-1);
    expect(saved.idea).toBe('A mug that keeps coffee hot all day.');
    expect(savedSettings.assetBible).toEqual(DETAILS);
    expect(generateScenes).toHaveBeenCalledWith('p1', expect.objectContaining({
      idea: 'A mug that keeps coffee hot all day.',
      num_scenes: 3,
      llm_model: 'script-model',
      asset_bible: DETAILS,
      structure: null,
    }));
  });

  it('keeps the details you wrote yourself', async () => {
    const mine = { ...DETAILS, hero_props: 'A red mug with a white lid.' };
    const bar = open({ project: { settings: { assetBible: mine } } });
    await formLoaded();
    expect(screen.getByText('4 of 4 filled in')).toBeTruthy();

    await userEvent.click(bar.getByRole('button', { name: 'Write the script →' }));
    expect(await screen.findByText('script page')).toBeTruthy();
    expect(extractAssets).not.toHaveBeenCalled();
    expect(generateScenes.mock.calls[0][1].asset_bible).toEqual(mine);
  });

  it('still writes the script when the details could not be written', async () => {
    extractAssets.mockRejectedValueOnce(new Error('busy'));
    const bar = open();
    await formLoaded();
    await userEvent.click(bar.getByRole('button', { name: 'Write the script →' }));
    expect(await screen.findByText('script page')).toBeTruthy();
    expect(generateScenes).toHaveBeenCalledTimes(1);
  });

  it('sends the number of scenes and the hook you chose', async () => {
    const bar = open({ project: { settings: { numScenes: 5, hookStyle: 'Custom Hook', customHookDesc: 'Whisper a secret.', wordsPerScene: 12 } } });
    await formLoaded();
    expect(bar.getByText('5 scenes · about 40s')).toBeTruthy();
    await userEvent.click(bar.getByRole('button', { name: 'Write the script →' }));
    await screen.findByText('script page');
    expect(generateScenes.mock.calls[0][1]).toMatchObject({
      num_scenes: 5,
      hook_style: 'Custom Hook',
      custom_hook_desc: 'Whisper a secret.',
      target_words_per_scene: 12,
    });
  });

  it('asks for a photo of the person before writing', async () => {
    const bar = open({ project: { startingImageRef: '' } });
    await formLoaded();
    await userEvent.click(bar.getByRole('button', { name: 'Write the script →' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Add a photo of the person who speaks.');
    expect(generateScenes).not.toHaveBeenCalled();
  });

  it('writes nothing without an idea', async () => {
    const bar = open({ project: { idea: '' } });
    await userEvent.click(bar.getByRole('button', { name: 'Write the script →' }));
    expect(generateScenes).not.toHaveBeenCalled();
    expect(screen.queryByText('script page')).toBeNull();
  });

  it('shows the reason and stays on the page when writing fails', async () => {
    generateScenes.mockRejectedValueOnce(new Error('The model is busy. Try again.'));
    const bar = open();
    await formLoaded();
    await userEvent.click(bar.getByRole('button', { name: 'Write the script →' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The model is busy. Try again.');
    expect(screen.queryByText('script page')).toBeNull();
    expect(bar.getByRole('button', { name: 'Write the script →' }).disabled).toBe(false);
  });
});

describe('Idea step: a project that already has a script', () => {
  const scripted = { status: 'scripted', settings: { assetBible: DETAILS } };
  const scenes = [{ id: '0', script: 'Line 0.' }, { id: '1', script: 'Line 1.', storageRef: 'scene1.mp4' }];

  it('asks before replacing the script, and keeps it when you say so', async () => {
    const bar = open({ project: scripted, scenes });
    await formLoaded();
    await userEvent.click(bar.getByRole('button', { name: 'Write a new script' }));

    const dialog = within(screen.getByRole('alertdialog', { name: 'Replace the current script?' }));
    expect(dialog.getByText(/The text of all 2 scenes is rewritten/)).toBeTruthy();
    expect(dialog.getByText(/Videos of the scenes that stay are kept/)).toBeTruthy();
    expect(generateScenes).not.toHaveBeenCalled();

    await userEvent.click(dialog.getByRole('button', { name: 'Keep the current script' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(generateScenes).not.toHaveBeenCalled();
  });

  it('replaces the script after you confirm', async () => {
    const bar = open({ project: scripted, scenes });
    await formLoaded();
    await userEvent.click(bar.getByRole('button', { name: 'Write a new script' }));
    await userEvent.click(screen.getByRole('button', { name: 'Replace the script' }));
    expect(await screen.findByText('script page')).toBeTruthy();
    expect(generateScenes).toHaveBeenCalledTimes(1);
  });

  it('warns that scenes are deleted when the new script is shorter', async () => {
    const bar = open({ project: { ...scripted, settings: { ...scripted.settings, numScenes: 1 } }, scenes });
    await formLoaded();
    await userEvent.click(bar.getByRole('button', { name: 'Write a new script' }));
    expect(screen.getByText(/Scenes 2 and up are deleted with their videos/)).toBeTruthy();
  });

  it('does not rewrite while a scene is making a take', async () => {
    const bar = open({ project: scripted, scenes: [{ id: '0', script: 'Line 0.', videoStatus: 'generating' }] });
    await formLoaded();
    await userEvent.click(bar.getByRole('button', { name: 'Write a new script' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/A scene is making a take right now/);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('lets you continue with the script you have', async () => {
    const bar = open({ project: scripted, scenes });
    await formLoaded();
    await userEvent.click(bar.getByRole('button', { name: 'Keep the script →' }));
    expect(await screen.findByText('script page')).toBeTruthy();
    expect(generateScenes).not.toHaveBeenCalled();
  });
});

describe('Idea step: following a reference video', () => {
  const reference = { storageRef: 'ref.mp4', url: 'https://files.test/ref.mp4', name: 'ref.mp4', breakdown: BREAKDOWN, use: true };

  it('fixes the number of scenes and sends the structure without the words that were said', async () => {
    const bar = open({ project: { referenceStatus: 'ready', settings: { numScenes: 2, assetBible: DETAILS, reference } } });
    await formLoaded();
    expect(screen.getByLabelText('Scenes').disabled).toBe(true);
    expect(screen.getByText(/One scene per part of the reference video\./)).toBeTruthy();

    await userEvent.click(bar.getByRole('button', { name: 'Write the script →' }));
    await screen.findByText('script page');
    const { structure } = generateScenes.mock.calls[0][1];
    expect(structure).toEqual({
      scenes: [
        { purpose: 'Hook', happens: 'Holds up the product.', framing: 'Close selfie' },
        { purpose: 'Proof', happens: 'Shows it in use.', framing: 'Over the shoulder' },
      ],
      pacing: 'Fast cuts.',
      call_to_action: 'Points at the link.',
    });
    expect(JSON.stringify(structure)).not.toMatch(/their/i);
  });

  it('sends no structure when the reference is not followed', async () => {
    const bar = open({ project: { referenceStatus: 'ready', settings: { assetBible: DETAILS, reference: { ...reference, use: false } } } });
    await formLoaded();
    expect(screen.getByLabelText('Scenes').disabled).toBe(false);
    await userEvent.click(bar.getByRole('button', { name: 'Write the script →' }));
    await screen.findByText('script page');
    expect(generateScenes.mock.calls[0][1].structure).toBeNull();
  });
});

describe('Idea step: saving as you type', () => {
  it('saves a changed idea without being asked', async () => {
    open();
    await formLoaded();
    const idea = screen.getByRole('textbox', { name: 'Your idea' });
    await userEvent.type(idea, ' Filmed in a kitchen.');
    await waitFor(() => expect(saveProjectWithSettings).toHaveBeenCalled(), { timeout: 3000 });
    const [pid, saved] = saveProjectWithSettings.mock.calls.at(-1);
    expect(pid).toBe('p1');
    expect(saved.idea).toBe('A mug that keeps coffee hot all day. Filmed in a kitchen.');
    expect(saved.title).toBe('A mug that keeps coffee hot all day. Filmed in ...');
  });
});

describe('Idea step: layout', () => {
  const sectionOpen = (title) => screen.getByText(title).closest('details').open;

  it('keeps the options together, folded, on a phone', async () => {
    open();
    await formLoaded();
    const options = within(screen.getByRole('complementary', { name: 'Options' }));
    ['Consistent details', 'Script options', 'Style details', 'Models and quality'].forEach((title) => {
      expect(options.getByText(title)).toBeTruthy();
      expect(sectionOpen(title)).toBe(false);
    });
    // The idea, the pictures and the reference video are not in the options column.
    expect(options.queryByRole('textbox', { name: 'Your idea' })).toBeNull();
  });

  it('shows the script options unfolded in the sidebar on a desktop screen', async () => {
    window.matchMedia = (query) => ({ matches: query === '(min-width: 1100px)', addEventListener() {}, removeEventListener() {} });
    try {
      open();
      await formLoaded();
      expect(sectionOpen('Script options')).toBe(true);
      expect(sectionOpen('Style details')).toBe(false);
    } finally {
      delete window.matchMedia;
    }
  });
});
