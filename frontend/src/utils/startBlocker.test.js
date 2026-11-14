import { describe, expect, it } from 'vitest';
import { startBlocker } from './startBlocker';

const scene = { prompt: 'The watch on a wrist.', videoStatus: 'completed' };
const ask = (project) => startBlocker({ scene, source: 'creator', project, now: Date.now(), pickerBusy: false, pictureLimit: 6 });

describe('startBlocker, starting from the photo of Step 1', () => {
  it('lets a video with a creator photo start', () => {
    expect(ask({ startingImageRef: 'users/u/creator.png' })).toBe('');
  });

  it('asks for a creator photo when a presenter video has none', () => {
    expect(ask({ startingImageRef: '' })).toMatch(/no creator photo/i);
  });

  it('lets a product-led video start from its product picture, with no creator photo', () => {
    const project = {
      startingImageRef: '',
      settings: { videoType: 'product' },
      globalImages: [{ storageRef: 'users/u/watch.png' }],
    };
    expect(ask(project)).toBe('');
  });

  it('asks for a product picture when a product-led video has none', () => {
    const project = { startingImageRef: 'users/u/creator.png', settings: { videoType: 'product' }, globalImages: [] };
    expect(ask(project)).toMatch(/no product picture/i);
  });
});
