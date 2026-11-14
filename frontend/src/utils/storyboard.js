/**
 * The storyboard: pictures of a scene made before any video (see backend/app/storyboard.py).
 * scene.storyboard.frames.<id> = {id, order, description, imageRef, imageUrl, accepted, look, issues}
 */

/** The scene's frames, first to last. */
export function framesInOrder(scene) {
  const frames = scene?.storyboard?.frames;
  if (!frames || typeof frames !== 'object') return [];
  return Object.values(frames)
    .filter((frame) => frame && typeof frame === 'object' && frame.id)
    .sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.id).localeCompare(String(b.id)));
}

/** The frame the scene's video starts on: the first accepted one with a picture (same rule as the server). */
export function startFrame(scene) {
  return framesInOrder(scene).find((frame) => frame.accepted && frame.imageRef) || null;
}

/** What a scene's frame shows when it has not been described: the scene's own text (same rule as the server). */
export function sceneMoment(scene) {
  const text = [scene?.description, scene?.context].map((part) => (part || '').trim()).filter(Boolean).join(' ');
  return text || (scene?.prompt || scene?.script || '').trim();
}

/** True while the scene starts on a storyboard frame (and not on a picture chosen elsewhere since). */
export function startsOnStoryboard(scene) {
  const frame = startFrame(scene);
  return Boolean(frame) && scene?.customStartImageRef === frame.imageRef;
}

/** Whether any scene has an accepted frame marked as the look of the video. */
export function hasLookFrame(scenes) {
  return (scenes || []).some((scene) => framesInOrder(scene).some((frame) => frame.look && frame.accepted));
}

/** { withFrame, accepted, total } over the given scenes. */
export function storyboardCounts(scenes) {
  const list = scenes || [];
  return {
    total: list.length,
    withFrame: list.filter((scene) => framesInOrder(scene).length > 0).length,
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
