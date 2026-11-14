import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EditorCard from './EditorCard';
import { updateProjectSettings } from '../hooks/useProject';
import { exportPackage, makeNarration, makeSound, previewVoice, removeNarration } from '../services/api';

// Sound effects are offered when the voice service is set up; a test switches it off to check that.
const voiceService = { available: true };
vi.mock('../hooks/useProject', () => ({ updateProjectSettings: vi.fn(async () => {}) }));
vi.mock('../hooks/useVoices', () => ({ useVoices: () => ({ available: voiceService.available, voices: [], loading: false, error: '' }) }));
vi.mock('../services/api', () => ({
  exportPackage: vi.fn(async () => ({})),
  previewVoice: vi.fn(async () => ({})),
  makeSound: vi.fn(async () => ({})),
  makeNarration: vi.fn(async () => ({})),
  removeNarration: vi.fn(async () => ({})),
}));
vi.mock('firebase/firestore', () => ({ deleteField: () => 'DELETE' }));

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

beforeEach(() => {
  vi.clearAllMocks();
  voiceService.available = true;
});

describe('the timeline', () => {
  it('has a track each for the picture, the voices, the captions and the music', () => {
    show({ settings: { music: MUSIC } });
    expect(screen.getByRole('heading', { name: 'Editor' })).toBeTruthy();
    expect(track('Video track').getAllByRole('button').length).toBe(2);
    expect(track('Voice track').getAllByRole('button', { hidden: true }).length).toBe(2);
    expect(track('Captions track').getByText('Line 0.')).toBeTruthy();
    expect(screen.getByTestId('editor-end').textContent).toBe('0:10.0');
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
    const card = track('Video track').getByRole('button', { name: 'End card, 3 seconds' });
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
    // Every time on screen follows: the total, the end mark on the ruler, and the clip's own length.
    expect(screen.getByText('0:00.0 / 0:08.5')).toBeTruthy();
    expect(screen.getByTestId('editor-end').textContent).toBe('0:08.5');
    expect(screen.getByTestId('editor-end').style.left).toBe(`${8.5 * PPS}px`);
    expect(within(clip(1)).getByText('3.5s')).toBeTruthy();
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
    // The readout follows on the next render; under a busy test run that is not always at once.
    expect(await screen.findByText('0:02.0 / 0:10.0')).toBeTruthy();
    await waitFor(() => expect(document.querySelector('.tl-playhead').style.left).toBe(`${2 * PPS}px`));
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

  const canvasAt = (leftEdge) => {
    document.querySelector('.tl-canvas').getBoundingClientRect = () => ({ left: leftEdge, top: 0, width: 600, height: 200 });
  };

  it('moves the playhead to where the ruler is pressed, and follows the pointer while it is held', () => {
    show();
    canvasAt(20);
    const ruler = screen.getByTestId('editor-ruler');
    fireEvent.pointerDown(ruler, { clientX: 20 + 7 * PPS, pointerId: 1 });
    expect(screen.getByText('0:07.0 / 0:10.0')).toBeTruthy();
    expect(preview().getAttribute('aria-label')).toBe('Preview: scene 2');
    fireEvent.pointerMove(ruler, { clientX: 20 + 2 * PPS, pointerId: 1 });
    expect(screen.getByText('0:02.0 / 0:10.0')).toBeTruthy();
    expect(preview().getAttribute('aria-label')).toBe('Preview: scene 1');
    fireEvent.pointerUp(ruler, { pointerId: 1 });
    fireEvent.pointerMove(ruler, { clientX: 20 + 9 * PPS, pointerId: 1 });      // let go: it stays
    expect(screen.getByText('0:02.0 / 0:10.0')).toBeTruthy();
  });

  it('lets the playhead itself be dragged, and never past the ends', () => {
    show();
    canvasAt(0);
    const knob = screen.getByTestId('editor-playhead');
    fireEvent.pointerDown(knob, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(knob, { clientX: 4.5 * PPS, pointerId: 1 });
    expect(screen.getByText('0:04.5 / 0:10.0')).toBeTruthy();
    expect(document.querySelector('.tl-playhead').style.left).toBe(`${4.5 * PPS}px`);
    fireEvent.pointerMove(knob, { clientX: 99 * PPS, pointerId: 1 });
    expect(screen.getByText('0:10.0 / 0:10.0')).toBeTruthy();
    fireEvent.pointerMove(knob, { clientX: -500, pointerId: 1 });
    expect(screen.getByText('0:00.0 / 0:10.0')).toBeTruthy();
  });

  it('pauses when the playhead is grabbed', async () => {
    show();
    canvasAt(0);
    await userEvent.click(screen.getByRole('button', { name: 'Play' }));
    fireEvent.pointerDown(screen.getByTestId('editor-ruler'), { clientX: 60, pointerId: 1 });
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
  });

  it('jumps to a clip when it is selected', async () => {
    show();
    await userEvent.click(clip(2));
    expect(screen.getByText('0:05.0 / 0:10.0')).toBeTruthy();
  });

  it('keeps every scene loaded, so going to the next one shows no blank', async () => {
    show();
    const players = [...document.querySelectorAll('.editor-preview video')];
    expect(players.map((p) => p.getAttribute('src'))).toEqual(['https://files.test/0.mp4', 'https://files.test/1.mp4']);
    expect(players.map((p) => p.className)).toEqual(['is-current', '']);
    await userEvent.click(screen.getByRole('button', { name: 'Play' }));
    fireEvent.ended(preview());
    const after = [...document.querySelectorAll('.editor-preview video')];
    expect(after[0]).toBe(players[0]);                      // the same players, not reloaded
    expect(after.map((p) => p.className)).toEqual(['', 'is-current']);
  });

  it('rests a waiting scene on its first kept frame', () => {
    show({ settings: { edits: { 1: { attempt: 1, start: 1.5 } } } });
    const waiting = document.querySelectorAll('.editor-preview video')[1];
    fireEvent.loadedMetadata(waiting);
    expect(waiting.currentTime).toBe(1.5);
  });

  it('moves to a clip when it is selected while playing, so the scene being adjusted is heard', async () => {
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Play' }));
    await userEvent.click(clip(2));
    expect(preview().getAttribute('aria-label')).toBe('Preview: scene 2');
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();   // still playing
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

describe('captions on the timeline', () => {
  const caption = (number) => track('Captions track').getByRole('button', { name: new RegExp(`^Caption of scene ${number}:`) });

  it('opens a scene\'s caption text and saves a change', async () => {
    show();
    await userEvent.click(caption(2));
    expect(screen.getByRole('heading', { name: 'Caption of scene 2' })).toBeTruthy();
    const field = screen.getByLabelText('Caption text');
    expect(field.value).toBe('Line 1.');
    fireEvent.change(field, { target: { value: 'One pump, every night.' } });
    expect(track('Captions track').getByText('One pump, every night.')).toBeTruthy();
    fireEvent.blur(field);
    expect(saved()).toEqual(['p1', { 'captions.texts.1': 'One pump, every night.', 'captions.textFor.1': 'Line 1.' }]);
  });

  it('goes back to the script when the script changed after the caption was typed', async () => {
    show({ settings: { captions: { texts: { 0: 'Typed for the old script.' }, textFor: { 0: 'The old script.' } } } });
    expect(track('Captions track').queryByText('Typed for the old script.')).toBeNull();
    await userEvent.click(caption(1));
    expect(screen.getByLabelText('Caption text').value).toBe('Line 0.');
    expect(screen.queryByRole('button', { name: 'Use the script again' })).toBeNull();
  });

  it('can empty a caption, and go back to the script', async () => {
    show({ settings: { captions: { texts: { 0: 'My own words.' } } } });
    await userEvent.click(caption(1));
    fireEvent.change(screen.getByLabelText('Caption text'), { target: { value: '' } });
    expect(track('Captions track').getByText('No caption')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Use the script again' }));
    expect(saved()).toEqual(['p1', { 'captions.texts.0': 'DELETE', 'captions.textFor.0': 'DELETE' }]);
  });

  it('uses the page\'s caption texts when the page keeps them', async () => {
    const page = { textOf: (s) => `page text ${s.id}`, isOwn: () => true, change: vi.fn(), commit: vi.fn(), reset: vi.fn() };
    show({ captions: page });
    await userEvent.click(caption(1));
    const field = screen.getByLabelText('Caption text');
    expect(field.value).toBe('page text 0');
    fireEvent.change(field, { target: { value: 'New' } });
    fireEvent.blur(field);
    await userEvent.click(screen.getByRole('button', { name: 'Use the script again' }));
    expect(page.change).toHaveBeenCalledWith('0', 'New');
    expect(page.commit).toHaveBeenCalledWith('0');
    expect(page.reset).toHaveBeenCalledWith('0');
    expect(updateProjectSettings).not.toHaveBeenCalled();
  });
});

describe('the end card on the timeline', () => {
  const settings = { endCard: { enabled: true, imageRef: 'card.png', seconds: 3 } };

  it('opens its length only: the card is a picture, with no text fields', async () => {
    show({ settings });
    await userEvent.click(track('Video track').getByRole('button', { name: 'End card, 3 seconds' }));
    expect(screen.getByRole('heading', { name: 'End card' })).toBeTruthy();
    expect(screen.getByLabelText('Length').value).toBe('3');
    expect(screen.queryByLabelText('Headline')).toBeNull();
    expect(screen.queryByLabelText('Second line')).toBeNull();
  });

  it('changes its length, and the timeline grows with it', async () => {
    show({ settings });
    await userEvent.click(track('Video track').getByRole('button', { name: 'End card, 3 seconds' }));
    await userEvent.selectOptions(screen.getByLabelText('Length'), '4');
    await waitFor(() => expect(saved()).toEqual(['p1', { 'endCard.seconds': 4 }]), { timeout: 2000 });
  });

  it('is not on the timeline when it is off', () => {
    show({ settings: { endCard: { ...settings.endCard, enabled: false } } });
    expect(track('Video track').queryByRole('button', { name: /End card/ })).toBeNull();
  });
});

describe('export for another editor', () => {
  it('asks the server for a package', async () => {
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Export for another editor' }));
    expect(exportPackage).toHaveBeenCalledWith('p1');
  });

  it('says it is being prepared, and cannot be asked for twice', () => {
    show({ project: { packageStatus: 'building', packageStartedAt: Date.now() } });
    expect(screen.getByText(/Preparing the package: the clips, the music, a timeline file and the captions\. It downloads by itself/)).toBeTruthy();
    expect(document.getElementById('editor-export').disabled).toBe(true);
  });

  it('gives the download once it is ready', () => {
    show({ project: { packageStatus: 'ready', packageUrl: 'https://files.test/mug-ad.zip', packageName: 'mug-ad.zip' } });
    const link = screen.getByRole('link', { name: 'download mug-ad.zip' });
    expect(link.getAttribute('href')).toBe('https://files.test/mug-ad.zip');
    expect(screen.getByText(/opens in Premiere Pro and DaVinci Resolve/)).toBeTruthy();
  });

  it('says why it failed, and lets you try again', () => {
    show({ project: { packageStatus: 'failed', packageError: 'Every scene in the video needs a video before the project can be exported.' } });
    expect(screen.getByText(/could not be made: Every scene in the video needs a video/)).toBeTruthy();
    expect(document.getElementById('editor-export').disabled).toBe(false);
  });

  it('treats a package that never finished as not running', () => {
    show({ project: { packageStatus: 'building', packageStartedAt: Date.now() - 11 * 60 * 1000 } });
    expect(document.getElementById('editor-export').disabled).toBe(false);
  });

  it('shows a request that could not be sent', async () => {
    exportPackage.mockRejectedValueOnce(new Error('offline'));
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Export for another editor' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

describe('hearing the chosen voice in the editor', () => {
  const VOICE = { id: 'v1', name: 'Sarah' };
  const preview = (ids, extra = {}) => ({
    voiceId: 'v1', status: 'ready', scenes: Object.fromEntries(ids.map((id) => [id, { attempt: 1, url: `https://files.test/voice_${id}.mp3` }])), ...extra,
  });
  const current = () => screen.getByLabelText(/^Preview: scene/);

  it('plays each scene\'s own voice when no voice is chosen', () => {
    show();
    expect(screen.getByText(/The preview plays each scene’s own voice with the music and the sound effects\./)).toBeTruthy();
    expect(document.querySelector('[data-testid^="dub-"]')).toBeNull();
    expect(previewVoice).not.toHaveBeenCalled();
  });

  it('plays the chosen voice in place of the scene\'s own sound once it is prepared', () => {
    show({ settings: { voice: VOICE }, project: { voicePreview: preview(['0', '1']) } });
    expect(screen.getByText(/The preview plays the voice you chose \(Sarah\) with the music\./)).toBeTruthy();
    expect(screen.queryByText(/Loading the voice/)).toBeNull();
    expect(screen.getByTestId('dub-0').getAttribute('src')).toBe('https://files.test/voice_0.mp3');
    fireEvent.loadedMetadata(current());
    expect(current().muted).toBe(true);                  // the scene's own voice is silenced
    expect(screen.getByTestId('dub-0').muted).toBe(false);
    expect(previewVoice).not.toHaveBeenCalled();
  });

  it('asks for the voice to be prepared when it is chosen but not prepared yet, once', async () => {
    const { rerender } = show({ settings: { voice: VOICE } });
    expect(screen.getByText(/Loading the voice Sarah: 0 of 2 scenes ready\./)).toBeTruthy();
    await waitFor(() => expect(previewVoice).toHaveBeenCalledWith('p1'));
    rerender(<EditorCard project={{ id: 'p1', settings: { voice: VOICE } }} scenes={list(scene('0'), scene('1'))} fallbackSeconds={5} />);
    expect(previewVoice).toHaveBeenCalledTimes(1);
  });

  it('uses the voice scene by scene while the rest is still being prepared', () => {
    show({ settings: { voice: VOICE }, project: { voicePreview: preview(['0'], { status: 'building', startedAt: Date.now() }) } });
    expect(screen.getByText(/Loading the voice Sarah: 1 of 2 scenes ready\./)).toBeTruthy();
    expect(track('Voice track').getByText('100% · Sarah')).toBeTruthy();
    expect(track('Voice track').getByText('100% · loading voice…')).toBeTruthy();
    expect(screen.getByTestId('dub-0')).toBeTruthy();
    expect(screen.queryByTestId('dub-1')).toBeNull();
    expect(previewVoice).not.toHaveBeenCalled();
  });

  it('does not use a voice prepared for another take or another voice', async () => {
    show({ settings: { voice: VOICE }, scenes: list(scene('0', { activeAttempt: 2 })), project: { voicePreview: preview(['0']) } });
    expect(screen.queryByTestId('dub-0')).toBeNull();
    await waitFor(() => expect(previewVoice).toHaveBeenCalled());
  });

  it('says why the voice could not be prepared, and tries again when asked', async () => {
    show({ settings: { voice: VOICE }, project: { voicePreview: preview([], { status: 'failed', error: 'That voice no longer exists.' }) } });
    expect(screen.getByText(/could not be prepared: That voice no longer exists\./)).toBeTruthy();
    expect(previewVoice).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(previewVoice).toHaveBeenCalledWith('p1');
  });

  it('keeps the voice in step with the picture while playing', async () => {
    show({ settings: { voice: VOICE }, project: { voicePreview: preview(['0', '1']) } });
    await userEvent.click(screen.getByRole('button', { name: 'Play' }));
    const voiceOver = screen.getByTestId('dub-0');
    const at = (element, seconds) => Object.defineProperty(element, 'currentTime', { value: seconds, configurable: true, writable: true });
    at(current(), 2);
    at(voiceOver, 2.1);                                   // a little ahead: left alone, a jump would be heard
    fireEvent.timeUpdate(current());
    expect(voiceOver.currentTime).toBe(2.1);
    at(voiceOver, 2.4);                                   // enough to show on the lips: pulled back
    fireEvent.timeUpdate(current());
    expect(voiceOver.currentTime).toBe(2);
    at(voiceOver, 2.5);                                   // not again straight away
    fireEvent.timeUpdate(current());
    expect(voiceOver.currentTime).toBe(2.5);
  });

  it('applies a volume or mute change at once, without restarting the scene', async () => {
    show({ settings: { voice: VOICE }, project: { voicePreview: preview(['0', '1']) } });
    await userEvent.click(clip(1));
    fireEvent.change(screen.getByLabelText('Voice volume'), { target: { value: '50' } });
    expect(screen.getByTestId('dub-0').volume).toBe(0.35);   // half of the preview's level for 100%
    await userEvent.click(screen.getByLabelText("Mute this scene's own sound"));
    expect(screen.getByTestId('dub-0').muted).toBe(true);
  });

  it('applies the volume to the scene\'s own sound when no voice is chosen', async () => {
    show();
    await userEvent.click(clip(1));
    fireEvent.change(screen.getByLabelText('Voice volume'), { target: { value: '30' } });
    expect(current().volume).toBeCloseTo(0.21);
    expect(current().muted).toBe(false);
    fireEvent.change(screen.getByLabelText('Voice volume'), { target: { value: '100' } });
    expect(current().volume).toBeCloseTo(0.7);
    fireEvent.change(screen.getByLabelText('Voice volume'), { target: { value: '200' } });
    expect(current().volume).toBe(1);                      // a boost is heard too
  });
});

describe('the export downloads by itself', () => {
  it('saves the package as soon as the server has built it, after it was asked for here', async () => {
    const clicked = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record() { clicked.push([this.href, this.download]); });
    try {
      const { rerender } = show();
      await userEvent.click(screen.getByRole('button', { name: 'Export for another editor' }));
      expect(clicked).toEqual([]);
      const done = { id: 'p1', settings: {}, packageStatus: 'ready', packageUrl: 'https://files.test/mug-ad.zip', packageName: 'mug-ad.zip' };
      rerender(<EditorCard project={done} scenes={list(scene('0'), scene('1'))} fallbackSeconds={5} />);
      await waitFor(() => expect(clicked).toEqual([['https://files.test/mug-ad.zip', 'mug-ad.zip']]));
      rerender(<EditorCard project={{ ...done }} scenes={list(scene('0'), scene('1'))} fallbackSeconds={5} />);
      expect(clicked.length).toBe(1);                       // once, not on every update of the project
    } finally {
      click.mockRestore();
    }
  });

  it('does not download a package that was already there when the page opened', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      show({ project: { packageStatus: 'ready', packageUrl: 'https://files.test/old.zip', packageName: 'old.zip' } });
      expect(click).not.toHaveBeenCalled();
      expect(screen.getByRole('link', { name: 'download old.zip' })).toBeTruthy();
    } finally {
      click.mockRestore();
    }
  });
});

describe('sound effects', () => {
  const WHOOSH = { name: 'Whoosh', prompt: 'soft whoosh', storageRef: 'users/u1/projects/p1/sounds/w.mp3', url: 'https://files.test/w.mp3', seconds: 1, sceneId: '1', at: 2, volume: 60 };
  const sound = (name) => track('Sounds track').getByRole('button', { name: new RegExp(`^Sound: ${name},`) });
  const at = (element, seconds) => Object.defineProperty(element, 'currentTime', { value: seconds, configurable: true, writable: true });
  const preview = () => screen.getByLabelText(/^Preview: scene/);

  it('makes a sound from a description and puts it at the playhead', async () => {
    makeSound.mockResolvedValueOnce({ id: 's1', name: 'Soft whoosh', prompt: 'soft whoosh', storageRef: 'users/u1/projects/p1/sounds/s1.mp3', url: 'https://files.test/s1.mp3', seconds: 1.2 });
    show();
    document.querySelector('.tl-canvas').getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 200 });
    fireEvent.pointerDown(screen.getByTestId('editor-ruler'), { clientX: 7 * PPS, pointerId: 1 });   // 2s into scene 2
    expect(track('Sounds track').getByText(/No sound effects/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Add sound' }));
    expect(screen.getByRole('heading', { name: 'New sound effect' })).toBeTruthy();
    expect(screen.getByText(/It is placed at the playhead \(0:07\.0\)/)).toBeTruthy();
    const make = screen.getByRole('button', { name: 'Make it and place it' });
    expect(make.disabled).toBe(true);                                     // nothing described yet
    await userEvent.type(screen.getByLabelText('Describe the sound'), 'soft whoosh');
    await userEvent.selectOptions(screen.getByLabelText('Length'), '2');
    await userEvent.click(make);

    expect(makeSound).toHaveBeenCalledWith('p1', { prompt: 'soft whoosh', seconds: 2 });
    await waitFor(() => expect(saved()).toEqual(['p1', { 'sounds.s1': {
      id: 's1', name: 'Soft whoosh', prompt: 'soft whoosh', storageRef: 'users/u1/projects/p1/sounds/s1.mp3',
      url: 'https://files.test/s1.mp3', seconds: 1.2, volume: 60, sceneId: '1', at: 2,
    } }]));
    expect([left(sound('Soft whoosh')), width(sound('Soft whoosh'))]).toEqual([`${7 * PPS}px`, `${1.2 * PPS}px`]);
    expect(screen.getByRole('heading', { name: 'Sound: Soft whoosh' })).toBeTruthy();   // selected, ready to adjust
  });

  it('fills the description from an idea, and lets the service pick the length', async () => {
    makeSound.mockResolvedValueOnce({ id: 's2', name: 'Pop', storageRef: 'f.mp3', url: 'u', seconds: 0.4 });
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Add sound' }));
    await userEvent.click(within(screen.getByRole('group', { name: 'Ideas' })).getByRole('button', { name: 'Pop' }));
    expect(screen.getByLabelText('Describe the sound').value).toBe('Single clean pop, like a bubble');
    await userEvent.click(screen.getByRole('button', { name: 'Make it and place it' }));
    expect(makeSound).toHaveBeenCalledWith('p1', { prompt: 'Single clean pop, like a bubble', seconds: null });
  });

  it('says why when the sound could not be made, and places nothing', async () => {
    makeSound.mockRejectedValueOnce(new Error('The sound service did not accept this description. Reword it and try again.'));
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Add sound' }));
    await userEvent.type(screen.getByLabelText('Describe the sound'), 'zz');
    await userEvent.click(screen.getByRole('button', { name: 'Make it and place it' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/did not accept this description/);
    expect(updateProjectSettings).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Describe the sound').value).toBe('zz');    // kept, to reword it
  });

  it('is not offered without the sound service, but sounds already placed are still shown', () => {
    voiceService.available = false;
    const { unmount } = show();
    expect(screen.queryByRole('button', { name: 'Add sound' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Sounds track' })).toBeNull();
    unmount();
    show({ settings: { sounds: { w: WHOOSH } } });
    expect(sound('Whoosh')).toBeTruthy();
  });

  it('shows a sound where its moment of the scene is, also after an earlier scene is trimmed', () => {
    show({ settings: { sounds: { w: WHOOSH } } });
    expect(left(sound('Whoosh'))).toBe(`${7 * PPS}px`);                    // scene 1 is 5s, then 2s into scene 2
    cleanup();
    show({ settings: { sounds: { w: WHOOSH }, edits: { 0: { attempt: 1, end: 3 } } } });
    expect(left(sound('Whoosh'))).toBe(`${5 * PPS}px`);                    // scene 1 now ends at 3s
  });

  it('moves when it is dragged along its track, and saves when let go', async () => {
    show({ settings: { sounds: { w: WHOOSH } } });
    const block = sound('Whoosh');
    fireEvent.pointerDown(block, { clientX: 400, pointerId: 1 });
    fireEvent.pointerMove(block, { clientX: 400 - 4 * PPS, pointerId: 1 });   // 4s earlier: into scene 1
    expect(left(sound('Whoosh'))).toBe(`${3 * PPS}px`);
    expect(updateProjectSettings).not.toHaveBeenCalled();                    // not on every pixel
    fireEvent.pointerUp(sound('Whoosh'), { pointerId: 1 });
    expect(saved()).toEqual(['p1', { 'sounds.w': { id: 'w', ...WHOOSH, sceneId: '0', at: 3 } }]);
  });

  it('is only selected, not moved, by a click', () => {
    show({ settings: { sounds: { w: WHOOSH } } });
    const block = sound('Whoosh');
    fireEvent.pointerDown(block, { clientX: 400, pointerId: 1 });
    fireEvent.pointerMove(block, { clientX: 401, pointerId: 1 });
    fireEvent.pointerUp(block, { pointerId: 1 });
    fireEvent.click(block);
    expect(updateProjectSettings).not.toHaveBeenCalled();
    expect(block.getAttribute('aria-pressed')).toBe('true');
  });

  it('has its start, volume and removal in the panel', async () => {
    show({ settings: { sounds: { w: WHOOSH } } });
    await userEvent.click(sound('Whoosh'));
    expect(screen.getByLabelText('Starts at').value).toBe('7');
    fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '85' } });
    expect(screen.getByRole('button', { name: 'Sound: Whoosh, at 0:07.0, volume 85%' })).toBeTruthy();
    await waitFor(() => expect(saved()[1]['sounds.w'].volume).toBe(85), { timeout: 2000 });

    fireEvent.change(screen.getByLabelText('Starts at'), { target: { value: '1.5' } });
    expect(left(sound('Whoosh'))).toBe(`${1.5 * PPS}px`);
    await waitFor(() => expect(saved()[1]['sounds.w']).toMatchObject({ sceneId: '0', at: 1.5, volume: 85 }), { timeout: 2000 });

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(saved()).toEqual(['p1', { 'sounds.w': 'DELETE' }]);
    expect(track('Sounds track').queryByRole('button')).toBeNull();
  });

  it('plays the sound on its own with Listen', async () => {
    show({ settings: { sounds: { w: WHOOSH } } });
    const player = screen.getByTestId('sound-w');
    player.play = vi.fn(() => Promise.resolve());
    await userEvent.click(sound('Whoosh'));
    await userEvent.click(screen.getByRole('button', { name: 'Listen' }));
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(player.volume).toBeCloseTo(0.42);                                // 60% of a voice at 100%
  });

  it('starts the sound when the playhead reaches it, once', async () => {
    show({ settings: { sounds: { w: { ...WHOOSH, sceneId: '0', at: 2 } } } });
    const player = screen.getByTestId('sound-w');
    player.play = vi.fn(() => Promise.resolve());
    await userEvent.click(screen.getByRole('button', { name: 'Play' }));
    at(preview(), 1);
    fireEvent.timeUpdate(preview());
    expect(player.play).not.toHaveBeenCalled();
    at(preview(), 2.02);
    fireEvent.timeUpdate(preview());
    expect(player.play).toHaveBeenCalledTimes(1);
    at(preview(), 2.3);
    fireEvent.timeUpdate(preview());
    expect(player.play).toHaveBeenCalledTimes(1);

    // Pausing stops it; playing again from its middle picks it up part-way in.
    player.pause = vi.fn();
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(player.pause).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Play' }));
    at(preview(), 2.5);
    fireEvent.timeUpdate(preview());
    expect(player.play).toHaveBeenCalledTimes(2);
    expect(player.currentTime).toBeCloseTo(0.5);
  });

  it('says when a sound sits on a part that is cut away, and lets it be removed', async () => {
    show({ settings: { sounds: { w: { ...WHOOSH, sceneId: '0', at: 4.5 } }, edits: { 0: { attempt: 1, end: 3 } } } });
    expect(track('Sounds track').queryByRole('button')).toBeNull();
    expect(screen.getByText(/One sound effect is not heard/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Whoosh' }));
    expect(screen.getByText(/Not heard: it sits on a part of the video that is cut away/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(saved()).toEqual(['p1', { 'sounds.w': 'DELETE' }]);
    expect(screen.queryByText(/not heard/)).toBeNull();
  });

  it('can sit on the end card', () => {
    show({ settings: { endCard: { enabled: true, imageRef: 'card.png', seconds: 3 }, sounds: { d: { ...WHOOSH, name: 'Ding', sceneId: 'end', at: 0.5 } } } });
    expect(left(sound('Ding'))).toBe(`${10.5 * PPS}px`);
  });
});

describe('narration: a voice made from text', () => {
  const VOICE = { id: 'v1', name: 'Sarah' };
  const MADE = { text: 'Line 0, read aloud.', voiceName: 'Sarah', storageRef: 'n0.mp3', url: 'https://files.test/n0.mp3', seconds: 3 };
  const narrated = (settings = {}) => show({ settings: { voice: VOICE, ...settings }, scenes: list(scene('0', { narration: MADE }), scene('1')) });
  const block = () => track('Voice track').getByRole('button', { name: /^Narration of scene 1/ });
  const current = () => screen.getByLabelText(/^Preview: scene/);
  const at = (element, seconds) => Object.defineProperty(element, 'currentTime', { value: seconds, configurable: true, writable: true });

  it('is offered from a scene, starting from its script', async () => {
    show({ settings: { voice: VOICE } });
    await userEvent.click(clip(1));
    await userEvent.click(screen.getByRole('button', { name: 'Make a voice for this scene from text' }));
    expect(screen.getByRole('heading', { name: 'Narration: scene 1' })).toBeTruthy();
    expect(screen.getByLabelText('What the voice says').value).toBe('Line 0.');
    expect(screen.queryByLabelText('Starts at')).toBeNull();           // nothing to place before a voice exists
  });

  it('makes the voice from its own text, with pauses, and places it whole', async () => {
    show({ settings: { voice: VOICE } });
    await userEvent.click(clip(1));
    await userEvent.click(screen.getByRole('button', { name: 'Make a voice for this scene from text' }));
    const box = screen.getByLabelText('What the voice says');
    fireEvent.change(box, { target: { value: 'Line 0. [pause 1] Really.' } });
    await userEvent.click(screen.getByRole('button', { name: 'Make the voice' }));
    expect(makeNarration).toHaveBeenCalledWith('p1', '0', 'Line 0. [pause 1] Really.');
    await waitFor(() => expect(saved()).toEqual(['p1', { 'narration.0': { at: 0, trimStart: 0, trimEnd: 0, on: true } }]));
  });

  it('needs a voice chosen for the video', async () => {
    show();
    await userEvent.click(clip(1));
    await userEvent.click(screen.getByRole('button', { name: 'Make a voice for this scene from text' }));
    expect(screen.getByRole('button', { name: 'Make the voice' }).disabled).toBe(true);
    expect(screen.getByText(/Choose a voice in the Voice card first/)).toBeTruthy();
  });

  it('is not offered without the voice service', async () => {
    voiceService.available = false;
    show();
    await userEvent.click(clip(1));
    expect(screen.queryByRole('button', { name: 'Make a voice for this scene from text' })).toBeNull();
  });

  it('sits on the Voice track where it is heard, in place of the take\'s voice', () => {
    narrated({ narration: { 0: { at: 1 } } });
    expect([left(block()), width(block())]).toEqual([`${1 * PPS}px`, `${3 * PPS}px`]);
    expect(block().getAttribute('aria-label')).toBe('Narration of scene 1: at 0:01.0, 3.0 seconds');
    expect(track('Voice track').getByText('Narration · Sarah')).toBeTruthy();
    expect(track('Voice track').getByText(/^100%/)).toBeTruthy();        // scene 2 keeps its own voice
  });

  it('opens its panel: says that it fits, and slides and trims with numbers', async () => {
    narrated();
    await userEvent.click(block());
    expect(screen.getByLabelText('What the voice says').value).toBe('Line 0, read aloud.');
    expect(screen.getByText(/The voice is 3\.0s and fits the scene \(5\.0s\)/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Starts at'), { target: { value: '1.5' } });
    expect(left(block())).toBe(`${1.5 * PPS}px`);
    await waitFor(() => expect(saved()).toEqual(['p1', { 'narration.0': { at: 1.5, trimStart: 0, trimEnd: 0, on: true } }]), { timeout: 2000 });
    fireEvent.change(screen.getByLabelText('Cut from its end'), { target: { value: '1' } });
    expect(width(block())).toBe(`${2 * PPS}px`);
    await waitFor(() => expect(saved()).toEqual(['p1', { 'narration.0': { at: 1.5, trimStart: 0, trimEnd: 1, on: true } }]), { timeout: 2000 });
  });

  it('warns when the voice runs past the end of the scene', async () => {
    narrated({ narration: { 0: { at: 3 } } });
    await userEvent.click(block());
    expect(screen.getByText(/runs 1\.0s past the end of the scene/)).toBeTruthy();
    expect(width(block())).toBe(`${2 * PPS}px`);                          // only the part that is heard
  });

  it('slides against the picture when dragged, and is saved when let go', async () => {
    narrated();
    fireEvent.pointerDown(block(), { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(block(), { clientX: 100 + 1 * PPS, pointerId: 1 });
    expect(left(block())).toBe(`${1 * PPS}px`);
    expect(updateProjectSettings).not.toHaveBeenCalled();
    fireEvent.pointerUp(block(), { pointerId: 1 });
    await waitFor(() => expect(saved()).toEqual(['p1', { 'narration.0': { at: 1, trimStart: 0, trimEnd: 0, on: true } }]));
  });

  it('a click without a drag only selects it', () => {
    narrated();
    fireEvent.pointerDown(block(), { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(block(), { pointerId: 1 });
    expect(screen.getByRole('heading', { name: 'Narration: scene 1' })).toBeTruthy();
    expect(updateProjectSettings).not.toHaveBeenCalled();
  });

  it('is what the preview plays for its scene: the take is silenced', () => {
    narrated({ narration: { 0: { at: 1, trimStart: 0.5 } } });
    const voice = screen.getByTestId('narration-0');
    expect(voice.getAttribute('src')).toBe('https://files.test/n0.mp3');
    fireEvent.loadedMetadata(current());
    expect(current().muted).toBe(true);
    expect(voice.muted).toBe(false);
    expect(screen.queryByTestId('narration-1')).toBeNull();
  });

  it('follows the picture: silent before it starts, then from the right moment', async () => {
    narrated({ narration: { 0: { at: 1, trimStart: 0.5 } } });
    const voice = screen.getByTestId('narration-0');
    voice.play = vi.fn(async () => {});
    voice.pause = vi.fn();
    await userEvent.click(screen.getByRole('button', { name: 'Play' }));
    at(current(), 0.5);
    fireEvent.timeUpdate(current());
    expect(voice.play).not.toHaveBeenCalled();                            // the voice starts at 1s
    at(current(), 2);
    fireEvent.timeUpdate(current());
    expect(voice.currentTime).toBe(1.5);                                  // 1s in, plus the 0.5s cut from its start
    expect(voice.play).toHaveBeenCalled();
  });

  it('can be switched off, which brings the take\'s own voice back', async () => {
    narrated();
    await userEvent.click(block());
    await userEvent.click(screen.getByLabelText("Use this voice in place of the scene's own sound"));
    await waitFor(() => expect(saved()).toEqual(['p1', { 'narration.0': { at: 0, trimStart: 0, trimEnd: 0, on: false } }]));
    expect(track('Voice track').queryByRole('button', { name: /^Narration of scene 1/ })).toBeNull();
    expect(track('Voice track').getAllByText(/^100%/).length).toBe(2);
  });

  it('is removed from its panel', async () => {
    narrated();
    await userEvent.click(block());
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(removeNarration).toHaveBeenCalledWith('p1', '0');
  });

  it('says why when the voice could not be made', async () => {
    makeNarration.mockRejectedValueOnce(new Error('The voice service is busy. Wait a minute and try again.'));
    narrated();
    await userEvent.click(block());
    await userEvent.click(screen.getByRole('button', { name: 'Make the voice again' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/busy/);
    expect(updateProjectSettings).not.toHaveBeenCalled();
  });
});

describe('captions placed by hand', () => {
  const placed = (blocks, extra = {}) => ({ captions: { manual: { 0: true }, blocks, ...extra } });
  const BLOCK = { sceneId: '0', at: 1, length: 1.5, text: 'By hand' };
  const caption = (text) => track('Captions track').getByRole('button', { name: new RegExp(`^Caption in scene 1: ${text},`) });
  const savedKeys = () => Object.keys(saved()[1]).map((key) => key.replace(/blocks\.c[a-z0-9]+$/, 'blocks.*')).sort();

  it('cuts a scene\'s caption into short captions that can be moved', async () => {
    show({ scenes: list(scene('0', { script: 'This watch looks far more expensive than it is.' }), scene('1')) });
    await userEvent.click(track('Captions track').getByRole('button', { name: /^Caption of scene 1:/ }));
    await userEvent.click(screen.getByRole('button', { name: "Place this scene's captions by hand" }));
    const made = track('Captions track').getAllByRole('button', { name: /^Caption in scene 1:/ });
    expect(made.map((b) => b.textContent)).toEqual(['This watch looks far', 'more expensive than it', 'is.']);
    expect(left(made[0].parentElement)).toBe('0px');
    expect(savedKeys()).toEqual(['captions.blocks.*', 'captions.blocks.*', 'captions.blocks.*', 'captions.manual.0']);
    expect(saved()[1]['captions.manual.0']).toBe(true);
    expect(screen.getByRole('heading', { name: 'Caption in scene 1' })).toBeTruthy();      // the first one is open
    expect(track('Captions track').getByRole('button', { name: /^Caption of scene 2:/ })).toBeTruthy();   // scene 2 stays automatic
  });

  it('shows a caption where it was placed, as long as it lasts', () => {
    show({ settings: placed({ a: BLOCK }) });
    expect([left(caption('By hand').parentElement), width(caption('By hand').parentElement)]).toEqual([`${1 * PPS}px`, `${1.5 * PPS}px`]);
    expect(track('Captions track').queryByRole('button', { name: /^Caption of scene 1:/ })).toBeNull();
  });

  it('rewords, moves and trims a caption from its panel', async () => {
    show({ settings: placed({ a: BLOCK }) });
    await userEvent.click(caption('By hand'));
    fireEvent.change(screen.getByLabelText('Caption text'), { target: { value: 'New words' } });
    expect(caption('New words')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Starts at'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Shown for'), { target: { value: '0.5' } });
    expect([left(caption('New words').parentElement), width(caption('New words').parentElement)]).toEqual([`${2 * PPS}px`, `${0.5 * PPS}px`]);
    await waitFor(() => expect(saved()).toEqual(['p1', { 'captions.blocks.a': { sceneId: '0', at: 2, length: 0.5, text: 'New words' } }]), { timeout: 2000 });
  });

  it('moves a caption when it is dragged, and saves it when let go', async () => {
    show({ settings: placed({ a: BLOCK }) });
    fireEvent.pointerDown(caption('By hand'), { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(caption('By hand'), { clientX: 100 + 2 * PPS, pointerId: 1 });
    expect(left(caption('By hand').parentElement)).toBe(`${3 * PPS}px`);
    expect(updateProjectSettings).not.toHaveBeenCalled();
    fireEvent.pointerUp(caption('By hand'), { pointerId: 1 });
    await waitFor(() => expect(saved()).toEqual(['p1', { 'captions.blocks.a': { ...BLOCK, at: 3 } }]));
  });

  it('keeps a caption inside its scene', () => {
    show({ settings: placed({ a: BLOCK }) });
    fireEvent.pointerDown(caption('By hand'), { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(caption('By hand'), { clientX: 100 + 30 * PPS, pointerId: 1 });
    expect(left(caption('By hand').parentElement)).toBe(`${4.8 * PPS}px`);      // the scene is 5s long
  });

  it('is trimmed by dragging its right edge', async () => {
    show({ settings: placed({ a: BLOCK }) });
    const edge = screen.getByTestId('caption-end-a');
    fireEvent.pointerDown(edge, { clientX: 200, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 200 - 1 * PPS, pointerId: 1 });
    expect(width(caption('By hand').parentElement)).toBe(`${0.5 * PPS}px`);
    fireEvent.pointerUp(edge, { pointerId: 1 });
    await waitFor(() => expect(saved()).toEqual(['p1', { 'captions.blocks.a': { ...BLOCK, length: 0.5 } }]));
  });

  it('removes a caption', async () => {
    show({ settings: placed({ a: BLOCK, b: { ...BLOCK, at: 3, text: 'Second' } }) });
    await userEvent.click(caption('By hand'));
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(saved()).toEqual(['p1', { 'captions.blocks.a': 'DELETE' }]);
    expect(track('Captions track').queryByRole('button', { name: /By hand/ })).toBeNull();
    expect(caption('Second')).toBeTruthy();
  });

  it('says so when a scene placed by hand has no caption left', () => {
    show({ settings: placed({}) });
    expect(track('Captions track').getByText(/No caption\. “Add caption” puts one at the playhead\./)).toBeTruthy();
  });

  it('adds a caption at the playhead', async () => {
    show({ settings: placed({ a: BLOCK }) });
    fireEvent.pointerDown(screen.getByTestId('editor-ruler'), { clientX: 3 * PPS, pointerId: 1 });     // 3s into scene 1
    fireEvent.pointerUp(screen.getByTestId('editor-ruler'), { pointerId: 1 });
    await userEvent.click(screen.getByRole('button', { name: 'Add caption' }));
    expect(left(caption('New caption').parentElement)).toBe(`${3 * PPS}px`);
    expect(screen.getByLabelText('Caption text').value).toBe('New caption');
    expect(Object.values(saved()[1])).toEqual([{ sceneId: '0', at: 3, length: 1.5, text: 'New caption' }]);
  });

  it('adding to a scene with an automatic caption keeps that caption, cut into captions', async () => {
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Add caption' }));
    const made = track('Captions track').getAllByRole('button', { name: /^Caption in scene 1:/ });
    expect(made.map((b) => b.textContent).sort()).toEqual(['Line 0.', 'New caption']);
    expect(saved()[1]['captions.manual.0']).toBe(true);
  });

  it('goes back to the automatic caption', async () => {
    show({ settings: placed({ a: BLOCK }) });
    await userEvent.click(caption('By hand'));
    await userEvent.click(screen.getByRole('button', { name: 'Back to the automatic caption for this scene' }));
    expect(saved()).toEqual(['p1', { 'captions.manual.0': 'DELETE', 'captions.blocks.a': 'DELETE' }]);
    expect(track('Captions track').getByRole('button', { name: /^Caption of scene 1: Line 0\./ })).toBeTruthy();
  });

  it('spreads the captions over the narration when the scene has one', async () => {
    const narration = { text: 'Line 0.', storageRef: 'n.mp3', url: 'https://files.test/n.mp3', seconds: 2 };
    show({ settings: { narration: { 0: { at: 2 } } }, scenes: list(scene('0', { narration }), scene('1')) });
    await userEvent.click(track('Captions track').getByRole('button', { name: /^Caption of scene 1:/ }));
    await userEvent.click(screen.getByRole('button', { name: "Place this scene's captions by hand" }));
    const made = caption('Line 0\\.');
    expect([left(made.parentElement), width(made.parentElement)]).toEqual([`${2 * PPS}px`, `${2 * PPS}px`]);
  });

  it('has no Add caption button when captions are off', () => {
    show({ settings: { captions: { style: 'none' } } });
    expect(screen.queryByRole('button', { name: 'Add caption' })).toBeNull();
  });
});
