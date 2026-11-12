/**
 * Turning the breakdown of a reference video (see backend analyse_reference_video) into what the
 * Idea page and the script writer need. Only the structure is ever used: the reference's spoken
 * words ("said") are shown to the user and never sent on.
 */

export const MAX_STRUCTURE_SCENES = 10;

// A generated speaker stays clear within this range of words per second.
const MIN_PACE = 2;
const MAX_PACE = 3;
const DEFAULT_PACE = 2.5;

// Form guideline key -> key in breakdown.style.
const STYLE_KEYS = {
  camera: 'camera',
  lighting: 'lighting',
  action: 'action',
  scriptTone: 'script_tone',
  visual: 'visual',
  audio: 'audio',
};

/** The breakdown's parts, or [] when there is no usable breakdown. */
export function breakdownParts(breakdown) {
  return Array.isArray(breakdown?.scenes) ? breakdown.scenes : [];
}

/** One scene length for the whole video: the typical part, as the closest length the model offers. */
export function typicalSceneSeconds(parts, durationOptions, fallback) {
  const lengths = parts
    .map((part) => Number(part.end) - Number(part.start))
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  const options = durationOptions?.length ? durationOptions : [fallback];
  const typical = lengths.length ? lengths[Math.floor(lengths.length / 2)] : fallback;
  return options.reduce((best, option) => (Math.abs(option - typical) < Math.abs(best - typical) ? option : best), options[0]);
}

/**
 * What "Use this structure" fills in on the Idea page, or null when the breakdown has no parts.
 * `tags` only holds the guideline categories the breakdown says something about.
 */
export function formSettingsFromBreakdown(breakdown, { durationOptions, currentDuration }) {
  const parts = breakdownParts(breakdown);
  if (!parts.length) return null;
  const duration = typicalSceneSeconds(parts, durationOptions, currentDuration);
  const pace = Math.min(MAX_PACE, Math.max(MIN_PACE, Number(breakdown.wordsPerSecond) || DEFAULT_PACE));
  const tags = {};
  Object.entries(STYLE_KEYS).forEach(([key, styleKey]) => {
    const values = (breakdown.style?.[styleKey] || []).map((t) => String(t).trim()).filter(Boolean);
    if (values.length) tags[key] = values;
  });
  return {
    numScenes: Math.min(MAX_STRUCTURE_SCENES, parts.length),
    hook: (breakdown.hook || '').trim(),
    duration,
    wordsPerScene: Math.round(duration * pace),
    tags,
  };
}

/** The structure sent to the script writer, or null. Their words are left out on purpose. */
export function structureForScript(breakdown) {
  const parts = breakdownParts(breakdown);
  if (!parts.length) return null;
  return {
    scenes: parts.slice(0, MAX_STRUCTURE_SCENES).map((part) => ({
      purpose: part.purpose || '',
      happens: part.happens || '',
      framing: part.framing || '',
    })),
    pacing: breakdown.pacing || '',
    call_to_action: breakdown.call_to_action || '',
  };
}
