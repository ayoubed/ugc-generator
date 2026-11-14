import { describe, expect, it } from 'vitest';
import { framesInOrder, hasLookFrame, runInPool, sceneMoment, startFrame, startsOnStoryboard, storyboardCounts, unusedFrame } from './storyboard';

const frame = (id, extra = {}) => ({ id, order: 0, imageRef: `f/${id}.png`, accepted: false, look: false, ...extra });
const withFrames = (...frames) => ({ storyboard: { frames: Object.fromEntries(frames.map((f) => [f.id, f])) } });

describe('storyboard frames', () => {
  it('come back in order, ignoring junk', () => {
    const scene = { storyboard: { frames: { b: frame('b', { order: 1 }), a: frame('a'), junk: null } } };
    expect(framesInOrder(scene).map((f) => f.id)).toEqual(['a', 'b']);
    expect(framesInOrder({})).toEqual([]);
    expect(framesInOrder({ storyboard: { frames: 'x' } })).toEqual([]);
  });

  it('the first accepted frame with a picture starts the scene', () => {
    const scene = withFrames(frame('a'), frame('b', { order: 1, accepted: true }), frame('c', { order: 2, accepted: true }));
    expect(startFrame(scene).id).toBe('b');
    expect(startFrame(withFrames(frame('a', { accepted: true, imageRef: '' })))).toBeNull();
  });

  it('knows when the scene still starts on its frame', () => {
    const scene = withFrames(frame('a', { accepted: true }));
    expect(startsOnStoryboard({ ...scene, customStartImageRef: 'f/a.png' })).toBe(true);
    expect(startsOnStoryboard({ ...scene, customStartImageRef: 'other.png' })).toBe(false);
    expect(startsOnStoryboard({})).toBe(false);
  });

  it('finds a drawn frame that is not accepted yet', () => {
    expect(unusedFrame(withFrames(frame('a'))).id).toBe('a');
    expect(unusedFrame(withFrames(frame('a', { accepted: true })))).toBeNull();
    expect(unusedFrame(withFrames(frame('a', { imageRef: '' })))).toBeNull();
    expect(unusedFrame({})).toBeNull();
  });

  it('describes a frame by the scene itself', () => {
    expect(sceneMoment({ description: ' A hand lifts the watch. ', context: 'Close-up.' })).toBe('A hand lifts the watch. Close-up.');
    expect(sceneMoment({ script: 'Look at this.' })).toBe('Look at this.');
    expect(sceneMoment(null)).toBe('');
  });

  it('counts frames and finds the look of the video', () => {
    const scenes = [withFrames(frame('a', { accepted: true, look: true })), withFrames(frame('b')), {}];
    expect(storyboardCounts(scenes)).toEqual({ total: 3, withFrame: 2, accepted: 1 });
    expect(hasLookFrame(scenes)).toBe(true);
    expect(hasLookFrame([withFrames(frame('b', { look: true }))])).toBe(false);
  });
});

describe('runInPool', () => {
  it('runs every item, a few at a time, and collects failures', async () => {
    let running = 0;
    let most = 0;
    const done = [];
    const failures = await runInPool([1, 2, 3, 4, 5], 2, async (n) => {
      running += 1;
      most = Math.max(most, running);
      await Promise.resolve();
      running -= 1;
      if (n === 3) throw new Error('no');
      done.push(n);
    });
    expect(most).toBe(2);
    expect(done.sort()).toEqual([1, 2, 4, 5]);
    expect(failures.map((f) => f.item)).toEqual([3]);
    expect(await runInPool([], 3, async () => {})).toEqual([]);
  });
});
