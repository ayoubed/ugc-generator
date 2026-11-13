/**
 * The maths of the editor's timeline: where each clip sits, which clip a moment falls in, and the
 * marks of the ruler. No React and no DOM here, so it is all testable.
 */
import { currentFinalVideo } from './projectProgress';

export const MIN_SCALE = 20;      // pixels per second
export const MAX_SCALE = 200;
export const DEFAULT_SCALE = 60;

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * The automatic cut of a scene ({start, end}), as the last stitch made it: the server trims the
 * silence before the first word and after the last one. Known only after a stitch of the take in
 * use; a side that the stitch took from an edit is not "automatic" and is left out.
 */
export function autoCut(project, scene) {
  const version = currentFinalVideo(project);
  const cut = version?.cuts?.[scene?.id];
  if (!cut || cut.attempt !== (scene?.activeAttempt ?? null)) return null;
  const edited = version.edits?.[scene.id] || {};
  const auto = {};
  if (finite(cut.start) !== null && finite(edited.start) === null) auto.start = cut.start;
  if (finite(cut.end) !== null && finite(edited.end) === null) auto.end = cut.end;
  return Object.keys(auto).length ? auto : null;
}

/**
 * Lays clips out one after another. `clips` are [{ id, start, end }] (the kept part of each, in
 * seconds of that clip); each gets `at` (where it begins on the timeline) and `length`.
 * `tail` adds seconds after the last clip (the end card).
 */
export function buildTimeline(clips, tail = 0) {
  let at = 0;
  const placed = (clips || []).map((clip) => {
    const length = Math.max(0, clip.end - clip.start);
    const item = { ...clip, at, length };
    at += length;
    return item;
  });
  return { clips: placed, clipsEnd: at, total: at + Math.max(0, finite(tail) ?? 0) };
}

/** The clip a moment of the timeline falls in: { index, clipTime } (seconds inside that clip's file). */
export function locate(timeline, time) {
  const { clips, clipsEnd } = timeline;
  if (!clips.length) return null;
  const t = Math.max(0, Math.min(time, Math.max(0, clipsEnd - 0.001)));
  const index = Math.max(0, clips.findIndex((clip) => t < clip.at + clip.length));
  const clip = clips[index === -1 ? clips.length - 1 : index];
  return { index: clips.indexOf(clip), clipTime: clip.start + Math.max(0, t - clip.at) };
}

/** The moment on the timeline of `clipTime` (seconds in the clip's file) of clip `index`. */
export function timelineTime(timeline, index, clipTime) {
  const clip = timeline.clips[index];
  if (!clip) return 0;
  return clip.at + Math.max(0, Math.min(clip.length, clipTime - clip.start));
}

/** Marks of the ruler: [{ time, label }], spaced so labels never crowd at this zoom. */
export function rulerMarks(total, scale) {
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60].find((seconds) => seconds * scale >= 56) || 60;
  const marks = [];
  for (let time = 0; time <= total + 1e-6; time += step) {
    marks.push({ time: Math.round(time * 10) / 10, label: clock(time, step < 1) });
  }
  return marks;
}

/** 0:07 or 0:07.5 */
export function clock(seconds, tenths = false) {
  const safe = Math.max(0, finite(seconds) ?? 0);
  const whole = tenths ? Math.floor(safe * 10) / 10 : Math.floor(safe);
  const minutes = Math.floor(whole / 60);
  const rest = whole - minutes * 60;
  const text = tenths ? rest.toFixed(1).padStart(4, '0') : String(Math.floor(rest)).padStart(2, '0');
  return `${minutes}:${text}`;
}

/** The zoom at which the whole video fits the width, within the allowed range. */
export function fitScale(width, total) {
  if (!(width > 0) || !(total > 0)) return DEFAULT_SCALE;
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.floor(width / total)));
}

export function zoomScale(scale, direction) {
  const next = direction > 0 ? scale * 1.4 : scale / 1.4;
  return Math.round(Math.max(MIN_SCALE, Math.min(MAX_SCALE, next)));
}
