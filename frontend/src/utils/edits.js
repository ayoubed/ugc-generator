/**
 * The editor on the Video step: what is kept of each scene in the final video, and how loud.
 * Saved as settings.edits.<scene id> = { attempt, start, end, muted, volume } and applied by the
 * server when it stitches (backend: jobs.scene_edits, pipeline.apply_scene_edit).
 *
 * An edit belongs to the take it was made on: once another take is in use its trim points mean
 * nothing, so it is ignored (and overwritten by the next change).
 */
export const MIN_KEPT_SECONDS = 0.3;   // same floor as the server
export const MAX_SCENE_VOLUME = 2;     // 200%

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** The saved edit of a scene for the take in use, or null. Only the fields that are set. */
export function sceneEdit(project, scene) {
  const saved = project?.settings?.edits?.[scene?.id];
  if (!saved || typeof saved !== 'object' || saved.attempt !== (scene?.activeAttempt ?? null)) return null;
  const edit = {};
  ['start', 'end', 'volume'].forEach((key) => {
    if (number(saved[key]) !== null) edit[key] = saved[key];
  });
  if (saved.muted) edit.muted = true;
  return Object.keys(edit).length ? edit : null;
}

/** Start and end of the kept part, for a clip of `duration` seconds (the whole clip without an edit). */
export function keptRange(edit, duration) {
  const length = Math.max(0, number(duration) ?? 0);
  let start = Math.min(length, Math.max(0, number(edit?.start) ?? 0));
  let end = Math.min(length, Math.max(0, number(edit?.end) ?? length));
  if (end - start < MIN_KEPT_SECONDS) [start, end] = [0, length];
  return { start, end, length: end - start };
}

/**
 * The edit to save after changing `field` to `value`, or null when nothing differs from the
 * untouched scene any more. Trim points are kept MIN_KEPT_SECONDS apart and inside the clip.
 */
export function changeEdit(edit, field, value, duration, attempt) {
  const next = { ...(edit || {}) };
  const length = Math.max(0, number(duration) ?? 0);
  if (field === 'start') {
    const end = number(next.end) ?? length;
    next.start = Math.round(Math.max(0, Math.min(value, end - MIN_KEPT_SECONDS)) * 10) / 10;
    if (next.start <= 0) delete next.start;
  } else if (field === 'end') {
    const start = number(next.start) ?? 0;
    next.end = Math.round(Math.min(length, Math.max(value, start + MIN_KEPT_SECONDS)) * 10) / 10;
    if (next.end >= length) delete next.end;
  } else if (field === 'muted') {
    if (value) next.muted = true;
    else delete next.muted;
  } else if (field === 'volume') {
    next.volume = Math.round(Math.max(0, Math.min(MAX_SCENE_VOLUME, value)) * 100) / 100;
    if (next.volume === 1) delete next.volume;
  }
  delete next.attempt;
  return Object.keys(next).length ? { ...next, attempt: attempt ?? null } : null;
}

/** One line on what an edit does, e.g. "0.5s to 4.0s · muted". '' without an edit. */
export function editSummary(edit, duration) {
  if (!edit) return '';
  const parts = [];
  if (number(edit.start) !== null || number(edit.end) !== null) {
    const { start, end } = keptRange(edit, duration);
    parts.push(`${start.toFixed(1)}s to ${end.toFixed(1)}s`);
  }
  if (edit.muted) parts.push('muted');
  else if (number(edit.volume) !== null) parts.push(`voice ${Math.round(edit.volume * 100)}%`);
  return parts.join(' · ');
}

/** The edits in force now, per scene id, in a form that can be compared with a stitched version's. */
export function currentEdits(project, scenes) {
  const edits = {};
  (scenes || []).forEach((scene) => {
    const edit = sceneEdit(project, scene);
    if (edit && !scene.skipped) edits[scene.id] = edit;
  });
  return edits;
}

/** Whether two sets of edits would cut the video the same way. */
export function sameEdits(a, b) {
  const clean = (edits) => {
    const out = {};
    Object.keys(edits || {}).sort().forEach((id) => {
      const { start, end, volume, muted } = edits[id] || {};
      const entry = [number(start), number(end), muted ? null : number(volume), Boolean(muted)];
      if (entry.some((v) => v !== null && v !== false)) out[id] = entry;
    });
    return JSON.stringify(out);
  };
  return clean(a) === clean(b);
}

/** Music volume as the slider shows it: 0 to 100. Older projects saved low / medium / high. */
export function musicVolumePercent(volume) {
  const named = { low: 24, medium: 40, high: 64 };
  if (typeof volume === 'string' && volume in named) return named[volume];
  return number(volume) !== null ? Math.max(0, Math.min(100, Math.round(volume))) : named.medium;
}
