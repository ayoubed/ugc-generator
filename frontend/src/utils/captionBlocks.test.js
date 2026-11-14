import { describe, expect, it } from 'vitest';
import {
  blockSpan, blocksOfScene, blocksSignature, changeBlock, isCaptionedByHand, projectCaptionBlocks, splitCaption, storedBlock,
} from './captionBlocks';

const project = (blocks, manual = { 0: true }) => ({ settings: { captions: { manual, blocks } } });
const block = (extra = {}) => ({ sceneId: '0', at: 1, length: 1.5, text: 'Hello there', ...extra });

describe('captions placed by hand', () => {
  it('reads what is saved, ignoring junk', () => {
    const found = projectCaptionBlocks(project({ b: block({ at: 3 }), a: block({ sceneId: 0 }), junk: 'x', loose: { text: 'no scene' } }));
    expect(found.map((b) => b.id).sort()).toEqual(['a', 'b']);
    expect(found.find((b) => b.id === 'a').sceneId).toBe('0');
    expect(projectCaptionBlocks({})).toEqual([]);
  });

  it('knows which scenes are placed by hand, and their captions in order', () => {
    const p = project({ b: block({ at: 3 }), a: block(), other: block({ sceneId: '1' }) });
    expect(isCaptionedByHand(p, '0')).toBe(true);
    expect(isCaptionedByHand(p, '1')).toBe(false);
    expect(blocksOfScene(projectCaptionBlocks(p), '0').map((b) => b.id)).toEqual(['a', 'b']);
  });

  it('cuts a caption text into short captions that fill the time', () => {
    const blocks = splitCaption('This watch looks far more expensive than it is. Really.', 1, 5);
    expect(blocks.map((b) => b.text)).toEqual(['This watch looks far', 'more expensive than it', 'is.', 'Really.']);
    expect(blocks[0].at).toBe(1);
    const last = blocks[blocks.length - 1];
    expect(last.at + last.length).toBeCloseTo(5, 1);
    blocks.slice(1).forEach((b, i) => expect(b.at).toBeCloseTo(blocks[i].at + blocks[i].length, 1));
    expect(blocks[0].length).toBeGreaterThan(blocks[2].length);          // more letters, more time
  });

  it('makes nothing from an empty text or no room', () => {
    expect(splitCaption('  ', 0, 5)).toEqual([]);
    expect(splitCaption('Hello', 2, 2.1)).toEqual([]);
    expect(splitCaption('one two three four five six seven eight nine', 0, 0.5).map((b) => b.text))
      .toEqual(['one two three four', 'five six seven eight nine']);     // too short for three: the rest is kept together
  });

  it('is drawn where it is seen, and not at all when its part of the clip is cut', () => {
    const clip = { at: 10, start: 1, end: 4 };
    expect(blockSpan(clip, block({ at: 2, length: 1 }))).toEqual({ time: 11, length: 1 });
    expect(blockSpan(clip, block({ at: 0.5, length: 1 }))).toEqual({ time: 10, length: 0.5 });
    expect(blockSpan(clip, block({ at: 3.5, length: 2 }))).toEqual({ time: 12.5, length: 0.5 });
    expect(blockSpan(clip, block({ at: 5 }))).toBeNull();
  });

  it('stays inside its scene when moved or trimmed', () => {
    const b = block({ at: 1, length: 2 });
    expect(changeBlock(b, 'at', 4.5, 5)).toMatchObject({ at: 4.5, length: 0.5 });
    expect(changeBlock(b, 'at', -1, 5).at).toBe(0);
    expect(changeBlock(b, 'at', 99, 5).at).toBe(4.8);
    expect(changeBlock(b, 'length', 99, 5).length).toBe(4);
    expect(changeBlock(b, 'length', 0, 5).length).toBe(0.2);
    expect(changeBlock(b, 'text', 'New words', 5).text).toBe('New words');
  });

  it('saves a caption without its id, and signs a scene like the server does', () => {
    expect(storedBlock({ id: 'a', ...block() })).toEqual(block());
    const blocks = [{ ...block({ at: 2.5, text: ' second  one ' }) }, { ...block({ at: 0.5, length: 1.25 }) }, block({ text: ' ' })];
    expect(blocksSignature(blocks)).toBe('0.50:1.25:Hello there|2.50:1.50:second one');
    expect(blocksSignature([])).toBe('');
  });
});
