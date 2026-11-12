// Naming and describing final video versions (the Video step).
import { formatSceneList, isSceneBusy, isSceneSkipped, sceneHasVideo, sceneLabels } from './projectProgress';

/** A stable key for a version; videos stitched before versioning share the key 'legacy'. */
export function versionKey(video) {
  if (!video) return '';
  return video.version ? `v${video.version}` : 'legacy';
}

export function versionName(video) {
  return video?.version ? `Version ${video.version}` : 'Final video';
}

function slugify(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
}

/** File name for a downloaded version, from the project's title. */
export function downloadName(project, video) {
  const base = slugify(project?.title || project?.idea) || 'video';
  return `${base}${video?.version ? `-v${video.version}` : ''}.mp4`;
}

/** Why the scenes can't be stitched yet, e.g. "Scene 2 is still generating and Scene 3 needs a video". '' when ready. */
export function notReadyReason(scenes) {
  const busy = [];
  const missing = [];
  const labels = sceneLabels(scenes);
  (scenes || []).forEach((scene, idx) => {
    if (isSceneSkipped(scene)) return;
    if (isSceneBusy(scene)) busy.push(labels[idx]);
    else if (!sceneHasVideo(scene)) missing.push(labels[idx]);
  });
  const parts = [];
  if (busy.length) parts.push(`${formatSceneList(busy)} ${busy.length === 1 ? 'is' : 'are'} still generating`);
  if (missing.length) parts.push(`${formatSceneList(missing)} ${missing.length === 1 ? 'needs' : 'need'} a video`);
  return parts.join(' and ');
}
