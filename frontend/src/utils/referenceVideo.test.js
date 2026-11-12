import { describe, expect, it } from 'vitest';
import { formSettingsFromBreakdown, structureForScript, typicalSceneSeconds } from './referenceVideo';

const part = (start, end, extra = {}) => ({ start, end, purpose: 'Hook', happens: 'She frowns', framing: 'Close-up', said: 'their words', ...extra });

const breakdown = {
  hook: ' Open with a question. ',
  scenes: [part(0, 8), part(8, 10), part(10, 16)],
  pacing: 'Quick cuts',
  call_to_action: 'Asks to buy',
  wordsPerSecond: 3.6,
  style: { camera: ['Phone front camera', ' '], script_tone: ['Friendly'], lighting: [] },
};

describe('formSettingsFromBreakdown', () => {
  it('fills in scene count, hook, scene length, words and style from the video', () => {
    expect(formSettingsFromBreakdown(breakdown, { durationOptions: [5, 6, 7, 8], currentDuration: 8 })).toEqual({
      numScenes: 3,
      hook: 'Open with a question.',
      duration: 6,                       // the typical part is 6 seconds long
      wordsPerScene: 18,                 // their pace (3.6 words a second) is capped at 3
      tags: { camera: ['Phone front camera'], scriptTone: ['Friendly'] },
    });
  });

  it('uses a normal speaking pace when nobody speaks in the video', () => {
    const silent = { ...breakdown, wordsPerSecond: 0 };
    expect(formSettingsFromBreakdown(silent, { durationOptions: [8], currentDuration: 8 }).wordsPerScene).toBe(20);
  });

  it('never asks for more scenes than a video can have', () => {
    const long = { ...breakdown, scenes: Array.from({ length: 14 }, (_, n) => part(n * 5, n * 5 + 5)) };
    expect(formSettingsFromBreakdown(long, { durationOptions: [5], currentDuration: 5 }).numScenes).toBe(10);
  });

  it('returns nothing without a usable breakdown', () => {
    expect(formSettingsFromBreakdown(null, { durationOptions: [5], currentDuration: 5 })).toBeNull();
    expect(formSettingsFromBreakdown({ scenes: [] }, { durationOptions: [5], currentDuration: 5 })).toBeNull();
  });
});

describe('typicalSceneSeconds', () => {
  it('picks the closest length the model offers', () => {
    expect(typicalSceneSeconds([part(0, 2), part(2, 4), part(4, 7)], [5, 6, 7, 8], 8)).toBe(5);
    expect(typicalSceneSeconds([part(0, 12)], [5, 6, 7, 8], 5)).toBe(8);
  });

  it('keeps the current length when the parts have no timing', () => {
    expect(typicalSceneSeconds([{ purpose: 'Hook' }], [5, 6, 7, 8], 7)).toBe(7);
  });
});

describe('structureForScript', () => {
  it('sends the structure without the reference’s words', () => {
    const structure = structureForScript(breakdown);
    expect(structure.scenes).toHaveLength(3);
    expect(structure.scenes[0]).toEqual({ purpose: 'Hook', happens: 'She frowns', framing: 'Close-up' });
    expect(JSON.stringify(structure)).not.toContain('their words');
    expect(structure.pacing).toBe('Quick cuts');
    expect(structure.call_to_action).toBe('Asks to buy');
  });

  it('is null when there is nothing to follow', () => {
    expect(structureForScript({ scenes: [] })).toBeNull();
    expect(structureForScript(undefined)).toBeNull();
  });
});
