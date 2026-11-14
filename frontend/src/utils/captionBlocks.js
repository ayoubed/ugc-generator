/**
 * Captions placed by hand in the editor (see scene_caption_blocks in backend/app/jobs.py).
 *
 *   settings.captions.manual.<scene id> = true            the scene's captions are placed by hand
 *   settings.captions.blocks.<id> = { sceneId, at, length, text }
 *
 * `at` and `length` are seconds of the scene's clip. A scene placed by hand shows exactly these,
 * in place of its automatic caption; with none placed it has no caption.
 */
export const CAPTION_BLOCK_MIN_SECONDS = 0.2;
export const CAPTION_BLOCK_DEFAULT_SECONDS = 1.5;
export const CAPTION_BLOCKS_PER_SCENE = 20;   // same limit as the server
const WORDS_PER_BLOCK = 4;

const round = (value) => Math.round(value * 100) / 100;
const squash = (text) => (text || '').split(/\s+/).filter(Boolean).join(' ');

export function newBlockId() {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Whether the scene's captions are placed by hand. */
export function isCaptionedByHand(project, sceneId) {
  return Boolean(project?.settings?.captions?.manual?.[sceneId]);
}

/** Every caption placed by hand in the project, as [{ id, sceneId, at, length, text }]. */
export function projectCaptionBlocks(project) {
  const saved = project?.settings?.captions?.blocks;
  if (!saved || typeof saved !== 'object') return [];
  return Object.entries(saved)
    .filter(([, block]) => block && typeof block === 'object' && block.sceneId != null)
    .map(([id, block]) => ({
      id,
      sceneId: String(block.sceneId),
      at: Math.max(0, Number(block.at) || 0),
      length: Math.max(0, Number(block.length) || 0),
      text: typeof block.text === 'string' ? block.text : '',
    }));
}

/** A scene's captions, first to last. */
export function blocksOfScene(blocks, sceneId) {
  return blocks.filter((block) => block.sceneId === String(sceneId)).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/**
 * A caption text cut into short captions spread from `from` to `to` (seconds of the clip): one per
 * sentence, and a long sentence in runs of a few words. Each gets time in proportion to its length.
 * Returns [{ at, length, text }].
 */
export function splitCaption(text, from, to) {
  const phrases = [];
  squash(text).split(/(?<=[.!?…])\s+/).filter(Boolean).forEach((sentence) => {
    const words = sentence.split(' ');
    for (let i = 0; i < words.length; i += WORDS_PER_BLOCK) phrases.push(words.slice(i, i + WORDS_PER_BLOCK).join(' '));
  });
  const span = Math.max(0, to - from);
  if (!phrases.length || span < CAPTION_BLOCK_MIN_SECONDS) return [];
  const kept = phrases.slice(0, Math.min(CAPTION_BLOCKS_PER_SCENE, Math.floor(span / CAPTION_BLOCK_MIN_SECONDS)));
  if (kept.length < phrases.length) kept[kept.length - 1] = phrases.slice(kept.length - 1).join(' ');
  const total = kept.reduce((sum, phrase) => sum + phrase.length + 2, 0);
  let clock = from;
  return kept.map((phrase) => {
    const length = (span * (phrase.length + 2)) / total;
    const block = { at: round(clock), length: round(length), text: phrase };
    clock += length;
    return block;
  });
}

/** Where a caption is seen on the timeline: { time, length }, or null when its part of the clip is cut. */
export function blockSpan(clip, block) {
  const from = Math.max(block.at, clip.start);
  const to = Math.min(block.at + block.length, clip.end);
  if (to - from <= 0.01) return null;
  return { time: clip.at + (from - clip.start), length: to - from };
}

/** A change to a caption, kept inside its scene. sceneSeconds: the full length of the clip. */
export function changeBlock(block, field, value, sceneSeconds) {
  const next = { ...block };
  if (field === 'text') next.text = String(value ?? '').slice(0, 200);
  else if (field === 'at') {
    const latest = Math.max(0, sceneSeconds - CAPTION_BLOCK_MIN_SECONDS);
    next.at = round(Math.min(Math.max(0, Number(value) || 0), latest));
    next.length = round(Math.min(block.length, Math.max(CAPTION_BLOCK_MIN_SECONDS, sceneSeconds - next.at)));
  } else if (field === 'length') {
    const longest = Math.max(CAPTION_BLOCK_MIN_SECONDS, sceneSeconds - block.at);
    next.length = round(Math.min(Math.max(CAPTION_BLOCK_MIN_SECONDS, Number(value) || 0), longest));
  }
  return next;
}

/** What is saved for a caption (its id is the key it is saved under). */
export function storedBlock({ sceneId, at, length, text }) {
  return { sceneId, at, length, text };
}

/** The same line the server records for a scene's captions, so a stitched version can be compared. */
export function blocksSignature(blocks) {
  return [...blocks]
    .map((block) => ({ ...block, text: squash(block.text) }))
    .filter((block) => block.text && block.length > 0)
    .sort((a, b) => a.at - b.at)
    .slice(0, CAPTION_BLOCKS_PER_SCENE)
    .map((block) => `${block.at.toFixed(2)}:${block.length.toFixed(2)}:${block.text.slice(0, 200)}`)
    .join('|');
}
