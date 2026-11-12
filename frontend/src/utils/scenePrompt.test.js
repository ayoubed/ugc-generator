import { describe, expect, it } from 'vitest';
import { buildScenePrompt, getPromptSyncState, parseScenePrompt, syncPromptWithField } from './scenePrompt';

describe('scene prompt format', () => {
  it('builds and reads back the three lines', () => {
    const prompt = buildScenePrompt('Hi there.', 'She waves.', 'Kitchen, morning.');
    expect(prompt).toBe('What They Say: Hi there.\nWhat happens: She waves.\nContext: Kitchen, morning.');
    expect(parseScenePrompt(prompt)).toEqual({ say: 'Hi there.', happens: 'She waves.', context: 'Kitchen, morning.' });
  });

  it('leaves out an empty context and still reads older two-line prompts', () => {
    const prompt = buildScenePrompt('Hi.', 'She waves.', '  ');
    expect(prompt).toBe('What They Say: Hi.\nWhat happens: She waves.');
    expect(parseScenePrompt(prompt).context).toBe('');
  });

  it('does not recognise a hand-written prompt', () => {
    expect(parseScenePrompt('A woman waves at the camera.')).toBeNull();
  });
});

describe('syncPromptWithField', () => {
  const scene = { script: 'Hi.', description: 'She waves.', context: '', prompt: 'What They Say: "Hi."\nWhat happens: She waves.' };

  it('carries a script edit into the prompt and keeps the quote style', () => {
    expect(syncPromptWithField(scene, 'script', 'Hello!')).toBe('What They Say: "Hello!"\nWhat happens: She waves.');
  });

  it('adds a context line when context is written', () => {
    expect(syncPromptWithField(scene, 'context', 'Kitchen.')).toBe('What They Say: "Hi."\nWhat happens: She waves.\nContext: Kitchen.');
  });

  it('never overwrites a section that was edited by hand', () => {
    const edited = { ...scene, prompt: 'What They Say: "Hi."\nWhat happens: She waves slowly, smiling.' };
    expect(syncPromptWithField(edited, 'description', 'She nods.')).toBe(edited.prompt);
  });

  it('leaves a fully custom prompt alone and builds one when there is none', () => {
    expect(syncPromptWithField({ ...scene, prompt: 'Custom.' }, 'script', 'Hello!')).toBe('Custom.');
    expect(syncPromptWithField({ ...scene, prompt: '' }, 'script', 'Hello!')).toBe('What They Say: Hello!\nWhat happens: She waves.');
  });
});

describe('getPromptSyncState', () => {
  it('tells synced, partly edited and custom prompts apart', () => {
    const base = { script: 'Hi.', description: 'She waves.', context: '' };
    expect(getPromptSyncState({ ...base, prompt: '' }).kind).toBe('synced');
    expect(getPromptSyncState({ ...base, prompt: 'What They Say: "hi."\nWhat happens: She  waves.' }).kind).toBe('synced');
    expect(getPromptSyncState({ ...base, prompt: 'What They Say: Hi.\nWhat happens: She nods.' }).kind).toBe('partial');
    expect(getPromptSyncState({ ...base, prompt: 'Anything else' }).kind).toBe('custom');
  });
});
