import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EditorCard from './EditorCard';
import { updateProjectSettings } from '../hooks/useProject';

vi.mock('../hooks/useProject', () => ({ updateProjectSettings: vi.fn(async () => {}) }));

const scene = (id, extra = {}) => ({ id, activeAttempt: 1, videoUrl: `https://files.test/${id}.mp4`, ...extra });
const list = (...scenes) => scenes.map((s, i) => ({ scene: s, label: String(i + 1) }));

function show({ project = { id: 'p1', settings: {} }, scenes = list(scene('0'), scene('1')), ...props } = {}) {
  return render(<EditorCard project={project} scenes={scenes} fallbackSeconds={5} {...props} />);
}
const saved = () => updateProjectSettings.mock.calls.at(-1);

beforeEach(() => vi.clearAllMocks());

describe('the editor', () => {
  it('lists the scenes that have a video, untouched to begin with', () => {
    show({ scenes: list(scene('0'), scene('1', { videoUrl: '' })) });
    expect(screen.getByRole('heading', { name: 'Edit the cut' })).toBeTruthy();
    expect(screen.getByText('Scene 1')).toBeTruthy();
    expect(screen.queryByText('Scene 2')).toBeNull();
    expect(screen.getByText('All 5.0s, automatic cut')).toBeTruthy();
    expect(screen.getByText(/About 5\.0 seconds in total/)).toBeTruthy();
  });

  it('is not shown before any scene has a video', () => {
    const { container } = show({ scenes: list(scene('0', { videoUrl: '' })) });
    expect(container.innerHTML).toBe('');
  });

  it('saves a new start for the take in use, and shows the shorter total', async () => {
    show();
    fireEvent.change(screen.getByLabelText('Scene 1 starts at'), { target: { value: '1.5' } });
    expect(screen.getByText('1.5s to 5.0s')).toBeTruthy();
    expect(screen.getByText(/About 8\.5 seconds in total/)).toBeTruthy();
    await waitFor(() => expect(updateProjectSettings).toHaveBeenCalled(), { timeout: 2000 });
    expect(saved()).toEqual(['p1', { 'edits.0': { start: 1.5, attempt: 1 } }]);
  });

  it('uses the clip\'s real length once it is known', () => {
    show();
    const thumb = document.querySelectorAll('video.editor-thumb')[0];
    Object.defineProperty(thumb, 'duration', { value: 4.2, configurable: true });
    fireEvent.loadedMetadata(thumb);
    expect(screen.getByText('All 4.2s, automatic cut')).toBeTruthy();
    expect(screen.getByLabelText('Scene 1 ends at').max).toBe('4.2');
  });

  it('mutes a scene and takes its volume slider away', async () => {
    show();
    await userEvent.click(screen.getAllByLabelText(/Mute this scene's own sound/)[1]);
    expect(screen.getByLabelText('Scene 2 voice volume').disabled).toBe(true);
    expect(screen.getByText('Muted')).toBeTruthy();
    await waitFor(() => expect(updateProjectSettings).toHaveBeenCalled(), { timeout: 2000 });
    expect(saved()).toEqual(['p1', { 'edits.1': { muted: true, attempt: 1 } }]);
  });

  it('changes how loud a scene\'s voice is', async () => {
    show();
    fireEvent.change(screen.getByLabelText('Scene 1 voice volume'), { target: { value: '150' } });
    expect(screen.getByText('voice 150%')).toBeTruthy();
    await waitFor(() => expect(saved()).toEqual(['p1', { 'edits.0': { volume: 1.5, attempt: 1 } }]), { timeout: 2000 });
  });

  it('shows a saved edit and can reset it', async () => {
    show({ project: { id: 'p1', settings: { edits: { 0: { attempt: 1, start: 1, end: 4 } } } } });
    expect(screen.getByText('1.0s to 4.0s')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(saved()).toEqual(['p1', { 'edits.0': null }]);
    expect(screen.getAllByText('All 5.0s, automatic cut').length).toBe(2);
  });

  it('ignores an edit made on a take that is no longer in use', () => {
    show({ project: { id: 'p1', settings: { edits: { 0: { attempt: 7, start: 1 } } } } });
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
  });

  it('plays the cut scene by scene and can be stopped', async () => {
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Play the cut' }));
    expect(screen.getByLabelText('Preview of scene 1').getAttribute('src')).toBe('https://files.test/0.mp4');
    fireEvent.ended(screen.getByLabelText('Preview of scene 1'));
    expect(screen.getByLabelText('Preview of scene 2')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.queryByLabelText(/Preview of scene/)).toBeNull();
  });

  it('ends the preview after the last scene', async () => {
    show({ scenes: list(scene('0')) });
    await userEvent.click(screen.getByRole('button', { name: 'Play the cut' }));
    fireEvent.ended(screen.getByLabelText('Preview of scene 1'));
    expect(screen.getByRole('button', { name: 'Play the cut' })).toBeTruthy();
  });

  it('cannot be changed while a stitch is running', () => {
    show({ disabled: true });
    expect(screen.getByLabelText('Scene 1 starts at').disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Play the cut' }).disabled).toBe(true);
  });

  it('says when an edit could not be saved', async () => {
    updateProjectSettings.mockRejectedValueOnce(new Error('offline'));
    show();
    fireEvent.change(screen.getByLabelText('Scene 1 ends at'), { target: { value: '3' } });
    expect(await screen.findByRole('alert', {}, { timeout: 2000 })).toBeTruthy();
  });
});
