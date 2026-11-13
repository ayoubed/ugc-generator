import { describe, expect, it } from 'vitest';
import { changeEdit, currentEdits, editSummary, keptRange, musicVolumePercent, sameEdits, sceneEdit } from './edits';
import { finalVideoChangeReason } from './projectProgress';

const scene = { id: '0', activeAttempt: 2, storageRef: 'a.mp4' };
const withEdit = (edit) => ({ settings: { edits: { 0: edit } } });

describe('a scene edit', () => {
  it('is read only for the take it was made on', () => {
    expect(sceneEdit(withEdit({ attempt: 2, start: 0.5, muted: true, junk: 1 }), scene)).toEqual({ start: 0.5, muted: true });
    expect(sceneEdit(withEdit({ attempt: 1, start: 0.5 }), scene)).toBeNull();
    expect(sceneEdit(withEdit({ attempt: 2 }), scene)).toBeNull();
    expect(sceneEdit({ settings: {} }, scene)).toBeNull();
  });

  it('gives the kept part, or the whole clip when the edit leaves nothing', () => {
    expect(keptRange({ start: 1, end: 3.5 }, 5)).toEqual({ start: 1, end: 3.5, length: 2.5 });
    expect(keptRange(null, 5)).toEqual({ start: 0, end: 5, length: 5 });
    expect(keptRange({ start: 4.9, end: 5 }, 5)).toEqual({ start: 0, end: 5, length: 5 });
    expect(keptRange({ end: 9 }, 5).end).toBe(5);
  });

  it('keeps the start and the end apart and inside the clip', () => {
    expect(changeEdit(null, 'start', 1.26, 5, 2)).toEqual({ start: 1.3, attempt: 2 });
    expect(changeEdit({ end: 2 }, 'start', 4, 5, 2)).toEqual({ end: 2, start: 1.7, attempt: 2 });
    expect(changeEdit({ start: 3 }, 'end', 1, 5, 2)).toEqual({ start: 3, end: 3.3, attempt: 2 });
  });

  it('goes back to no edit when everything is as the scene was', () => {
    expect(changeEdit({ start: 1, attempt: 2 }, 'start', 0, 5, 2)).toBeNull();
    expect(changeEdit({ end: 4, attempt: 2 }, 'end', 5, 5, 2)).toBeNull();
    expect(changeEdit({ muted: true, attempt: 2 }, 'muted', false, 5, 2)).toBeNull();
    expect(changeEdit({ volume: 0.5, attempt: 2 }, 'volume', 1, 5, 2)).toBeNull();
  });

  it('limits the voice volume to double', () => {
    expect(changeEdit(null, 'volume', 5, 5, 2)).toEqual({ volume: 2, attempt: 2 });
    expect(changeEdit(null, 'muted', true, 5, 2)).toEqual({ muted: true, attempt: 2 });
  });

  it('is summed up in a few words', () => {
    expect(editSummary({ start: 0.5, end: 4 }, 5)).toBe('0.5s to 4.0s');
    expect(editSummary({ end: 4, muted: true }, 5)).toBe('0.0s to 4.0s · muted');
    expect(editSummary({ volume: 1.5 }, 5)).toBe('voice 150%');
    expect(editSummary(null, 5)).toBe('');
  });
});

describe('edits and the stitched version', () => {
  const scenes = [scene, { id: '1', activeAttempt: 1, storageRef: 'b.mp4', skipped: true }];
  const version = (edits) => ({ version: 1, scenes: [{ sceneId: '0', attempt: 2 }], ...(edits === undefined ? {} : { edits }) });

  it('collects the edits in force, leaving skipped scenes out', () => {
    const project = { settings: { edits: { 0: { attempt: 2, start: 1 }, 1: { attempt: 1, muted: true } } } };
    expect(currentEdits(project, scenes)).toEqual({ 0: { start: 1 } });
  });

  it('compares what the cut would be, not how it is written down', () => {
    expect(sameEdits({ 0: { attempt: 2, start: 1 } }, { 0: { start: 1 } })).toBe(true);
    expect(sameEdits({ 0: { muted: true, volume: 0.5 } }, { 0: { muted: true } })).toBe(true);
    expect(sameEdits({}, { 0: { start: 1 } })).toBe(false);
    expect(sameEdits(undefined, {})).toBe(true);
  });

  it('marks a version out of date after an edit, and leaves older versions alone', () => {
    const project = withEdit({ attempt: 2, start: 1 });
    expect(finalVideoChangeReason(version({}), scenes, project)).toBe('The edit (kept parts or volumes) changed since this version was stitched.');
    expect(finalVideoChangeReason(version({ 0: { attempt: 2, start: 1 } }), scenes, project)).toBe('');
    expect(finalVideoChangeReason(version(), scenes, project)).toBe('');
  });
});

describe('music volume', () => {
  it('shows the old named levels on the slider', () => {
    expect(musicVolumePercent('low')).toBe(24);
    expect(musicVolumePercent('medium')).toBe(40);
    expect(musicVolumePercent('high')).toBe(64);
  });

  it('keeps a number within 0 to 100, and falls back to medium', () => {
    expect(musicVolumePercent(72.4)).toBe(72);
    expect(musicVolumePercent(400)).toBe(100);
    expect(musicVolumePercent(undefined)).toBe(40);
  });
});

describe('edits on top of the automatic cut', () => {
  const auto = { start: 0.4, end: 4.6 };

  it('follows the automatic cut on a side the edit does not set', () => {
    expect(keptRange(null, 5, auto)).toMatchObject({ start: 0.4, end: 4.6 });
    expect(keptRange(null, 5, auto).length).toBeCloseTo(4.2);
    expect(keptRange({ start: 1 }, 5, auto)).toMatchObject({ start: 1, end: 4.6 });
    expect(keptRange({ end: 5 }, 5, auto)).toMatchObject({ start: 0.4, end: 5 });
  });

  it('keeps an edit that reaches past the automatic cut, back to the clip\'s edge', () => {
    expect(changeEdit(null, 'start', 0, 5, 2, auto)).toEqual({ start: 0, attempt: 2 });
    expect(changeEdit(null, 'end', 5, 5, 2, auto)).toEqual({ end: 5, attempt: 2 });
  });

  it('is no edit any more once a side is back on the automatic cut', () => {
    expect(changeEdit({ start: 1, attempt: 2 }, 'start', 0.4, 5, 2, auto)).toBeNull();
    expect(changeEdit({ end: 3, attempt: 2 }, 'end', 4.6, 5, 2, auto)).toBeNull();
  });

  it('cannot move the start past the automatic end', () => {
    expect(changeEdit(null, 'start', 4.9, 5, 2, auto)).toEqual({ start: 4.3, attempt: 2 });
  });
});

describe('the shortest cut', () => {
  it('is kept, despite floating point', () => {
    expect(keptRange({ start: 4.7 }, 5)).toMatchObject({ start: 4.7, end: 5 });
    expect(keptRange({ start: 4.8 }, 5)).toMatchObject({ start: 0, end: 5 });
  });
});
