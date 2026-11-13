import React, { useId, useState } from 'react';
import LoadingSpinner from './LoadingSpinner';
import { updateProjectSettings } from '../hooks/useProject';
import { useVoices } from '../hooks/useVoices';
import { previewVoice } from '../services/api';
import { friendlyError } from '../utils/errors';
import { projectVoice } from '../utils/projectProgress';

/**
 * Video step: one voice for the whole video. Scenes are generated one by one, so the speaker can
 * sound a little different from scene to scene; with a voice chosen here, every scene's speech is
 * re-voiced to it when the video is stitched (same words, timing and delivery).
 *
 * Renders nothing when the server has no voice service set up, unless the project already has a
 * voice chosen: then it says so and lets it be switched off, because the stitch would fail.
 *
 * @param {object}  project
 * @param {boolean} disabled
 */
export default function VoiceCard({ project, disabled = false }) {
  const baseId = useId();
  const { available, voices, loading, error: loadError } = useVoices();
  const [error, setError] = useState('');
  const chosen = projectVoice(project);

  if (loading) return null;
  if (!available && !loadError && !chosen) return null;

  const save = async (voice) => {
    setError('');
    try {
      await updateProjectSettings(project.id, { voice });
    } catch (err) {
      console.error('Could not save the voice:', err);
      setError(friendlyError(err));
    }
  };

  const handleChange = async (event) => {
    const voice = voices.find((v) => v.id === event.target.value);
    await save(voice ? { id: voice.id, name: voice.name } : null);
    if (!voice) return;
    // Re-voices the scenes now, so the editor below can play the voice before the stitch.
    previewVoice(project.id).catch((err) => console.error('Could not prepare the voice:', err));
  };

  const sample = voices.find((v) => v.id === chosen?.id)?.previewUrl || '';
  // While the server re-voices the scenes for the editor: how many are done (null when it is not running).
  const preview = project?.voicePreview;
  const loadingScenes = chosen && preview?.voiceId === chosen.id && preview.status === 'building'
    ? Object.keys(preview.scenes || {}).length : null;
  // A voice saved earlier that the account no longer has stays selectable, so it is not lost silently.
  const missing = chosen && !voices.some((v) => v.id === chosen.id);
  const unavailable = !available || Boolean(loadError);

  return (
    <section className="card card-white music-card" aria-labelledby={`${baseId}-title`}>
      <div className="music-head">
        <span className="music-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0" />
            <line x1="12" y1="18" x2="12" y2="21" />
          </svg>
        </span>
        <div>
          <h2 className="music-title" id={`${baseId}-title`}>Voice</h2>
          <p className="music-sub">
            Scenes are made one by one, so the speaker can sound a little different in each. Pick one voice and
            every scene is re-voiced to it when you stitch: same words, same timing.
          </p>
        </div>
      </div>

      <div className="form-group" style={{ marginBottom: 0 }}>
        <label className="label" htmlFor={`${baseId}-voice`}>Voice for the whole video</label>
        <select
          id={`${baseId}-voice`}
          className="select"
          value={chosen?.id || ''}
          onChange={handleChange}
          disabled={disabled || (unavailable && !chosen)}
        >
          <option value="">Each scene&apos;s own voice</option>
          {missing && <option value={chosen.id}>{chosen.name || 'Saved voice'}</option>}
          {voices.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {voice.name}{voice.description ? ` (${voice.description})` : ''}
            </option>
          ))}
        </select>
        {chosen ? (
          <p className="field-hint">
            You can hear it in the editor below once it is prepared. The room sound of each scene goes with the old
            voice; if the lips look off, go back to each scene&apos;s own voice.
          </p>
        ) : (
          <p className="field-hint">Nothing is changed: the video keeps the voices the scenes were made with.</p>
        )}
      </div>

      {chosen && loadingScenes !== null && (
        <p className="editor-loading" role="status" style={{ marginTop: 'var(--space-3)', marginBottom: 0 }}>
          <LoadingSpinner size="sm" />
          <span>
            Loading this voice for the editor: {loadingScenes} {loadingScenes === 1 ? 'scene' : 'scenes'} ready so far.
          </span>
        </p>
      )}

      {sample && (
        // Keyed by voice, so picking another one loads its sample.
        <audio key={chosen.id} className="voice-sample" src={sample} controls preload="none" aria-label={`Sample of ${chosen.name}`} />
      )}

      <div aria-live="polite">
        {unavailable && chosen && (
          <p className="gen-note is-warning" role="alert">
            {loadError || 'The voice service is not set up on the server.'} Stitching with this voice will fail
            until that is fixed; choose “Each scene’s own voice” to stitch without it.
          </p>
        )}
        {unavailable && !chosen && loadError && <p className="gen-note is-error" role="alert">{loadError}</p>}
        {error && <p className="gen-note is-error" role="alert">{error}</p>}
      </div>
    </section>
  );
}
