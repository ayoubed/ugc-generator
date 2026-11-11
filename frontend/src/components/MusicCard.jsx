import React, { useId, useRef, useState } from 'react';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { storage } from '../services/firebase';
import LoadingSpinner from './LoadingSpinner';
import { useModels } from '../hooks/useModels';
import { updateProjectSettings } from '../hooks/useProject';
import { generateMusic } from '../services/api';
import { friendlyError } from '../utils/errors';
import { MUSIC_VOLUME_OPTIONS, projectMusic, toMillis } from '../utils/projectProgress';

const MAX_MUSIC_BYTES = 50 * 1024 * 1024; // same limit as the storage rules
const STALE_MUSIC_MS = 10 * 60 * 1000; // same limit the API uses

/**
 * One music track for the whole final video. It's mixed in when stitching: looped or trimmed to the
 * video's length, lowered while someone talks, and faded in and out. Changing it marks the current
 * final video as out of date, so the user stitches again to hear it.
 */
export default function MusicCard({ project, now, disabled = false }) {
  const baseId = useId();
  const fileInput = useRef(null);
  const { musicModels, defaultMusicModel } = useModels();

  const music = projectMusic(project);
  const generating = project?.musicStatus === 'generating'
    && now - (toMillis(project?.musicStartedAt) || now) < STALE_MUSIC_MS;
  const musicError = project?.musicStatus === 'failed' ? project?.musicError || '' : '';

  const [mode, setMode] = useState(null); // null | 'generate'
  const [prompt, setPrompt] = useState(project?.musicPrompt || '');
  const [modelId, setModelId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const chosenModel = modelId || music?.model || defaultMusicModel;
  const volume = music?.volume || 'medium';

  const save = async (partial) => {
    setError('');
    try {
      await updateProjectSettings(project.id, partial);
    } catch (err) {
      console.error('Could not save the music:', err);
      setError(friendlyError(err));
    }
  };

  const handleUpload = async (file) => {
    if (!file) return;
    if (!file.type.startsWith('audio/')) {
      setError('Pick an audio file (MP3, WAV, M4A…).');
      return;
    }
    if (file.size > MAX_MUSIC_BYTES) {
      setError('That file is over 50 MB. Pick a shorter or more compressed track.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const ext = (file.name.split('.').pop() || 'mp3').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp3';
      const path = `users/${project.userId}/projects/${project.id}/music/upload_${Date.now()}.${ext}`;
      const fileRef = ref(storage, path);
      await uploadBytes(fileRef, file, { contentType: file.type });
      const url = await getDownloadURL(fileRef);
      await save({
        music: { source: 'upload', storageRef: path, url, name: file.name, volume },
      });
      setMode(null);
    } catch (err) {
      console.error('Music upload failed:', err);
      setError(friendlyError(err));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const handleGenerate = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await generateMusic(project.id, { prompt: prompt.trim(), model: chosenModel || null, volume });
      setMode(null);
    } catch (err) {
      console.error('Could not start the music:', err);
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  const locked = disabled || busy || generating;

  return (
    <section className="card card-white music-card" aria-labelledby={`${baseId}-title`}>
      <div className="music-head">
        <span className="music-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
        </span>
        <div>
          <h2 className="music-title" id={`${baseId}-title`}>Background music</h2>
          <p className="music-sub">
            One track under the whole video, so it never changes between scenes. It gets quieter while someone talks.
          </p>
        </div>
      </div>

      {generating ? (
        <div className="music-status" role="status">
          <LoadingSpinner size="sm" />
          <span>Making your music track… This takes up to a minute.</span>
        </div>
      ) : music ? (
        <div className="music-current">
          <div className="music-current-row">
            <span className="music-name" title={music.name}>{music.name || 'Music track'}</span>
            <span className="export-pill">{music.source === 'generated' ? 'AI' : 'Uploaded'}</span>
          </div>
          {music.url && (
            <audio className="music-player" controls preload="none" src={music.url} aria-label="Preview the music track" />
          )}
          <div className="music-volume" role="group" aria-labelledby={`${baseId}-vol`}>
            <span className="music-label" id={`${baseId}-vol`}>Volume under the voice</span>
            <div className="music-segmented">
              {MUSIC_VOLUME_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`music-seg ${volume === option.value ? 'is-active' : ''}`}
                  aria-pressed={volume === option.value}
                  onClick={() => save({ music: { ...project.settings.music, volume: option.value } })}
                  disabled={locked}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <p className="music-empty">No music. The video uses only the scenes&apos; own sound.</p>
      )}

      {mode === 'generate' && !generating && (
        <form className="music-form" onSubmit={handleGenerate}>
          <label className="label" htmlFor={`${baseId}-prompt`}>Describe the music</label>
          <textarea
            id={`${baseId}-prompt`}
            className="textarea"
            rows={2}
            maxLength={1000}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. Chill lo-fi beat, warm and upbeat, soft drums"
            autoFocus
          />
          {musicModels.length > 1 && (
            <>
              <label className="label" htmlFor={`${baseId}-model`}>Music model</label>
              <select
                id={`${baseId}-model`}
                className="select"
                value={chosenModel}
                onChange={(e) => setModelId(e.target.value)}
              >
                {musicModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
              <p className="field-hint">{musicModels.find((m) => m.id === chosenModel)?.description}</p>
            </>
          )}
          <p className="field-hint">Always instrumental, so it never talks over the speaker.</p>
          <div className="music-actions">
            <button type="submit" className="btn btn-primary btn-sm" disabled={locked}>
              {busy ? 'Starting…' : music ? 'Make a new track' : 'Make music'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMode(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {mode !== 'generate' && !generating && (
        <div className="music-actions">
          <button type="button" id="music-generate" className="btn btn-secondary btn-sm" onClick={() => setMode('generate')} disabled={locked}>
            {music ? 'Make new AI music' : 'Make AI music'}
          </button>
          <button type="button" id="music-upload" className="btn btn-secondary btn-sm" onClick={() => fileInput.current?.click()} disabled={locked}>
            {busy ? <LoadingSpinner size="sm" label="Uploading…" /> : 'Upload a track'}
          </button>
          {music && (
            <button
              type="button"
              id="music-remove"
              className="btn btn-ghost btn-sm"
              onClick={() => save({ music: { ...project.settings.music, source: 'none' } })}
              disabled={locked}
            >
              Remove music
            </button>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="audio/*"
            className="visually-hidden"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => handleUpload(e.target.files?.[0])}
          />
        </div>
      )}

      <div aria-live="polite">
        {(error || musicError) && (
          <p className="export-note is-error" role="alert">
            {error || `The music couldn't be made: ${musicError}`}
          </p>
        )}
      </div>
      {music && <p className="field-hint">Changes apply the next time you stitch.</p>}
    </section>
  );
}
