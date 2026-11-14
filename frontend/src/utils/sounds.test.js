import { describe, expect, it } from 'vitest';
import { buildTimeline } from './timeline';
import { previewSoundGain, projectSounds, sameSounds, soundPlace, soundTime, soundVolume } from './sounds';
import { finalVideoChangeReason } from './projectProgress';

// Scene "a" keeps 0.5s to 3.5s of its clip, scene "b" the first 2s; then a 2.5s end card.
const timeline = buildTimeline([{ id: 'a', start: 0.5, end: 3.5 }, { id: 'b', start: 0, end: 2 }], 2.5);
const noCard = buildTimeline([{ id: 'a', start: 0.5, end: 3.5 }, { id: 'b', start: 0, end: 2 }]);
const file = (extra = {}) => ({ storageRef: 'f.mp3', sceneId: 'a', at: 1, ...extra });

describe('the sounds a project holds', () => {
  it('keeps the ones with a file and a place, with a usable volume', () => {
    const project = { settings: { sounds: {
      b: file({ name: 'Pop', seconds: 0.4, volume: 250, url: 'u' }),
      a: file({ sceneId: 3, at: 0 }),
      noFile: { sceneId: 'a', at: 1 },
      noPlace: { storageRef: 'f.mp3', at: 1 },
      badTime: file({ at: 'soon' }),
      negative: file({ at: -1 }),
      junk: 'x',
    } } };
    expect(projectSounds(project)).toEqual([
      { id: 'a', name: 'Sound', prompt: '', storageRef: 'f.mp3', url: '', seconds: 1, sceneId: '3', at: 0, volume: 60 },
      { id: 'b', name: 'Pop', prompt: '', storageRef: 'f.mp3', url: 'u', seconds: 0.4, sceneId: 'a', at: 1, volume: 100 },
    ]);
    expect(projectSounds({})).toEqual([]);
    expect(projectSounds({ settings: { sounds: 'x' } })).toEqual([]);
  });

  it('reads a volume as 0 to 100, sixty when unset', () => {
    expect([soundVolume(undefined), soundVolume('x'), soundVolume(-4), soundVolume(33.4), soundVolume(900)]).toEqual([60, 60, 0, 33, 100]);
    expect(previewSoundGain(100)).toBe(0.7);       // as loud as a voice at 100%
    expect(previewSoundGain(0)).toBe(0);
  });
});

describe('where a sound is on the timeline', () => {
  it('is counted from the kept start of its scene', () => {
    expect(soundTime(timeline, file({ at: 1.5 }))).toBe(1);
    expect(soundTime(timeline, file({ sceneId: 'b', at: 0.25 }))).toBe(3.25);
    expect(soundTime(timeline, file({ sceneId: 'end', at: 0.5 }))).toBe(5.5);
  });

  it('is nowhere when its moment is cut away or its scene is not in the video', () => {
    expect(soundTime(timeline, file({ at: 0.2 }))).toBeNull();          // before the kept start
    expect(soundTime(timeline, file({ at: 3.5 }))).toBeNull();          // at the cut end
    expect(soundTime(timeline, file({ sceneId: 'gone' }))).toBeNull();
    expect(soundTime(noCard, file({ sceneId: 'end', at: 0.5 }))).toBeNull();
    expect(soundTime(timeline, file({ sceneId: 'end', at: 2.5 }))).toBeNull();
  });

  it('counts a sound a hair before the kept start as at the start', () => {
    const cut = buildTimeline([{ id: 'a', start: 0.433, end: 3.5 }]);
    expect(soundPlace(cut, 0)).toEqual({ sceneId: 'a', at: 0.43 });       // saved to the hundredth
    expect(soundTime(cut, file({ at: 0.43 }))).toBe(0);
    expect(soundTime(cut, file({ at: 0.41 }))).toBeNull();
  });

  it('turns a moment of the timeline back into a scene and a moment of its clip', () => {
    expect(soundPlace(timeline, 1)).toEqual({ sceneId: 'a', at: 1.5 });
    expect(soundPlace(timeline, 3.25)).toEqual({ sceneId: 'b', at: 0.25 });
    expect(soundPlace(timeline, 5.5)).toEqual({ sceneId: 'end', at: 0.5 });
    expect(soundPlace(timeline, -3)).toEqual({ sceneId: 'a', at: 0.5 });
    expect(soundPlace(timeline, 99)).toEqual({ sceneId: 'end', at: 2.45 });   // kept inside the video
    expect(soundPlace(noCard, 99)).toEqual({ sceneId: 'b', at: 1.95 });
    expect(soundPlace(buildTimeline([]), 1)).toBeNull();
  });

  it('gives back the same moment it was placed at', () => {
    [0, 0.8, 2.99, 3, 4.2, 5, 6.3].forEach((seconds) => {
      expect(soundTime(timeline, { ...file(), ...soundPlace(timeline, seconds) })).toBeCloseTo(seconds, 1);
    });
  });
});

describe('a stitched version and the sounds placed now', () => {
  const project = { settings: { sounds: { w: file({ at: 1.5, volume: 60, url: 'https://x' }) } } };
  const recorded = { w: { storageRef: 'f.mp3', sceneId: 'a', at: 1.5, volume: 60 } };

  it('match when nothing that is heard differs', () => {
    expect(sameSounds(recorded, project)).toBe(true);
    expect(sameSounds({}, {})).toBe(true);
    expect(sameSounds(undefined, { settings: {} })).toBe(true);
  });

  it('differ after a sound was moved, turned up or down, added or removed', () => {
    expect(sameSounds({ w: { ...recorded.w, at: 2 } }, project)).toBe(false);
    expect(sameSounds({ w: { ...recorded.w, volume: 80 } }, project)).toBe(false);
    expect(sameSounds({ w: { ...recorded.w, sceneId: 'b' } }, project)).toBe(false);
    expect(sameSounds({}, project)).toBe(false);
    expect(sameSounds(recorded, { settings: {} })).toBe(false);
  });

  it('marks the version out of date, but not versions stitched before sounds existed', () => {
    const scenes = [{ id: 'a', storageRef: 'a.mp4', activeAttempt: 1 }];
    const version = { version: 1, storageRef: 'v.mp4', scenes: [{ sceneId: 'a', attempt: 1 }] };
    expect(finalVideoChangeReason({ ...version, sounds: {} }, scenes, project)).toBe('The sound effects changed since this version was stitched.');
    expect(finalVideoChangeReason({ ...version, sounds: recorded }, scenes, project)).toBe('');
    expect(finalVideoChangeReason(version, scenes, project)).toBe('');
  });
});
