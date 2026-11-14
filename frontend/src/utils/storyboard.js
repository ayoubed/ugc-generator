/**
 * The storyboard: pictures of a scene made before any video (see backend/app/storyboard.py).
 * scene.storyboard.frames.<id> = {id, role, order, description, imageRef, imageUrl, accepted, look, issues}
 * role "start": the picture the scene's video starts on. role "end": the picture it ends on.
 */

export function frameRole(frame) {
  return frame?.role === 'end' ? 'end' : 'start';
}

/** The scene's frame of a role ('start' or 'end'), or null. */
export function frameOfRole(scene, role) {
  return framesInOrder(scene).find((frame) => frameRole(frame) === role) || null;
}

/** The scene's frames, first to last. */
export function framesInOrder(scene) {
  const frames = scene?.storyboard?.frames;
  if (!frames || typeof frames !== 'object') return [];
  return Object.values(frames)
    .filter((frame) => frame && typeof frame === 'object' && frame.id)
    .sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.id).localeCompare(String(b.id)));
}

/** The frame the scene's video starts on: the first accepted start frame with a picture (same rule as the server). */
export function startFrame(scene) {
  return framesInOrder(scene).find((frame) => frameRole(frame) === 'start' && frame.accepted && frame.imageRef) || null;
}

/** The frame the scene's video ends on: the first accepted end frame with a picture. */
export function endFrame(scene) {
  return framesInOrder(scene).find((frame) => frameRole(frame) === 'end' && frame.accepted && frame.imageRef) || null;
}

/** True while the scene ends on its storyboard end frame (and not on a picture chosen elsewhere since). */
export function endsOnStoryboard(scene) {
  const frame = endFrame(scene);
  return Boolean(frame) && scene?.endImageRef === frame.imageRef;
}

/** What a scene's frame shows when it has not been described: the scene's own text (same rule as the server). */
export function sceneMoment(scene, role = 'start') {
  const parts = [scene?.description, scene?.context].map((part) => (part || '').trim()).filter(Boolean).join(' ');
  const text = parts || (scene?.prompt || scene?.script || '').trim();
  return role === 'end' && text ? `The last moment of this scene, when its action is finished: ${text}` : text;
}

/** True while the scene starts on a storyboard frame (and not on a picture chosen elsewhere since). */
export function startsOnStoryboard(scene) {
  const frame = startFrame(scene);
  return Boolean(frame) && scene?.customStartImageRef === frame.imageRef;
}

/**
 * A frame that has a picture but is not accepted, so the scene's video does not start on it yet
 * (or null). Drawing a frame is not enough: the user accepts the one they want used.
 */
export function unusedFrame(scene) {
  if (startFrame(scene)) return null;
  return framesInOrder(scene).find((frame) => frameRole(frame) === 'start' && frame.imageRef) || null;
}

/** Whether any scene has an accepted frame marked as the look of the video. */
export function hasLookFrame(scenes) {
  return (scenes || []).some((scene) => framesInOrder(scene).some((frame) => frameRole(frame) === 'start' && frame.look && frame.accepted));
}

/** { withFrame, accepted, total } over the given scenes. */
export function storyboardCounts(scenes) {
  const list = scenes || [];
  return {
    total: list.length,
    withFrame: list.filter((scene) => frameOfRole(scene, 'start')).length,
    accepted: list.filter((scene) => startFrame(scene)).length,
  };
}

/** Runs `work(item)` over the items, at most `limit` at a time. Failures are collected, not thrown. */
export async function runInPool(items, limit, work) {
  const queue = [...items];
  const failures = [];
  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        await work(item);
      } catch (error) {
        failures.push({ item, error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return failures;
}
