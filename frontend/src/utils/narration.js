/**
 * Narration: a scene's voice made from text with the voice service, in place of the sound of its
 * take (see backend/app/routes/narration.py and voiceover.scene_narration).
 *
 *   scene.narration = { text, voiceName, url, seconds, ... }            made by the server
 *   settings.narration.<scene id> = { at, trimStart, trimEnd, on }      set in the editor
 *
 * `at` is where the voice starts, in seconds of the scene's clip. The trims cut the voice's own
 * start and end. A voice longer than what is left of its scene carries on over the next scene;
 * what would run past the end of that one (or of the video) is not heard.
 */
export const NARRATION_MIN_SECONDS = 0.1;
export const PAUSE_HINT = 'Write [pause] or [pause 1.5] where the voice should wait.';

const positive = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);
const round = (value) => Math.round(value * 100) / 100;

/** Where a narration of `seconds` sits, from what was saved (same rules as the server). */
export function narrationPlace(saved, seconds) {
  const place = saved && typeof saved === 'object' ? saved : {};
  const trimStart = Math.min(positive(place.trimStart), Math.max(0, seconds - NARRATION_MIN_SECONDS));
  const trimEnd = Math.max(0, Math.min(positive(place.trimEnd), seconds - NARRATION_MIN_SECONDS - trimStart));
  return { at: round(positive(place.at)), trimStart: round(trimStart), trimEnd: round(trimEnd), on: place.on !== false };
}

/**
 * The scene's narration with where it sits, or null when it has none.
 * `saved`: the placement to use instead of the project's (an edit not saved yet).
 */
export function sceneNarration(project, scene, saved = undefined) {
  const made = scene?.narration;
  const seconds = positive(made?.seconds);
  if (!made?.storageRef || seconds < NARRATION_MIN_SECONDS) return null;
  const place = narrationPlace(saved === undefined ? project?.settings?.narration?.[scene.id] : saved, seconds);
  return {
    text: made.text || '',
    voiceName: made.voiceName || '',
    url: made.url || '',
    seconds,
    ...place,
    length: round(seconds - place.trimStart - place.trimEnd),   // what is left after the trims
  };
}

/**
 * What the stitch records for a narrated scene (same text as the server's key), or '' for a scene
 * that plays its own sound. Two equal keys mean the same voice is heard at the same place.
 */
export function narrationKey(project, scene) {
  const narration = sceneNarration(project, scene);
  if (!narration?.on) return '';
  const fixed = (value) => value.toFixed(2);
  return `narration:${scene.narration.storageRef}:${fixed(narration.at)}:${fixed(narration.trimStart)}:${fixed(narration.trimEnd)}`;
}

/** Whether the scene plays its narration (it has one and it is switched on). */
export function isNarrated(project, scene, saved = undefined) {
  return Boolean(sceneNarration(project, scene, saved)?.on);
}

/**
 * The part of the narration that is heard, on the timeline: { time, length } in timeline seconds,
 * or null when none of it is. clip: { at, start, end }. `room`: the seconds of the next scene it
 * may carry on over (0 for the last scene).
 */
export function narrationSpan(clip, narration, room = 0) {
  const from = Math.max(narration.at, clip.start);
  const to = Math.min(narration.at + narration.length, clip.end + Math.max(0, room));
  if (to - from <= 0.01) return null;
  return { time: clip.at + (from - clip.start), length: to - from };
}

/** How many seconds of the narration are still to be said when its scene ends (0 = it fits the scene). */
export function narrationOverflow(clip, narration) {
  return Math.max(0, round(narration.at + narration.length - clip.end));
}

/** How many seconds are not heard at all: past the end of the next scene, or of the video. */
export function narrationLost(clip, narration, room = 0) {
  return Math.max(0, round(narrationOverflow(clip, narration) - Math.max(0, room)));
}

/**
 * Where the player of the narration BEFORE this scene should be while this scene is at `clipTime`,
 * or null when that narration is over (or never ran past its own scene). before: the clip the
 * narration belongs to; clip: the one on screen. Same rule as the server's narration_tail.
 */
export function narrationTailClock(narration, before, clip, clipTime) {
  const saidBefore = Math.max(0, before.end - narration.at);      // seconds of it heard in its own scene
  const into = saidBefore + (clipTime - clip.start);
  if (clipTime < clip.start || into >= narration.length || narrationOverflow(before, narration) <= 0.05) return null;
  return narration.trimStart + into;
}

/**
 * Where the narration's player should be when the clip is at `clipTime`, or null when the voice is
 * not sounding then (before it starts, or after its kept part).
 */
export function narrationClock(narration, clipTime) {
  const into = clipTime - narration.at;
  if (into < 0 || into >= narration.length) return null;
  return narration.trimStart + into;
}

/** A change to the placement, kept within what makes sense. sceneSeconds: the full length of the clip. */
export function changeNarration(narration, field, value, sceneSeconds) {
  const next = { at: narration.at, trimStart: narration.trimStart, trimEnd: narration.trimEnd, on: narration.on };
  if (field === 'on') next.on = Boolean(value);
  else if (field === 'at') next.at = round(Math.min(positive(value), Math.max(0, sceneSeconds - NARRATION_MIN_SECONDS)));
  else if (field === 'trimStart') {
    next.trimStart = round(Math.min(positive(value), narration.seconds - narration.trimEnd - NARRATION_MIN_SECONDS));
  } else if (field === 'trimEnd') {
    next.trimEnd = round(Math.min(positive(value), narration.seconds - narration.trimStart - NARRATION_MIN_SECONDS));
  }
  return next;
}

/** The text with the [pause] marks taken out: what a caption of it would read. */
export function withoutPauses(text) {
  return (text || '').replace(/\[\s*pause(?:\s+\d+(?:[.,]\d+)?)?\s*s?\s*\]/gi, ' ').split(/\s+/).filter(Boolean).join(' ');
}
