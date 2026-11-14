import { describe, expect, it } from 'vitest';
import {
  changeNarration, isNarrated, narrationKey, narrationLost, narrationTailClock, narrationClock, narrationOverflow, narrationPlace, narrationSpan, sceneNarration, withoutPauses,
} from './narration';

const made = { text: 'Line.', voiceName: 'Ana', storageRef: 'n.mp3', url: 'https://x/n.mp3', seconds: 4 };
const scene = { id: '0', narration: made };
const project = (placed) => ({ settings: placed ? { narration: { 0: placed } } : {} });

describe('narration', () => {
  it('starts with its scene, whole, until it is moved or trimmed', () => {
    expect(sceneNarration(project(), scene)).toMatchObject({ at: 0, trimStart: 0, trimEnd: 0, on: true, length: 4, seconds: 4 });
    expect(sceneNarration(project({ at: 1.5, trimStart: 0.5, trimEnd: 1 }), scene)).toMatchObject({ at: 1.5, length: 2.5 });
    expect(sceneNarration(project(), { id: '0' })).toBeNull();
    expect(sceneNarration(project(), { id: '0', narration: { ...made, seconds: 0 } })).toBeNull();
  });

  it('can be switched off without losing it', () => {
    expect(isNarrated(project(), scene)).toBe(true);
    expect(isNarrated(project({ on: false }), scene)).toBe(false);
    expect(sceneNarration(project({ on: false }), scene).seconds).toBe(4);
    expect(isNarrated(project(), { id: '0' })).toBe(false);
  });

  it('has the same key as the server records, so a stitched version can be compared', () => {
    expect(narrationKey(project({ at: 1, trimEnd: 0.5 }), scene)).toBe('narration:n.mp3:1.00:0.00:0.50');
    expect(narrationKey(project({ on: false }), scene)).toBe('');
    expect(narrationKey(project(), { id: '0' })).toBe('');
  });

  it('uses an unsaved placement in place of the saved one', () => {
    expect(sceneNarration(project({ at: 1 }), scene, { at: 2 }).at).toBe(2);
    expect(sceneNarration(project({ at: 1 }), scene, null).at).toBe(0);
  });

  it('puts bad numbers right, like the server', () => {
    expect(narrationPlace({ at: -2, trimStart: 'x', trimEnd: NaN }, 4)).toEqual({ at: 0, trimStart: 0, trimEnd: 0, on: true });
    const cut = narrationPlace({ trimStart: 3.5, trimEnd: 3.5 }, 4);
    expect(cut.trimStart).toBe(3.5);
    expect(4 - cut.trimStart - cut.trimEnd).toBeGreaterThanOrEqual(0.1 - 1e-9);
  });

  it('is drawn where it is heard on the timeline', () => {
    const clip = { at: 10, start: 1, end: 6 };            // the scene starts at 0:10, with its first second cut
    const narration = sceneNarration(project({ at: 2 }), scene);
    expect(narrationSpan(clip, narration)).toEqual({ time: 11, length: 4 });
    expect(narrationSpan(clip, { ...narration, at: 0 })).toEqual({ time: 10, length: 3 });     // its first second is cut with the clip
    expect(narrationSpan(clip, { ...narration, at: 4 })).toEqual({ time: 13, length: 2 });     // its end runs past the scene
    expect(narrationSpan(clip, { ...narration, at: 7 })).toBeNull();
  });

  it('says by how much it does not fit', () => {
    const narration = sceneNarration(project({ at: 2 }), scene);
    expect(narrationOverflow({ at: 0, start: 0, end: 8 }, narration)).toBe(0);
    expect(narrationOverflow({ at: 0, start: 0, end: 5 }, narration)).toBe(1);
  });

  it('carries on over the next scene when it is longer than what is left of its own', () => {
    const clip = { at: 10, start: 0, end: 3 };
    const narration = sceneNarration(project({ at: 1 }), scene);                    // 4s, heard from 1s: 2s too long
    expect(narrationSpan(clip, narration)).toEqual({ time: 11, length: 2 });        // no next scene: cut at the end
    expect(narrationSpan(clip, narration, 5)).toEqual({ time: 11, length: 4 });     // drawn across the boundary
    expect(narrationSpan(clip, narration, 1)).toEqual({ time: 11, length: 3 });     // a short next scene cuts it
    expect([narrationLost(clip, narration), narrationLost(clip, narration, 5), narrationLost(clip, narration, 1)]).toEqual([2, 0, 1]);
  });

  it('knows where the player is while the next scene is on screen', () => {
    const before = { at: 0, start: 0, end: 3 };
    const next = { at: 3, start: 0.5, end: 5 };                                     // its first half second is cut
    const narration = sceneNarration(project({ at: 1, trimStart: 0.5 }), { ...scene, narration: { ...made, seconds: 4.5 } });
    expect(narrationTailClock(narration, before, next, 0.5)).toBe(2.5);             // 2s were said in its own scene
    expect(narrationTailClock(narration, before, next, 1.5)).toBe(3.5);
    expect(narrationTailClock(narration, before, next, 2.5)).toBeNull();            // all 4s are said
    const fits = sceneNarration(project({ at: 0 }), { ...scene, narration: { ...made, seconds: 2 } });
    expect(narrationTailClock(fits, before, next, 0.5)).toBeNull();
  });

  it('knows where its player should be for a moment of the clip', () => {
    const narration = sceneNarration(project({ at: 2, trimStart: 0.5 }), scene);    // 3.5s left
    expect(narrationClock(narration, 1.9)).toBeNull();
    expect(narrationClock(narration, 2)).toBe(0.5);
    expect(narrationClock(narration, 4)).toBe(2.5);
    expect(narrationClock(narration, 5.5)).toBeNull();
  });

  it('keeps changes within what makes sense', () => {
    const narration = sceneNarration(project({ at: 1, trimEnd: 1 }), scene);
    expect(changeNarration(narration, 'at', 20, 8).at).toBe(7.9);
    expect(changeNarration(narration, 'at', -1, 8).at).toBe(0);
    expect(changeNarration(narration, 'trimStart', 9, 8).trimStart).toBe(2.9);
    expect(changeNarration(narration, 'trimEnd', 0.5, 8)).toEqual({ at: 1, trimStart: 0, trimEnd: 0.5, on: true });
    expect(changeNarration(narration, 'on', false, 8).on).toBe(false);
  });

  it('reads without its pause marks', () => {
    expect(withoutPauses('We broke all three. [pause 1.5] Still paid rent.[PAUSE]')).toBe('We broke all three. Still paid rent.');
  });
});
