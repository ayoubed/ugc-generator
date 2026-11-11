// Scene prompts follow the format the script writer produces:
//   What They Say: [script]
//   What happens: [visual description]
//   Context: [setting, framing, location for this scene]
//
// The Context line is optional: older scenes only have the first two lines, and an empty context
// is left out. The prompt is built from the script, description and context, but it can also be
// edited by hand. A change to one of those fields only flows into its matching prompt section
// while that section still mirrors the old value, so hand edits are never overwritten.

const SAY_LABEL = 'What They Say:';
const HAPPENS_LABEL = 'What happens:';
const CONTEXT_LABEL = 'Context:';
const PROMPT_RE =
  /^\s*What They Say:[ \t]*([\s\S]*?)\r?\n\s*What happens:[ \t]*([\s\S]*?)(?:\r?\n\s*Context:[ \t]*([\s\S]*?))?\s*$/i;
const QUOTES = /^["“”'‘’]+|["“”'‘’]+$/g;

export function buildScenePrompt(script = '', description = '', context = '') {
  const lines = [`${SAY_LABEL} ${script || ''}`, `${HAPPENS_LABEL} ${description || ''}`];
  if ((context || '').trim()) lines.push(`${CONTEXT_LABEL} ${context.trim()}`);
  return lines.join('\n');
}

/** Returns { say, happens, context } or null when the prompt doesn't follow the format. */
export function parseScenePrompt(prompt = '') {
  const match = (prompt || '').match(PROMPT_RE);
  return match ? { say: match[1], happens: match[2], context: match[3] || '' } : null;
}

function normalize(text) {
  return (text || '').trim().replace(QUOTES, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function sameText(a, b) {
  return normalize(a) === normalize(b);
}

// The script writer sometimes wraps the spoken line in quotes: keep that style.
function withSameQuotes(section, value) {
  const match = (section || '').trim().match(/^(["“])[\s\S]*(["”])$/);
  return match ? `${match[1]}${value}${match[2]}` : value;
}

const SECTION_FOR_FIELD = { script: 'say', description: 'happens', context: 'context' };

/**
 * Returns the prompt to save after `field` ('script' | 'description' | 'context') changes to
 * `nextValue`. `scene` holds the values before the change.
 */
export function syncPromptWithField(scene, field, nextValue) {
  const prompt = scene?.prompt || '';
  const values = {
    script: scene?.script || '',
    description: scene?.description || '',
    context: scene?.context || '',
    [field]: nextValue,
  };

  if (!prompt.trim()) return buildScenePrompt(values.script, values.description, values.context);

  const parsed = parseScenePrompt(prompt);
  const section = SECTION_FOR_FIELD[field];
  if (!parsed || !section) return prompt; // custom prompt: leave it alone

  if (!sameText(parsed[section], scene?.[field])) return prompt; // this part was edited by hand

  const next = {
    ...parsed,
    [section]: section === 'say' ? withSameQuotes(parsed.say, nextValue) : nextValue,
  };
  return buildScenePrompt(next.say, next.happens, next.context);
}

/**
 * Describes how the prompt relates to the scene fields, for the hint under the prompt.
 * kind: 'synced' | 'partial' | 'custom'
 */
export function getPromptSyncState(scene) {
  const prompt = scene?.prompt || '';
  if (!prompt.trim()) {
    return { kind: 'synced', saySynced: true, happensSynced: true, contextSynced: true };
  }

  const parsed = parseScenePrompt(prompt);
  if (!parsed) return { kind: 'custom', saySynced: false, happensSynced: false, contextSynced: false };

  const saySynced = sameText(parsed.say, scene?.script);
  const happensSynced = sameText(parsed.happens, scene?.description);
  const contextSynced = sameText(parsed.context, scene?.context);
  const synced = [saySynced, happensSynced, contextSynced].filter(Boolean).length;
  if (synced === 3) return { kind: 'synced', saySynced, happensSynced, contextSynced };
  if (synced === 0) return { kind: 'custom', saySynced, happensSynced, contextSynced };
  return { kind: 'partial', saySynced, happensSynced, contextSynced };
}
