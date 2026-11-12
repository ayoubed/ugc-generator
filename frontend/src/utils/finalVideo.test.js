import { describe, expect, it } from 'vitest';
import { downloadName, notReadyReason, versionKey, versionName } from './finalVideo';

describe('final video versions', () => {
  it('names and keys versions, including videos made before versioning', () => {
    expect(versionKey({ version: 3 })).toBe('v3');
    expect(versionKey({ storageRef: 'old.mp4' })).toBe('legacy');
    expect(versionKey(null)).toBe('');
    expect(versionName({ version: 3 })).toBe('Version 3');
    expect(versionName({})).toBe('Final video');
  });

  it('builds a safe download name from the title', () => {
    expect(downloadName({ title: 'Été: GLOWLEAF Serum!!' }, { version: 2 })).toBe('ete-glowleaf-serum-v2.mp4');
    expect(downloadName({ idea: 'A mug' }, {})).toBe('a-mug.mp4');
    expect(downloadName({}, { version: 1 })).toBe('video-v1.mp4');
  });
});

describe('notReadyReason', () => {
  it('says which scenes are missing or still generating, ignoring skipped ones', () => {
    const scenes = [
      { id: '0', storageRef: 'a.mp4' },
      { id: '1', videoStatus: 'generating' },
      { id: '2' },
      { id: '3', skipped: true },
    ];
    expect(notReadyReason(scenes)).toBe('Scene 2 is still generating and Scene 3 needs a video');
    expect(notReadyReason([{ id: '0', storageRef: 'a.mp4' }])).toBe('');
  });
});
