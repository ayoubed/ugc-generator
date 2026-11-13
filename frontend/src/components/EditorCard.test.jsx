import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EditorCard from './EditorCard';
import { updateProjectSettings } from '../hooks/useProject';

vi.mock('../hooks/useProject', () => ({ updateProjectSettings: vi.fn(async () => {}) }));

// Without a measured width the timeline is drawn at 60 pixels per second.
const PPS = 60;
const scene = (id, extra = {}) => ({ id, activeAttempt: 1, script: `Line ${id}.`, videoUrl: `https://files.test/${id}.mp4`, ...extra });
const list = (...scenes) => scenes.map((s, i) => ({ scene: s, label: String(i + 1) }));
const MUSIC = { source: 'upload', storageRef: 'm.mp3', url: 'https://files.test/m.mp3', name: 'Calm piano', volume: 40 };

function show({ settings = {}, project = {}, scenes = list(scene('0'), scene('1')), ...props } = {}) {
  return render(<EditorCard project={{ id: 'p1', settings, ...project }} scenes={scenes} fallbackSeconds={5} {...props} />);
}
const saved = () => updateProjectSettings.mock.calls.at(-1);
const track = (name) => within(screen.getByRole('group', { name }));
const clip = (number) => screen.getByRole('button', { name: new RegExp(`^Scene ${number},`) });
const left = (element) => element.style.left;
const width = (element) => element.style.width;

beforeEach(() => vi.clearAllMocks());

describe('the timeline', () => {
  it('has a track each for the picture, the voices, the captions and the music', () => {
    show({ settings: { music: MUSIC } });
    expect(screen.getByRole('heading', { name: 'Editor' })).toBeTruthy();
    expect(track('Video track').getAllByRole('button').length).toBe(2);
    expect(track('Voice track').getAllByRole('button', { hidden: true }).length).toBe(2);
    expect(track('Captions track').getByText('Line 0.')).toBeTruthy();
    expect(track('Music track').getByRole('button', { name: 'Music: Calm piano, volume 40%' })).toBeTruthy();
  });

  it('lays the clips out one after another, as wide as they are long', () => {
    show();
    expect([left(clip(1).parentElement), width(clip(1).parentElement)]).toEqual(['0px', `${5 * PPS}px`]);
    expect([left(clip(2).parentElement), width(clip(2).parentElement)]).toEqual([`${5 * PPS}px`, `${5 * PPS}px`]);
    expect(screen.getByText('0:00.0 / 0:10.0')).toBeTruthy();
  });

  it('leaves scenes without a video out, and is not shown when none has one', () => {
    show({ scenes: list(scene('0'), scene('1', { videoUrl: '' })) });
    expect(track('Video track').getAllByRole('button').length).toBe(1);
    const { container } = render(<EditorCard project={{ id: 'p2', settings: {} }} scenes={list(scene('0', { videoUrl: '' }))} />);
    expect(container.innerHTML).toBe('');
  });

  it('has no captions track when captions are off, and says when a scene has no caption', () => {
    const { unmount } = show({ settings: { captions: { style: 'none' } } });
    expect(screen.queryByRole('group', { name: 'Captions track' })).toBeNull();
    unmount();
    show({ settings: { captions: { texts: { 1: '' } } } });
    expect(track('Captions track').getByText('No caption')).toBeTruthy();
  });

  it('says where to add music when there is none', () => {
    show();
    expect(track('Music track').getByText(/No music\. Add a track under/)).toBeTruthy();
  });

  it('shows the end card after the last scene, and counts it in the length', () => {
    show({ settings: { endCard: { enabled: true, imageRef: 'card.png', seconds: 3 } } });
    const card = track('Video track').getByText('End card');
    expect([left(card), width(card)]).toEqual([`${10 * PPS}px`, `${3 * PPS}px`]);
    expect(screen.getByText('0:00.0 / 0:13.0')).toBeTruthy();
  });

  it('uses a clip\'s real length once the file says it', () => {
    show();
    const thumb = clip(1).querySelector('video');
    Object.defineProperty(thumb, 'duration', { value: 4, configurable: true });
    fireEvent.loadedMetadata(thumb);
    expect(width(clip(1).parentElement)).toBe(`${4 * PPS}px`);
    expect(left(clip(2).parentElement)).toBe(`${4 * PPS}px`);
  });

  it('shows the automatic cut of the last stitch instead of the whole clip', () => {
    show({ project: { finalVideos: [{ version: 1, storageRef: 'v.mp4', cuts: { 0: { start: 0.5, end: 4.5, attempt: 1 } } }], finalVideoVersion: 1 } });
    expect(width(clip(1).parentElement)).toBe(`${4 * PPS}px`);
    fireEvent.click(clip(1));
    expect(screen.getByText(/Automatic cut: the pauses before and after the words are removed/)).toBeTruthy();
    expect(screen.getByLabelText('Start').value).toBe('0.5');
  });

  it('zooms in and out, and back to fit', async () => {
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(width(clip(1).parentElement)).toBe(`${5 * 84}px`);
    await userEvent.click(screen.getByRole('button', { name: 'Fit' }));
    expect(width(clip(1).parentElement)).toBe(`${5 * PPS}px`);
  });
});

describe('trimming a clip', () => {
  it('opens a panel for the selected clip', async () => {
    show();
    expect(screen.getByText(/Select a clip to trim it/)).toBeTruthy();
    await userEvent.click(clip(2));
    expect(screen.getByRole('heading', { name: 'Scene 2' })).toBeTruthy();
    expect(clip(2).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('Start').value).toBe('0');
    expect(screen.getByLabelText('End').value).toBe('5');
  });

  it('cuts the start by dragging the left edge, and the later clips move up', async () => {
    show();
    const handle = screen.getByTestId('handle-start-0');
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 100 + 1.5 * PPS, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(width(clip(1).parentElement)).toBe(`${3.5 * PPS}px`);
    expect(left(clip(2).parentElement)).toBe(`${3.5 * PPS}px`);
    expect(screen.getByRole('heading', { name: 'Scene 1' })).toBeTruthy();
    await waitFor(() => expect(saved()).toEqual(['p1', { 'edits.0': { start: 1.5, attempt: 1 } }]), { timeout: 2000 });
  });

  it('cuts the end by dragging the right edge', async () => {
    show();
    const handle = screen.getByTestId('handle-end-1');
    fireEvent.pointerDown(handle, { clientX: 600, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 600 - 2 * PPS, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    await waitFor(() => expect(saved()).toEqual(['p1', { 'edits.1': { end: 3, attempt: 1 } }]), { timeout: 2000 });
    fireEvent.pointerMove(handle, { clientX: 0, pointerId: 1 });        // not held any more: nothing happens
    expect(width(clip(2).parentElement)).toBe(`${3 * PPS}px`);
  });

  it('does the same from the keyboard with the Start and End fields', async () => {
    show();
    await userEvent.click(clip(1));
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '3.2' } });
    expect(width(clip(1).parentElement)).toBe(`${3.2 * PPS}px`);
    expect(screen.getByText('0.0s to 3.2s')).toBeTruthy();
    await waitFor(() => expect(saved()).toEqual(['p1', { 'edits.0': { end: 3.2, attempt: 1 } }]), { timeout: 2000 });
  });

  it('keeps the zoom still while an edge is dragged', () => {
    show();
    const handle = screen.getByTestId('handle-end-1');
    fireEvent.pointerDown(handle, { clientX: 600, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 600 - 2 * PPS, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 600 - 1 * PPS, pointerId: 1 });
    expect(width(clip(2).parentElement)).toBe(`${4 * PPS}px`);       // still one second per 60 pixels
    expect(width(clip(1).parentElement)).toBe(`${5 * PPS}px`);
  });

  it('never lets a clip shrink to nothing', () => {
    show();
    const handle = screen.getByTestId('handle-start-0');
    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 50 * PPS, pointerId: 1 });
    expect(parseFloat(width(clip(1).parentElement))).toBeCloseTo(0.3 * PPS);
  });

  it('shows a saved edit and resets it', async () => {
    show({ settings: { edits: { 0: { attempt: 1, start: 1, end: 4 } } } });
    expect(width(clip(1).parentElement)).toBe(`${3 * PPS}px`);
    await userEvent.click(clip(1));
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(saved()).toEqual(['p1', { 'edits.0': null }]);
    expect(width(clip(1).parentElement)).toBe(`${5 * PPS}px`);
  });

  it('ignores an edit made on a take that is no longer in use', () => {
    show({ settings: { edits: { 0: { attempt: 7, start: 2 } } } });
    expect(width(clip(1).parentElement)).toBe(`${5 * PPS}px`);
  });
});

describe('sound', () => {
  it('mutes a scene from its panel, and the voice track shows it', async () => {
    show();
    await userEvent.click(clip(2));
    await userEvent.click(screen.getByLabelText("Mute this scene's own sound"));
    expect(track('Voice track').getByText('Muted')).toBeTruthy();
    expect(screen.getByLabelText('Voice volume').disabled).toBe(true);
    await waitFor(() => expect(saved()).toEqual(['p1', { 'edits.1': { muted: true, attempt: 1 } }]), { timeout: 2000 });
  });

  it('changes how loud a scene\'s voice is', async () => {
    show();
    await userEvent.click(clip(1));
    fireEvent.change(screen.getByLabelText('Voice volume'), { target: { value: '150' } });
    expect(track('Voice track').getByText('150%')).toBeTruthy();
    await waitFor(() => expect(saved()).toEqual(['p1', { 'edits.0': { volume: 1.5, attempt: 1 } }]), { timeout: 2000 });
  });

  it('changes the music volume from the music bar', async () => {
    show({ settings: { music: MUSIC } });
    await userEvent.click(track('Music track').getByRole('button'));
    expect(screen.getByRole('heading', { name: 'Music' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Music volume'), { target: { value: '65' } });
    expect(track('Music track').getByRole('button', { name: 'Music: Calm piano, volume 65%' })).toBeTruthy();
    await waitFor(() => expect(saved()).toEqual(['p1', { 'music.volume': 65 }]), { timeout: 2000 });
  });
});

describe('playing the cut', () => {
  const preview = () => screen.getByLabelText(/^Preview: scene/);
  const at = (element, seconds) => Object.defineProperty(element, 'currentTime', { value: seconds, configurable: true, writable: true });

  it('starts on the first scene and moves the playhead as it plays', async () => {
    show();
    expect(preview().getAttribute('src')).toBe('https://files.test/0.mp4');
    await userEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    at(preview(), 2);
    fireEvent.timeUpdate(preview());
    expect(screen.getByText('0:02.0 / 0:10.0')).toBeTruthy();
    expect(document.querySelector('.tl-playhead').style.left).toBe(`${2 * PPS}px`);
  });

  it('goes on to the next scene at the out-point, and stops after the last', async () => {
    show({ settings: { edits: { 0: { attempt: 1, end: 3 } } } });
    await userEvent.click(screen.getByRole('button', { name: 'Play' }));
    at(preview(), 3);
    fireEvent.timeUpdate(preview());
    expect(preview().getAttribute('aria-label')).toBe('Preview: scene 2');
    fireEvent.ended(preview());
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
    expect(screen.getByText('0:08.0 / 0:08.0')).toBeTruthy();
  });

  it('moves the playhead to where the ruler is clicked', () => {
    show();
    const ruler = screen.getByTestId('editor-ruler');
    ruler.getBoundingClientRect = () => ({ left: 20, top: 0, width: 600, height: 26 });
    fireEvent.click(ruler, { clientX: 20 + 7 * PPS });
    expect(screen.getByText('0:07.0 / 0:10.0')).toBeTruthy();
    expect(preview().getAttribute('aria-label')).toBe('Preview: scene 2');
  });

  it('jumps to a clip when it is selected', async () => {
    show();
    await userEvent.click(clip(2));
    expect(screen.getByText('0:05.0 / 0:10.0')).toBeTruthy();
  });

  it('plays the music along with the cut', () => {
    show({ settings: { music: MUSIC } });
    expect(document.querySelector('audio').getAttribute('src')).toBe('https://files.test/m.mp3');
  });
});

describe('the editor while a stitch runs, and when saving fails', () => {
  it('cannot be changed while a stitch is running', async () => {
    show({ disabled: true });
    expect(screen.getByRole('button', { name: 'Play' }).disabled).toBe(true);
    await userEvent.click(clip(1));
    expect(screen.getByLabelText('Start').disabled).toBe(true);
    const handle = screen.getByTestId('handle-start-0');
    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 120, pointerId: 1 });
    expect(width(clip(1).parentElement)).toBe(`${5 * PPS}px`);
  });

  it('says when an edit could not be saved', async () => {
    updateProjectSettings.mockRejectedValueOnce(new Error('offline'));
    show();
    await userEvent.click(clip(1));
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '3' } });
    expect(await screen.findByRole('alert', {}, { timeout: 2000 })).toBeTruthy();
  });
});
