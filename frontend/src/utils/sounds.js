/**
 * Sound effects in the editor on the Video step. Each is saved as settings.sounds.<id> =
 * { id, name, prompt, storageRef, url, seconds, sceneId, at, volume } and mixed in by the server
 * when it stitches (backend: jobs.project_sounds, pipeline.place_sounds).
 *
 * A sound is pinned to a moment of a scene's clip (`at`, seconds in that clip's file), not to a
 * moment of the video: it stays on the same frame when scenes before it are trimmed. A sound on
 * the end card has sceneId 'end' and `at` counted from the card's start.
 */
import { PREVIEW_UNITY } from './edits';

export const SOUND_END = 'end';
export const SOUND_DEFAULT_VOLUME = 60;   // percent; same default as the server
export const MAX_SOUNDS = 30;             // same limit as the server
export const SOUND_MIN_SECONDS = 0.5;
export const SOUND_MAX_SECONDS = 10;
const START_SLACK = 0.01;                // seconds; same as the server

/** Starting points for the description, so nobody faces an empty field. */
export const SOUND_IDEAS = [
  { label: 'Whoosh', prompt: 'Short soft whoosh, like a quick swipe transition' },
  { label: 'Pop', prompt: 'Single clean pop, like a bubble' },
  { label: 'Ding', prompt: 'Bright single ding, like a small bell notification' },
  { label: 'Click', prompt: 'Crisp single click of a button' },
  { label: 'Camera', prompt: 'Camera shutter click' },
  { label: 'Cash register', prompt: 'Cash register cha-ching' },
  { label: 'Sparkle', prompt: 'Short magical sparkle shimmer' },
  { label: 'Riser', prompt: 'Short rising swell that builds tension, two seconds' },
];

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export function soundVolume(volume) {
  return number(volume) === null ? SOUND_DEFAULT_VOLUME : Math.max(0, Math.min(100, Math.round(volume)));
}

/** The project's sounds that have a file and a place, in a stable order. */
export function projectSounds(project) {
  const saved = project?.settings?.sounds;
  if (!saved || typeof saved !== 'object') return [];
  return Object.entries(saved)
    .filter(([, sound]) => sound && typeof sound === 'object' && sound.storageRef && sound.sceneId != null && number(sound.at) !== null && sound.at >= 0)
    .map(([id, sound]) => ({
      id,
      name: String(sound.name || 'Sound'),
      prompt: String(sound.prompt || ''),
      storageRef: sound.storageRef,
      url: sound.url || '',
      seconds: Math.max(0.1, number(sound.seconds) ?? 1),
      sceneId: String(sound.sceneId),
      at: sound.at,
      volume: soundVolume(sound.volume),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Where a sound starts on the timeline, in seconds, or null when it is not heard: its scene is not
 * in the video, or its moment is in a part that was cut away.
 */
export function soundTime(timeline, sound) {
  if (sound.sceneId === SOUND_END) {
    const cardLength = timeline.total - timeline.clipsEnd;
    return cardLength > 0 && sound.at < cardLength ? timeline.clipsEnd + sound.at : null;
  }
  const clip = timeline.clips.find((item) => String(item.id) === sound.sceneId);
  // A hair before the kept start still counts as the start: places are saved to the hundredth.
  if (!clip || sound.at < clip.start - START_SLACK || sound.at >= clip.end) return null;
  return clip.at + Math.max(0, sound.at - clip.start);
}

/** The place ({ sceneId, at }) of a moment of the timeline: the reverse of soundTime. */
export function soundPlace(timeline, time) {
  const hundredth = (seconds) => Math.round(seconds * 100) / 100;
  const cardLength = timeline.total - timeline.clipsEnd;
  if (!timeline.clips.length) return null;
  const t = Math.max(0, Math.min(time, timeline.total - 0.05));
  if (cardLength > 0 && t >= timeline.clipsEnd) return { sceneId: SOUND_END, at: hundredth(t - timeline.clipsEnd) };
  const clip = timeline.clips.find((item) => t < item.at + item.length) || timeline.clips[timeline.clips.length - 1];
  // Kept a hair inside the clip, so the sound never falls on the cut itself.
  const inside = Math.max(0, Math.min(clip.length - 0.02, t - clip.at));
  return { sceneId: String(clip.id), at: hundredth(clip.start + inside) };
}

/** How loud a sound plays in the preview (0 to 1), in proportion to a voice at 100%. */
export function previewSoundGain(volume) {
  return Math.round(PREVIEW_UNITY * soundVolume(volume) / 100 * 1000) / 1000;
}

/** Whether a stitched version was mixed with the sounds as they are placed now. */
export function sameSounds(recorded, project) {
  const clean = (sounds) => JSON.stringify(
    Object.keys(sounds || {}).sort().map((id) => {
      const sound = sounds[id] || {};
      return [id, sound.storageRef || '', String(sound.sceneId ?? ''), Math.round((number(sound.at) ?? 0) * 100), soundVolume(sound.volume)];
    }),
  );
  const now = {};
  projectSounds(project).forEach((sound) => { now[sound.id] = sound; });
  return clean(recorded) === clean(now);
}
