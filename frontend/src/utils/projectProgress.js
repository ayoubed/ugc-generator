import { currentEdits, sameEdits } from './edits';
// Shared helpers that describe where a project is in the journey (scenes, takes, final videos).
import { projectSceneAudio } from '../data/guidelineTags';
import { sameAssetBible } from './assetBible';

export const ACTIVE_VIDEO_STATUSES = ['queued', 'generating'];

/** Starting choices that need the previous scene's video. */
export const FROM_PREVIOUS_SOURCES = ['last_frame', 'ai_cut', 'extend'];

export function sceneStatus(scene) {
  return (scene?.videoStatus || 'pending').toLowerCase();
}

export function isSceneBusy(scene) {
  return ACTIVE_VIDEO_STATUSES.includes(sceneStatus(scene));
}

/** Same limit the API uses before it lets a stuck take be started again. */
export const STALE_JOB_MS = 15 * 60 * 1000;

/** The scene is queued or generating, and has not been stuck for too long. */
export function isBusyAndFresh(scene, now) {
  if (!isSceneBusy(scene)) return false;
  // A running take refreshes heartbeatAt about once a minute; updatedAt marks when it started.
  const since = Math.max(toMillis(scene?.heartbeatAt) || 0, toMillis(scene?.updatedAt) || 0);
  return Boolean(since) && now - since < STALE_JOB_MS;
}

/** A scene "has a video" once any take finished, even while a new take is being made. */
export function sceneHasVideo(scene) {
  return Boolean(scene?.storageRef || scene?.videoUrl);
}

/** Switched off on the Generate page: left out of the final video, keeps its script and takes. */
export function isSceneSkipped(scene) {
  return Boolean(scene?.skipped);
}

/** The scenes that end up in the final video, in order. */
export function includedScenes(scenes) {
  return (scenes || []).filter((s) => !isSceneSkipped(s));
}

/**
 * The spot a scene takes in the video. Scenes are numbered by their id, except alternatives
 * (a scene group): an alternative has variantOf = the id of the scene it stands in for and sits
 * in that scene's spot. Only one scene of a group is in the video; the others are skipped.
 */
export function sceneSlot(scene) {
  const own = Number.parseInt(scene?.id, 10);
  const slot = Number.parseInt(scene?.variantOf ?? scene?.id, 10);
  if (Number.isFinite(slot)) return slot;
  return Number.isFinite(own) ? own : 0;
}

/** Scenes in video order: by spot, alternatives of one spot in the order they were added. */
export function sortScenes(scenes) {
  const own = (s) => Number.parseInt(s.id, 10) || 0;
  return (scenes || []).slice().sort((a, b) => sceneSlot(a) - sceneSlot(b) || own(a) - own(b));
}

/** The other scenes that share a scene's spot (its alternatives), in order. */
export function sceneAlternatives(scenes, scene) {
  const slot = sceneSlot(scene);
  return (scenes || []).filter((s) => s.id !== scene?.id && sceneSlot(s) === slot);
}

/**
 * What each scene is called, by position in `scenes` (already in video order): 1, 2, 3, or
 * "2A", "2B" for the alternatives of one spot. Same labels as the API uses.
 */
export function sceneLabels(scenes) {
  const list = scenes || [];
  const slots = [...new Set(list.map(sceneSlot))];
  const size = new Map();
  list.forEach((s) => size.set(sceneSlot(s), (size.get(sceneSlot(s)) || 0) + 1));
  const seen = new Map();
  return list.map((s) => {
    const slot = sceneSlot(s);
    const number = slots.indexOf(slot) + 1;
    if (size.get(slot) < 2) return number;
    const nth = seen.get(slot) || 0;
    seen.set(slot, nth + 1);
    return `${number}${String.fromCharCode(65 + Math.min(nth, 25))}`;
  });
}

/**
 * The scene that plays right before scenes[idx] in the final video (skipped scenes don't count),
 * as { scene, number } with number 1-based in the full list, or null. Same rule as the API.
 */
export function previousIncludedScene(scenes, idx) {
  // Alternatives of the same spot never count as "previous": only one of them is in the video.
  const slot = sceneSlot(scenes[idx]);
  for (let i = idx - 1; i >= 0; i -= 1) {
    if (scenes[i] && !isSceneSkipped(scenes[i]) && sceneSlot(scenes[i]) !== slot) {
      return { scene: scenes[i], number: sceneLabels(scenes)[i] };
    }
  }
  return null;
}

/** Takes sorted oldest first. */
export function sceneTakes(scene) {
  return (scene?.history || [])
    .filter((h) => h && typeof h === 'object' && h.attempt)
    .slice()
    .sort((a, b) => a.attempt - b.attempt);
}

export function activeTakeNumber(scene) {
  if (scene?.activeAttempt) return scene.activeAttempt;
  const takes = sceneTakes(scene);
  return takes.length ? takes[takes.length - 1].attempt : null;
}

/** The take the scene currently uses (for stitching, the next scene's first frame and refinements). */
export function activeTake(scene) {
  const number = activeTakeNumber(scene);
  if (!number) return null;
  return sceneTakes(scene).find((t) => t.attempt === number) || null;
}

/** The automatic check of a take ({ ok, spokenText, speechMatch, issues }), or null when it has none (yet). */
export function takeCheck(scene, attempt) {
  const check = attempt != null ? scene?.takeChecks?.[attempt] : null;
  return check && typeof check === 'object' ? check : null;
}

/** Whether a take can be refined (only Gemini Omni takes keep the conversation needed for edits). */
export function canRefineTake(take) {
  return Boolean(take?.interactionId);
}

function sameSpacing(a, b) {
  return (a || '').replace(/\s+/g, ' ').trim() === (b || '').replace(/\s+/g, ' ').trim();
}

/**
 * What changed in a scene since its current take was made.
 * Returns a list such as ['prompt', 'starting picture'] (empty when nothing we can detect changed).
 * Pass the project to also catch edits to the video-wide context.
 */
export function sceneChangesSinceTake(scene, isFirst, project = null) {
  const take = activeTake(scene);
  if (!take) return [];
  const changes = [];
  // A context edit flows into the prompt, so it's caught here too.
  if (typeof take.scenePrompt === 'string' && !sameSpacing(take.scenePrompt, scene?.prompt)) {
    changes.push('prompt');
  }
  // Takes made before the video context was recorded don't have the field, so they aren't flagged.
  if (project && typeof take.videoContext === 'string' && !sameSpacing(take.videoContext, project.settings?.videoContext)) {
    changes.push('video context');
  }
  // Same for the consistent details: only takes that recorded them can be compared.
  if (project && take.assetBible && typeof take.assetBible === 'object' && !sameAssetBible(take.assetBible, project.settings?.assetBible)) {
    changes.push('consistent details');
  }
  // Takes made before the scene audio setting existed let the video model pick the audio (often music).
  if (project && (take.sceneAudio || 'model') !== projectSceneAudio(project.settings)) {
    changes.push('audio setting');
  }
  const source = effectiveImageSource(scene, isFirst);
  // Takes made before end pictures existed have no endImageRef: treated as "none".
  if ((take.endImageRef || '') !== (scene?.endImageRef || '') && !take.extended && source !== 'extend') {
    changes.push('end picture');
  }
  if (take.imageSource && take.imageSource !== source) {
    changes.push('starting picture');
  } else if (
    source === 'uploaded'
    && scene?.customStartImageRef
    && take.startingImageRef
    && take.startingImageRef !== scene.customStartImageRef
  ) {
    changes.push('starting picture');
  }
  return changes;
}

/**
 * The scenes (ids, in video order) a run should make a new take of although they have a video.
 * mode 'changed': the scenes edited since their take (script, details, pictures...), plus every
 * scene that continues from one that is about to get a new take, so the cuts still match.
 * mode 'all': every scene in the video that has a video.
 */
export function scenesToRemake(scenes, project = null, mode = 'changed') {
  const list = scenes || [];
  const replaced = new Set(); // scenes whose take in use will be a new one after the run
  const remake = [];
  list.forEach((scene, idx) => {
    if (isSceneSkipped(scene)) return;
    const previous = previousIncludedScene(list, idx);
    const isFirst = !previous;
    if (!sceneHasVideo(scene)) {
      replaced.add(scene.id); // the run makes it anyway
      return;
    }
    const follows = FROM_PREVIOUS_SOURCES.includes(effectiveImageSource(scene, isFirst)) && replaced.has(previous?.scene?.id);
    if (mode === 'all' || follows || sceneChangesSinceTake(scene, isFirst, project).length > 0) {
      remake.push(scene.id);
      replaced.add(scene.id);
    }
  });
  return remake;
}

/**
 * When the current take continued from a take of the previous scene that is no longer the one in use,
 * the cut between the two scenes may not match. Returns a short explanation, or ''.
 */
export function continuityNote(scene, prevScene, prevLabel = 'the previous scene') {
  const take = activeTake(scene);
  if (!take || !prevScene || !FROM_PREVIOUS_SOURCES.includes(take.imageSource)) return '';
  const prevNumber = activeTakeNumber(prevScene);
  if (take.sourceSceneAttempt == null || prevNumber == null || take.sourceSceneAttempt === prevNumber) return '';
  return `This take continues from take ${take.sourceSceneAttempt} of ${prevLabel}, which now uses take ${prevNumber}, so the cut between them may not match. Make a new take if it looks off.`;
}

/** Context pictures a scene sends to the video model: video-wide + scene-specific. */
export function contextPictureCount(project, scene) {
  const count = (list) => (list || []).filter((img) => img && img.storageRef).length;
  return count(project?.globalImages) + count(scene?.sceneImages);
}

export const IMAGE_SOURCES = ['creator', 'last_frame', 'extend', 'ai_cut', 'uploaded'];

export const IMAGE_SOURCE_LABELS = {
  creator: 'Creator photo',
  last_frame: 'Last frame of previous scene',
  ai_cut: 'Camera cut',
  extend: 'Same shot, continued',
  uploaded: 'Custom picture',
};

/**
 * The starting picture a scene will actually use.
 * The first scene has no previous scene, so it can only start from the creator photo or a custom picture.
 */
export function effectiveImageSource(scene, isFirst) {
  const source = scene?.imageSource;
  const fallback = scene?.customStartImageRef ? 'uploaded' : isFirst ? 'creator' : 'last_frame';
  if (!IMAGE_SOURCES.includes(source)) return fallback;
  if (isFirst && FROM_PREVIOUS_SOURCES.includes(source)) {
    return scene?.customStartImageRef ? 'uploaded' : 'creator';
  }
  return source;
}

export function defaultImageSource(isFirst) {
  return isFirst ? 'creator' : 'last_frame';
}

/** All final videos, newest first. Projects stitched before versioning have one unnumbered video. */
export function finalVideoVersions(project) {
  const versions = (project?.finalVideos || [])
    .filter((v) => v && (v.storageRef || v.videoUrl))
    .slice()
    .sort((a, b) => (b.version || 0) - (a.version || 0));
  if (!versions.length && (project?.finalVideoRef || project?.finalVideoUrl)) {
    return [{
      version: null,
      storageRef: project.finalVideoRef || '',
      videoUrl: project.finalVideoUrl || '',
      scenes: [],
      legacy: true,
    }];
  }
  return versions;
}

export function hasFinalVideo(project) {
  return finalVideoVersions(project).length > 0;
}

/** The final video the project currently points at (the newest successful stitch). */
export function currentFinalVideo(project) {
  const versions = finalVideoVersions(project);
  if (!versions.length) return null;
  return versions.find((v) => v.version && v.version === project?.finalVideoVersion) || versions[0];
}

/** Same limit the API uses before it lets a stuck stitch be started again. */
export const STALE_STITCH_MS = 10 * 60 * 1000;

/** When the current stitch started (millis, or null). updatedAt is the fallback for older projects. */
export function stitchStartedMillis(project) {
  return toMillis(project?.stitchStartedAt) || toMillis(project?.updatedAt);
}

/** The project says it is stitching, but it started too long ago (e.g. the server restarted). */
export function isStitchStuck(project, now = Date.now()) {
  if (project?.status !== 'stitching') return false;
  const since = stitchStartedMillis(project);
  return !since || now - since > STALE_STITCH_MS;
}

export function isStitching(project, now = Date.now()) {
  return project?.status === 'stitching' && !isStitchStuck(project, now);
}

/**
 * The music track chosen for the final video ({source, storageRef, url, name, volume, ...}), or null.
 */
export function projectMusic(project) {
  const music = project?.settings?.music;
  if (!music || music.source === 'none' || !music.storageRef) return null;
  // A number from the volume slider (0 to 100), or low / medium / high from before it existed.
  const numeric = typeof music.volume === 'number' && music.volume >= 0 && music.volume <= 100;
  return { ...music, volume: numeric || MUSIC_VOLUME_OPTIONS.some((o) => o.value === music.volume) ? music.volume : 'medium' };
}

/** The one voice chosen for the whole video ({id, name}), or null when each scene keeps its own. */
export function projectVoice(project) {
  const voice = project?.settings?.voice;
  if (!voice || typeof voice !== 'object' || !String(voice.id || '').trim()) return null;
  return { id: String(voice.id).trim(), name: String(voice.name || '').trim() };
}

/** Caption styles (same keys as backend/app/captions.py). Unset on a project means the default style. */
export const CAPTION_OPTIONS = [
  { value: 'highlight', title: 'Word highlight', sub: 'A few words at a time, the spoken word lights up.' },
  { value: 'pop', title: 'Bold pop', sub: 'One or two big uppercase words that pop in.' },
  { value: 'minimal', title: 'Minimal', sub: 'A quiet line of text on a soft dark bar.' },
  { value: 'none', title: 'No captions', sub: 'The video is stitched without text.' },
];

export function projectCaptionStyle(project) {
  const value = project?.settings?.captions?.style;
  return CAPTION_OPTIONS.some((o) => o.value === value) ? value : 'highlight';
}

/**
 * The caption text of a scene: what the user typed on the Video step, otherwise the script.
 * An empty text means "no caption on this scene".
 */
export function sceneCaptionText(project, scene) {
  const texts = project?.settings?.captions?.texts;
  const own = texts && typeof texts === 'object' ? texts[scene?.id] : undefined;
  return typeof own === 'string' ? own : scene?.script || '';
}

/** Whether the user replaced the script with their own caption text for this scene. */
export function hasOwnCaptionText(project, scene) {
  const texts = project?.settings?.captions?.texts;
  return Boolean(texts && typeof texts === 'object' && typeof texts[scene?.id] === 'string');
}

/** Tightened cuts are on unless switched off. */
export function projectTightCuts(project) {
  return project?.settings?.tightCuts !== false;
}

export const MUSIC_VOLUME_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

/**
 * Compares a final video with the scenes (and music) as they are now.
 * Returns '' when it is up to date (or unknown, for videos stitched before versioning),
 * otherwise a short reason. Pass the project to also catch music changes.
 */
export const END_CARD_DEFAULT_SECONDS = 2.5;
export const END_CARD_SECONDS = [2, 2.5, 3, 4];

/** The closing card added after the last scene when stitching (settings.endCard), with defaults filled in. */
export function projectEndCard(project) {
  const card = project?.settings?.endCard;
  const c = card && typeof card === 'object' ? card : {};
  return {
    enabled: Boolean(c.enabled),
    imageRef: c.imageRef || '',
    imageUrl: c.imageUrl || '',
    headline: (c.headline || '').trim(),
    subline: (c.subline || '').trim(),
    seconds: typeof c.seconds === 'number' ? c.seconds : END_CARD_DEFAULT_SECONDS,
  };
}

export function finalVideoChangeReason(finalVideo, scenes, project = null) {
  const used = finalVideo?.scenes;
  if (!used || !used.length || !scenes) return '';

  // Scene numbers as the user sees them (position in the full list, skipped scenes included).
  const labels = sceneLabels(scenes);
  const current = scenes
    .map((s, i) => ({ sceneId: s.id, attempt: s.activeAttempt ?? null, number: labels[i], skipped: isSceneSkipped(s) }))
    .filter((c) => !c.skipped);
  if (current.length !== used.length || current.some((c, i) => c.sceneId !== used[i].sceneId)) {
    return 'Scenes were added, removed, skipped or swapped for an alternative since this version was stitched.';
  }
  const changed = current
    .filter((c, i) => (c.attempt ?? null) !== (used[i].attempt ?? null))
    .map((c) => c.number);
  if (changed.length) {
    const list = changed.length === 1 ? `Scene ${changed[0]} uses` : `Scenes ${changed.join(', ')} use`;
    return `${list} a different take than this version.`;
  }

  if (project) {
    const usedMusic = finalVideo.music || null;
    const music = projectMusic(project);
    if ((usedMusic?.storageRef || null) !== (music?.storageRef || null)) {
      return music ? 'The music changed since this version was stitched.' : 'The music was removed since this version was stitched.';
    }
    if (music && usedMusic && usedMusic.volume !== music.volume) {
      return 'The music volume changed since this version was stitched.';
    }
    // Versions stitched before captions existed don't record them, so they aren't flagged.
    if (typeof finalVideo.captions === 'string' && finalVideo.captions !== projectCaptionStyle(project)) {
      return 'The caption style changed since this version was stitched.';
    }
    if (finalVideo.captionTexts && typeof finalVideo.captionTexts === 'object' && projectCaptionStyle(project) !== 'none') {
      const squash = (t) => (t || '').replace(/\s+/g, ' ').trim();
      const edited = scenes.some((s) => !isSceneSkipped(s)
        && s.id in finalVideo.captionTexts
        && squash(finalVideo.captionTexts[s.id]) !== squash(sceneCaptionText(project, s)));
      if (edited) return 'The caption text changed since this version was stitched.';
    }
    // Versions stitched before end cards existed have no endCard field at all, so they aren't flagged.
    if ('endCard' in finalVideo) {
      const card = projectEndCard(project);
      const now = card.enabled && card.imageRef
        ? [card.imageRef, card.headline, card.subline, card.seconds].join('|')
        : '';
      const then = finalVideo.endCard
        ? [finalVideo.endCard.imageRef, finalVideo.endCard.headline || '', finalVideo.endCard.subline || '',
            finalVideo.endCard.seconds || END_CARD_DEFAULT_SECONDS].join('|')
        : '';
      if (now !== then) return 'The end card changed since this version was stitched.';
    }
    // Same for the editor: only versions that recorded their edits can be compared.
    if ('edits' in finalVideo && !sameEdits(finalVideo.edits, currentEdits(project, scenes))) {
      return 'The edit (kept parts or volumes) changed since this version was stitched.';
    }
    // Versions stitched before the voice choice existed have no voice field, so they aren't flagged.
    if ('voice' in finalVideo && (finalVideo.voice?.id || '') !== (projectVoice(project)?.id || '')) {
      return 'The voice changed since this version was stitched.';
    }
    if (typeof finalVideo.tightCuts === 'boolean' && finalVideo.tightCuts !== projectTightCuts(project)) {
      return 'The cut setting changed since this version was stitched.';
    }
  }
  return '';
}

/** Ready to stitch: has a video (the take in use) and is not making a new take. Same rule as the API. */
export function sceneReadyToStitch(scene) {
  return sceneHasVideo(scene) && !isSceneBusy(scene);
}

/** Counts only the scenes that are in the video. */
export function scenesReadyCount(scenes) {
  return includedScenes(scenes).filter(sceneReadyToStitch).length;
}

/** Every scene in the video is ready (and at least one scene is in the video). */
export function allScenesReady(scenes) {
  const included = includedScenes(scenes);
  return included.length > 0 && included.every(sceneReadyToStitch);
}

/** [2] -> "Scene 2", [1, 2, 4] -> "Scenes 1, 2 and 4". */
export function formatSceneList(numbers) {
  if (numbers.length === 1) return `Scene ${numbers[0]}`;
  return `Scenes ${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`;
}

/**
 * Highest step the user can jump to from the stepper.
 * Steps: 1 Idea, 2 Script, 3 Generate, 4 Video (captions, cuts, music, stitch, watch, download).
 */
export const STEP = { IDEA: 1, SCRIPT: 2, GENERATE: 3, VIDEO: 4 };

export function maxReachableStep(project, scenes) {
  if (hasFinalVideo(project) || isStitching(project)) return STEP.VIDEO;
  if (scenes ? scenes.length > 0 : ['scripted', 'generating', 'completed', 'failed'].includes(project?.status)) return STEP.VIDEO;
  return 1;
}

const STEP_ROUTES = { 1: 'create', 2: 'scenes', 3: 'generate', 4: 'video' };

/** Route of a stepper step for a project. */
export function stepPath(projectId, step) {
  return `/project/${projectId}/${STEP_ROUTES[step] || 'create'}`;
}

export function formatElapsed(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Firestore Timestamp | Date | ISO string | millis -> millis (or null). */
export function toMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function formatDateTime(value) {
  const ms = toMillis(value);
  if (!ms) return '';
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
