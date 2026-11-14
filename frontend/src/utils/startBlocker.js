import {
  FROM_PREVIOUS_SOURCES,
  contextPictureCount,
  isBusyAndFresh,
  isProductLed,
  sceneHasVideo,
  startPictureRef,
} from './projectProgress';

function hasCustomPicture(scene) {
  return Boolean(scene.customStartImageRef) || (scene.startingImageRef || '').includes('/input_image');
}

/** Why a new take can't start right now ('' when it can). Mirrors the checks the API makes. */
export function startBlocker({ scene, source, prevScene, prevLabel, project, now, pickerBusy, pictureLimit }) {
  if (pickerBusy) return 'Wait for the picture to finish uploading.';
  if (!(scene.prompt || '').trim()) return 'Write a video prompt first.';
  if (FROM_PREVIOUS_SOURCES.includes(source)) {
    if (!prevScene) return 'This scene has no scene before it. Pick another starting picture.';
    if (isBusyAndFresh(prevScene, now)) return `Wait for ${prevLabel} to finish, so this scene starts from its new take.`;
    if (!sceneHasVideo(prevScene)) return `Generate ${prevLabel} first, or pick another starting picture.`;
  }
  // A product-led video has no creator photo: it starts from the first product picture.
  if (source === 'creator' && !startPictureRef(project)) {
    return isProductLed(project)
      ? 'There is no product picture yet. Add one on the Idea step, or pick another starting picture.'
      : 'There is no creator photo yet. Add one in Step 1, or pick another starting picture.';
  }
  if (source === 'uploaded' && !hasCustomPicture(scene)) {
    return 'Upload a custom picture first, or pick another starting picture.';
  }
  const count = contextPictureCount(project, scene);
  if (count > pictureLimit) {
    return `This scene has ${count} context pictures and the limit is ${pictureLimit}. Remove ${count - pictureLimit} on the Script step.`;
  }
  return '';
}
