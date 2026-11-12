/**
 * The pictures a take was made with (take.referenceImages, saved by the server). A scene that
 * starts from the scene before it also gets the creator photo, so the person stays the same; that
 * one is not a picture the user added, so it is counted apart.
 */
const isCreatorPhoto = (picture) => picture?.scope === 'creator';

/** How many of the user's own context pictures the take used. */
export function takeContextPictureCount(take) {
  return (take?.referenceImages || []).filter((picture) => !isCreatorPhoto(picture)).length;
}

/** Whether the creator photo was sent along to keep the person the same. */
export function usedCreatorPhoto(take) {
  return (take?.referenceImages || []).some(isCreatorPhoto);
}
