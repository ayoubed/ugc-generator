import { describe, expect, it } from 'vitest';
import { takeContextPictureCount, usedCreatorPhoto } from './takePictures';

describe('pictures a take was made with', () => {
  const take = { referenceImages: [{ scope: 'creator' }, { scope: 'global' }, { scope: 'scene' }] };

  it('counts only the pictures the user added', () => {
    expect(takeContextPictureCount(take)).toBe(2);
    expect(takeContextPictureCount({ referenceImages: [{ scope: 'creator' }] })).toBe(0);
  });

  it('says when the creator photo was sent along', () => {
    expect(usedCreatorPhoto(take)).toBe(true);
    expect(usedCreatorPhoto({ referenceImages: [{ scope: 'global' }] })).toBe(false);
  });

  it('copes with takes made before pictures were recorded', () => {
    expect(takeContextPictureCount({})).toBe(0);
    expect(usedCreatorPhoto(null)).toBe(false);
  });
});
