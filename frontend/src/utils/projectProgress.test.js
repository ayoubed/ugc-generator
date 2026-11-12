import { describe, expect, it } from 'vitest';
import {
  allScenesReady,
  continuityNote,
  currentFinalVideo,
  effectiveImageSource,
  finalVideoChangeReason,
  formatElapsed,
  formatSceneList,
  isStitchStuck,
  maxReachableStep,
  previousIncludedScene,
  projectEndCard,
  sceneCaptionText,
  sceneChangesSinceTake,
  sceneLabels,
  sortScenes,
  stepPath,
  STALE_STITCH_MS,
  toMillis,
} from './projectProgress';

const take = (attempt, extra = {}) => ({ attempt, scenePrompt: 'p', imageSource: 'creator', sceneAudio: 'voice_only', ...extra });

describe('scene order and labels', () => {
  const scenes = sortScenes([{ id: '7' }, { id: '5', variantOf: 2 }, { id: '0' }, { id: '2' }]);

  it('orders by spot and letters the alternatives, like the API', () => {
    expect(scenes.map((s) => s.id)).toEqual(['0', '2', '5', '7']);
    expect(sceneLabels(scenes)).toEqual([1, '2A', '2B', 3]);
  });

  it('finds the scene that plays before, ignoring skipped scenes and alternatives', () => {
    const list = [{ id: '0' }, { id: '1', skipped: true }, { id: '2' }, { id: '3', variantOf: 2 }];
    expect(previousIncludedScene(list, 2).scene.id).toBe('0');
    expect(previousIncludedScene(list, 3).scene.id).toBe('0');
    expect(previousIncludedScene(list, 0)).toBeNull();
  });
});

describe('effectiveImageSource', () => {
  it('follows the same rules as the API', () => {
    expect(effectiveImageSource({}, true)).toBe('creator');
    expect(effectiveImageSource({}, false)).toBe('last_frame');
    expect(effectiveImageSource({ customStartImageRef: 'x' }, false)).toBe('uploaded');
    expect(effectiveImageSource({ imageSource: 'extend' }, true)).toBe('creator');
    expect(effectiveImageSource({ imageSource: 'extend' }, false)).toBe('extend');
    expect(effectiveImageSource({ imageSource: 'nonsense' }, false)).toBe('last_frame');
  });
});

describe('sceneChangesSinceTake', () => {
  const scene = { id: '0', prompt: 'p', imageSource: 'creator', history: [take(1)], activeAttempt: 1 };

  it('reports nothing when the take matches the scene', () => {
    expect(sceneChangesSinceTake(scene, true, { settings: {} })).toEqual([]);
  });

  it('notices an edited prompt, a new end picture and a new starting picture', () => {
    const edited = { ...scene, prompt: 'p edited', endImageRef: 'end.png', imageSource: 'uploaded', customStartImageRef: 'c.png' };
    expect(sceneChangesSinceTake(edited, true, null)).toEqual(['prompt', 'end picture', 'starting picture']);
  });

  it('notices video-wide edits only on takes that recorded them', () => {
    const recorded = { ...scene, history: [take(1, { videoContext: 'Kitchen', assetBible: { character: 'Ana' } })] };
    const project = { settings: { videoContext: 'Bedroom', assetBible: { character: 'Bo' } } };
    expect(sceneChangesSinceTake(recorded, true, project)).toEqual(['video context', 'consistent details']);
    expect(sceneChangesSinceTake(scene, true, project)).toEqual([]);
  });

  it('has nothing to say about a scene without a take', () => {
    expect(sceneChangesSinceTake({ id: '0', prompt: 'p' }, true)).toEqual([]);
  });
});

describe('continuityNote', () => {
  it('warns when the previous scene now uses another take', () => {
    const scene = { history: [take(1, { imageSource: 'last_frame', sourceSceneAttempt: 1 })], activeAttempt: 1 };
    expect(continuityNote(scene, { history: [take(1), take(2)], activeAttempt: 2 }, 'scene 1')).toContain('take 1 of scene 1');
    expect(continuityNote(scene, { history: [take(1)], activeAttempt: 1 })).toBe('');
  });
});

describe('final videos', () => {
  const scenes = [
    { id: '0', activeAttempt: 1, script: 'Hi.', storageRef: 'a.mp4' },
    { id: '1', activeAttempt: 2, script: 'Bye.', storageRef: 'b.mp4' },
  ];
  const stitched = { version: 1, storageRef: 'final.mp4', scenes: [{ sceneId: '0', attempt: 1 }, { sceneId: '1', attempt: 2 }] };

  it('is up to date when nothing changed', () => {
    expect(finalVideoChangeReason(stitched, scenes, { settings: {} })).toBe('');
  });

  it('says which scene uses another take', () => {
    const changed = [scenes[0], { ...scenes[1], activeAttempt: 3 }];
    expect(finalVideoChangeReason(stitched, changed)).toBe('Scene 2 uses a different take than this version.');
  });

  it('notices skipped scenes, music, captions and the end card', () => {
    expect(finalVideoChangeReason(stitched, [scenes[0], { ...scenes[1], skipped: true }])).toContain('added, removed, skipped');
    const music = { source: 'upload', storageRef: 'm.mp3', volume: 'low' };
    expect(finalVideoChangeReason(stitched, scenes, { settings: { music } })).toContain('music changed');
    expect(finalVideoChangeReason({ ...stitched, music }, scenes, { settings: { music: { ...music, volume: 'high' } } })).toContain('volume');
    expect(finalVideoChangeReason({ ...stitched, captions: 'pop' }, scenes, { settings: {} })).toContain('caption style');
    const card = { enabled: true, imageRef: 'card.png', headline: 'Buy now' };
    expect(finalVideoChangeReason({ ...stitched, endCard: null }, scenes, { settings: { endCard: card } })).toContain('end card');
    expect(finalVideoChangeReason({ ...stitched, endCard: { imageRef: 'card.png', headline: 'Buy now' } }, scenes, { settings: { endCard: card } })).toBe('');
  });

  it('does not flag versions stitched before a feature existed', () => {
    const card = { enabled: true, imageRef: 'card.png' };
    expect(finalVideoChangeReason(stitched, scenes, { settings: { endCard: card, captions: { style: 'pop' } } })).toBe('');
  });

  it('points at the newest version, or the one the project names', () => {
    const project = { finalVideos: [{ version: 1, storageRef: 'a' }, { version: 2, storageRef: 'b' }], finalVideoVersion: 1 };
    expect(currentFinalVideo(project).version).toBe(1);
    expect(currentFinalVideo({ ...project, finalVideoVersion: null }).version).toBe(2);
    expect(currentFinalVideo({ finalVideoUrl: 'https://old' }).legacy).toBe(true);
    expect(currentFinalVideo({})).toBeNull();
  });
});

describe('journey', () => {
  it('opens later steps as the project gets there', () => {
    expect(maxReachableStep({ status: 'draft' }, [])).toBe(1);
    expect(maxReachableStep({ status: 'scripted' }, [{ id: '0' }])).toBe(4);
    expect(maxReachableStep({ finalVideos: [{ version: 1, storageRef: 'f' }] }, [{ id: '0' }])).toBe(4);
    expect(stepPath('p1', 4)).toBe('/project/p1/video');
  });

  it('is ready to stitch only when every scene in the video has a finished take', () => {
    expect(allScenesReady([{ storageRef: 'a' }, { skipped: true }])).toBe(true);
    expect(allScenesReady([{ storageRef: 'a' }, {}])).toBe(false);
    expect(allScenesReady([{ storageRef: 'a', videoStatus: 'generating' }])).toBe(false);
    expect(allScenesReady([{ skipped: true }])).toBe(false);
  });

  it('treats a stitch that started long ago as stuck', () => {
    const now = 1_000_000_000_000;
    expect(isStitchStuck({ status: 'stitching', stitchStartedAt: now - 60_000 }, now)).toBe(false);
    expect(isStitchStuck({ status: 'stitching', stitchStartedAt: now - STALE_STITCH_MS - 1 }, now)).toBe(true);
    expect(isStitchStuck({ status: 'scripted' }, now)).toBe(false);
  });
});

describe('small helpers', () => {
  it('reads the end card with defaults', () => {
    expect(projectEndCard({})).toEqual({ enabled: false, imageRef: '', imageUrl: '', headline: '', subline: '', seconds: 2.5 });
    expect(projectEndCard({ settings: { endCard: { enabled: true, headline: ' Hi ', seconds: 4 } } }).headline).toBe('Hi');
  });

  it('uses the typed caption text over the script, including an empty one', () => {
    const project = { settings: { captions: { texts: { 0: '' } } } };
    expect(sceneCaptionText(project, { id: '0', script: 'Hi.' })).toBe('');
    expect(sceneCaptionText(project, { id: '1', script: 'Bye.' })).toBe('Bye.');
  });

  it('formats lists, durations and timestamps', () => {
    expect(formatSceneList([2])).toBe('Scene 2');
    expect(formatSceneList([1, 2, 4])).toBe('Scenes 1, 2 and 4');
    expect(formatElapsed(75.9)).toBe('1:15');
    expect(toMillis({ toMillis: () => 5 })).toBe(5);
    expect(toMillis('not a date')).toBeNull();
  });
});
