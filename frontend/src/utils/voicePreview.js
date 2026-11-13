/**
 * Hearing the voice chosen for the whole video before stitching. The server re-voices each scene
 * ahead of time (POST /projects/{id}/voice/preview) and records the playable files in
 * project.voicePreview = { voiceId, status, error, scenes: { <scene id>: { attempt, url } } }.
 */
import { projectVoice, toMillis } from './projectProgress';

const STALE_MS = 10 * 60 * 1000; // same limit the API uses

/** The re-voiced audio of a scene's take in use, in the voice chosen now. '' when there is none. */
export function revoicedUrl(project, scene) {
  const voice = projectVoice(project);
  const preview = project?.voicePreview;
  if (!voice || !preview || preview.voiceId !== voice.id) return '';
  const entry = preview.scenes?.[scene?.id];
  return entry && entry.attempt === (scene?.activeAttempt ?? null) && entry.url ? entry.url : '';
}

/**
 * Where the preview of the chosen voice stands:
 * 'off' (no voice chosen), 'missing' (not made for this voice or for every scene yet),
 * 'building', 'failed' or 'ready' (every scene with a video can be played in the voice).
 */
export function voicePreviewState(project, scenes, now = Date.now()) {
  const voice = projectVoice(project);
  if (!voice) return 'off';
  const preview = project?.voicePreview;
  if (!preview || preview.voiceId !== voice.id) return 'missing';
  if (preview.status === 'building') {
    return now - (toMillis(preview.startedAt) || now) < STALE_MS ? 'building' : 'missing';
  }
  if (preview.status === 'failed') return 'failed';
  const all = (scenes || []).every((scene) => !scene.videoUrl || scene.skipped || revoicedUrl(project, scene));
  return all ? 'ready' : 'missing';
}
