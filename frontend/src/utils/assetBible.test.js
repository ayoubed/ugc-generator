import { describe, expect, it } from 'vitest';
import { detailsSource, shouldWriteDetails } from './assetBible';

const FILLED = { character: 'A woman.', hero_props: '', setting: '', voice: '' };
const EMPTY = { character: ' ', hero_props: '', setting: '', voice: '' };

describe('what the consistent details were written from', () => {
  const base = { idea: ' Ad for a watch ', productName: 'Luma', startingImageRef: 'photo.jpg', globalImages: [{ storageRef: 'watch.jpg', description: ' silver ' }] };

  it('is the same for the same idea, name, photo and pictures', () => {
    expect(detailsSource(base)).toBe(detailsSource({ ...base, idea: 'Ad for a watch', globalImages: [{ storageRef: 'watch.jpg', description: 'silver' }, { description: 'no file yet' }] }));
  });

  it('changes when any of them changes', () => {
    const now = detailsSource(base);
    expect(detailsSource({ ...base, startingImageRef: 'other.jpg' })).not.toBe(now);
    expect(detailsSource({ ...base, productName: 'Nova' })).not.toBe(now);
    expect(detailsSource({ ...base, idea: 'Ad for a ring' })).not.toBe(now);
    expect(detailsSource({ ...base, globalImages: [] })).not.toBe(now);
    expect(detailsSource({ ...base, globalImages: [{ storageRef: 'watch.jpg', description: 'gold' }] })).not.toBe(now);
  });

  it('copes with a project that has nothing yet', () => {
    expect(detailsSource()).toBe(JSON.stringify(['', '', '', []]));
  });
});

describe('when the details are written before the script', () => {
  it('writes them when they are empty', () => {
    expect(shouldWriteDetails(EMPTY, '', 'now')).toBe(true);
    expect(shouldWriteDetails(null, 'now', 'now')).toBe(true);
  });

  it('writes them again when the app wrote them from something that changed', () => {
    expect(shouldWriteDetails(FILLED, 'before', 'now')).toBe(true);
  });

  it('keeps them when nothing changed, and always when the user wrote them', () => {
    expect(shouldWriteDetails(FILLED, 'now', 'now')).toBe(false);
    expect(shouldWriteDetails(FILLED, '', 'now')).toBe(false);
    expect(shouldWriteDetails(FILLED, undefined, 'now')).toBe(false);
  });
});
