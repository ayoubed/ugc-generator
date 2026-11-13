import { describe, expect, it } from 'vitest';
import { revoicedUrl, voicePreviewState } from './voicePreview';

const scene = (id, extra = {}) => ({ id, activeAttempt: 2, videoUrl: `${id}.mp4`, ...extra });
const project = (preview, voice = { id: 'v1', name: 'Sarah' }) => ({ settings: { voice }, voicePreview: preview });
const made = (ids, extra = {}) => ({
  voiceId: 'v1', status: 'ready', scenes: Object.fromEntries(ids.map((id) => [id, { attempt: 2, url: `${id}.mp3` }])), ...extra,
});

describe('the chosen voice in the preview', () => {
  it('gives a scene\'s re-voiced audio for the take in use and the voice chosen now', () => {
    expect(revoicedUrl(project(made(['0'])), scene('0'))).toBe('0.mp3');
    expect(revoicedUrl(project(made(['0'])), scene('0', { activeAttempt: 3 }))).toBe('');     // another take since
    expect(revoicedUrl(project(made(['0']), { id: 'v2', name: 'Adam' }), scene('0'))).toBe(''); // another voice since
    expect(revoicedUrl(project(made(['0']), null), scene('0'))).toBe('');
    expect(revoicedUrl(project(undefined), scene('0'))).toBe('');
  });

  it('is off without a voice, and missing until it was made for this voice', () => {
    expect(voicePreviewState(project(made(['0']), null), [scene('0')])).toBe('off');
    expect(voicePreviewState(project(undefined), [scene('0')])).toBe('missing');
    expect(voicePreviewState(project(made(['0'], { voiceId: 'v9' })), [scene('0')])).toBe('missing');
  });

  it('is ready only when every scene in the video can be played in the voice', () => {
    const scenes = [scene('0'), scene('1'), scene('2', { skipped: true }), scene('3', { videoUrl: '' })];
    expect(voicePreviewState(project(made(['0', '1'])), scenes)).toBe('ready');
    expect(voicePreviewState(project(made(['0'])), scenes)).toBe('missing');                    // a new take or scene since
  });

  it('follows a run that is going, failed, or never finished', () => {
    const now = 1_000_000_000;
    expect(voicePreviewState(project(made([], { status: 'building', startedAt: now - 5000 })), [scene('0')], now)).toBe('building');
    expect(voicePreviewState(project(made([], { status: 'building', startedAt: now - 11 * 60 * 1000 })), [scene('0')], now)).toBe('missing');
    expect(voicePreviewState(project(made([], { status: 'failed', error: 'x' })), [scene('0')], now)).toBe('failed');
  });
});
