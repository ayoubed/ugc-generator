import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import StoryboardPage from './StoryboardPage';
import { addStoryboardFrame, editStoryboardFrame, remakeStoryboardFrame, removeStoryboardFrame } from '../services/api';
import { updateProjectSettings } from '../hooks/useProject';

const data = { project: null, scenes: [] };
vi.mock('../hooks/useProject', () => ({
  useProject: () => ({ project: data.project, loading: false }),
  useScenes: () => ({ scenes: data.scenes, loading: false }),
  updateProjectSettings: vi.fn(async () => {}),
}));
vi.mock('../hooks/useModels', () => ({
  useModels: () => ({
    imageModels: [
      { id: 'pro', label: 'Nano Banana Pro', description: 'Best at fine detail.' },
      { id: 'fast', label: 'Nano Banana 2', description: 'Faster and cheaper.' },
    ],
    defaultImageModel: 'pro',
  }),
}));
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { uid: 'u1' } }) }));
vi.mock('../hooks/useStorageUrl', () => ({ useStorageUrl: (path) => (path ? `https://files.test/${path}` : '') }));
vi.mock('../services/firebase', () => ({ storage: {} }));
vi.mock('firebase/storage', () => ({ ref: vi.fn(), uploadBytes: vi.fn(async () => {}) }));
vi.mock('../components/Layout', () => ({ default: ({ children }) => <div>{children}</div> }));
vi.mock('../services/api', () => ({
  addStoryboardFrame: vi.fn(async () => ({})),
  editStoryboardFrame: vi.fn(async () => ({})),
  remakeStoryboardFrame: vi.fn(async () => ({})),
  removeStoryboardFrame: vi.fn(async () => ({})),
  resolveStorageUrl: vi.fn(async (path) => `https://files.test/${path}`),
}));

const scene = (id, extra = {}) => ({ id, script: `Line ${id}.`, description: `What scene ${id} shows.`, ...extra });
const frame = (extra = {}) => ({ id: 'f1', order: 0, description: 'A wrist with the watch.', imageRef: 'f1.png', accepted: false, look: false, issues: [], ...extra });
const withFrame = (id, frameExtra = {}, sceneExtra = {}) =>
  scene(id, { storyboard: { frames: { f1: frame(frameExtra) } }, ...sceneExtra });

function open(scenes = [scene('0'), scene('1')], settings = {}) {
  data.project = { id: 'p1', userId: 'u1', status: 'scripted', settings };
  data.scenes = scenes;
  render(
    <MemoryRouter initialEntries={['/project/p1/storyboard']}>
      <Routes>
        <Route path="/project/:id/storyboard" element={<StoryboardPage />} />
        <Route path="/project/:id/generate" element={<p>generate page</p>} />
        <Route path="/project/:id/scenes" element={<p>script page</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return (number) => within(screen.getByRole('article', { name: `Scene ${number}` }));
}

beforeEach(() => vi.clearAllMocks());

describe('Storyboard step', () => {
  it('is optional: with no frames it offers to skip to Generate', async () => {
    open();
    expect(screen.getByText(/No frames yet/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Skip to Generate/ }));
    expect(screen.getByText('generate page')).toBeTruthy();
  });

  it('uses the default image model until another is chosen, and saves the choice', async () => {
    open();
    const picker = screen.getByLabelText('Image model');
    expect(picker.value).toBe('pro');
    expect(screen.getByText('Best at fine detail.')).toBeTruthy();
    await userEvent.selectOptions(picker, 'Nano Banana 2');
    expect(updateProjectSettings).toHaveBeenCalledWith('p1', { imageModel: 'fast' });
  });

  it('shows the saved image model, and the default when the saved one is no longer offered', () => {
    open(undefined, { imageModel: 'fast' });
    expect(screen.getByLabelText('Image model').value).toBe('fast');
    expect(screen.getByText('Faster and cheaper.')).toBeTruthy();
  });

  it('falls back to the default for a model that is gone', () => {
    open(undefined, { imageModel: 'retired' });
    expect(screen.getByLabelText('Image model').value).toBe('pro');
  });

  it('draws a scene frame from the description, which can be edited first', async () => {
    const card = open();
    const box = card(1).getByLabelText('What the frame shows');
    expect(box.value).toBe('What scene 0 shows.');
    await userEvent.clear(box);
    await userEvent.type(box, 'The watch on a left wrist.');
    await userEvent.click(card(1).getByRole('button', { name: 'Draw this frame' }));
    expect(addStoryboardFrame).toHaveBeenCalledWith('p1', '0', { description: 'The watch on a left wrist.' });
  });

  it('draws every missing frame, and says to match once a look is set', async () => {
    open([withFrame('0', { accepted: true, look: true }, { customStartImageRef: 'f1.png' }), scene('1'), scene('2', { skipped: true })]);
    await userEvent.click(screen.getByRole('button', { name: 'Draw the 1 missing frame to match' }));
    await waitFor(() => expect(addStoryboardFrame).toHaveBeenCalledTimes(1));
    expect(addStoryboardFrame).toHaveBeenCalledWith('p1', '1');
    expect(screen.queryByText(/Start with one scene/)).toBeNull();
  });

  it('reports frames that could not be drawn', async () => {
    addStoryboardFrame.mockRejectedValueOnce(new Error('The model is busy.'));
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Draw the 2 missing frames' }));
    expect((await screen.findByRole('alert')).textContent).toContain('One frame could not be drawn. The model is busy.');
  });

  it('shows a drawn frame with what the check noticed, and accepts it', async () => {
    const card = open([withFrame('0', { issues: [{ kind: 'scale', detail: 'The watch is wider than the wrist.' }] })]);
    expect(card(1).getByRole('img').getAttribute('src')).toBe('https://files.test/f1.png');
    expect(card(1).getByText('The watch is wider than the wrist.')).toBeTruthy();
    await userEvent.click(card(1).getByRole('button', { name: 'Use this picture' }));
    expect(editStoryboardFrame).toHaveBeenCalledWith('p1', '0', 'f1', { accepted: true });
  });

  it('marks the accepted frame as the start and lets it be taken back or set as the look', async () => {
    const card = open([withFrame('0', { accepted: true, look: true }, { customStartImageRef: 'f1.png' })]);
    expect(card(1).getByText('The video starts on this picture')).toBeTruthy();
    expect(card(1).getByText('Sets the look of the video')).toBeTruthy();
    await userEvent.click(card(1).getByRole('checkbox', { name: /match this one/ }));
    expect(editStoryboardFrame).toHaveBeenCalledWith('p1', '0', 'f1', { look: false });
    await userEvent.click(card(1).getByRole('button', { name: 'Stop using it' }));
    expect(editStoryboardFrame).toHaveBeenCalledWith('p1', '0', 'f1', { accepted: false });
    expect(screen.getByRole('button', { name: /Generate videos/ })).toBeTruthy();
  });

  it('says when another starting picture was chosen since', () => {
    const card = open([withFrame('0', { accepted: true }, { customStartImageRef: 'other.png' })]);
    expect(card(1).queryByText('The video starts on this picture')).toBeNull();
    expect(card(1).getByText(/another starting picture/)).toBeTruthy();
  });

  it('changes a frame with a short instruction, draws it again, or removes it', async () => {
    const card = open([withFrame('0')]);
    await userEvent.click(card(1).getByRole('button', { name: 'Change it' }));
    await userEvent.type(card(1).getByLabelText('What should change in this picture?'), 'make the watch smaller');
    await userEvent.click(card(1).getByRole('button', { name: 'Change' }));
    expect(remakeStoryboardFrame).toHaveBeenCalledWith('p1', '0', 'f1', { instruction: 'make the watch smaller' });

    await userEvent.click(card(1).getByRole('button', { name: 'Draw again' }));
    expect(remakeStoryboardFrame).toHaveBeenLastCalledWith('p1', '0', 'f1', { description: 'A wrist with the watch.' });

    await userEvent.click(card(1).getByRole('button', { name: 'Remove' }));
    expect(removeStoryboardFrame).toHaveBeenCalledWith('p1', '0', 'f1');
  });

  it('shows what went wrong on the scene it happened on', async () => {
    editStoryboardFrame.mockRejectedValueOnce(new Error('This frame no longer exists.'));
    const card = open([withFrame('0')]);
    await userEvent.click(card(1).getByRole('button', { name: 'Use this picture' }));
    expect((await card(1).findByRole('alert')).textContent).toContain('This frame no longer exists.');
  });

  it('uploads a picture as the frame, replacing the one there', async () => {
    const card = open([withFrame('0')]);
    const file = new File(['x'], 'wrist.png', { type: 'image/png' });
    await userEvent.upload(card(1).getByLabelText('Upload a picture for scene 1'), file);
    await waitFor(() => expect(addStoryboardFrame).toHaveBeenCalled());
    expect(removeStoryboardFrame).toHaveBeenCalledWith('p1', '0', 'f1');
    const [, sceneId, body] = addStoryboardFrame.mock.calls[0];
    expect(sceneId).toBe('0');
    expect(body.storageRef).toMatch(/^users\/u1\/projects\/p1\/scenes\/0\/storyboard\/upload_\d+\.png$/);
  });
});
