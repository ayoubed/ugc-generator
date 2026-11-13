import React, { useEffect, useId, useRef, useState } from 'react';
import { updateProjectSettings } from '../hooks/useProject';
import { friendlyError } from '../utils/errors';
import { MAX_SCENE_VOLUME, changeEdit, editSummary, keptRange, sceneEdit } from '../utils/edits';

const SAVE_DELAY_MS = 500;

/**
 * Video step: the editor. For each scene in the video: which part is kept (overriding the
 * automatic cut), whether its own sound is heard, and how loud. "Play the cut" plays the scenes one
 * after another as edited, without stitching. Captions, music and the voice change are added by
 * the stitch, so they are not in this preview.
 *
 * @param {object}  project
 * @param {Array}   scenes   [{ scene, label }] in video order, skipped scenes left out
 * @param {number}  fallbackSeconds  scene length to assume until a clip's real length is known
 * @param {boolean} disabled
 */
export default function EditorCard({ project, scenes, fallbackSeconds = 8, disabled = false }) {
  const baseId = useId();
  const player = useRef(null);
  const [durations, setDurations] = useState({});
  const [drafts, setDrafts] = useState({});   // edits changed here and not yet confirmed by the server
  const [playing, setPlaying] = useState(null); // index of the scene the preview is on, or null
  const [error, setError] = useState('');
  const timers = useRef({});
  const pending = useRef({});

  const ready = scenes.filter(({ scene }) => scene.videoUrl);
  const editOf = (scene) => (scene.id in drafts ? drafts[scene.id] : sceneEdit(project, scene));
  const lengthOf = (scene) => durations[scene.id] || fallbackSeconds;

  const flush = (sceneId) => {
    clearTimeout(timers.current[sceneId]);
    if (!(sceneId in pending.current)) return;
    const edit = pending.current[sceneId];
    delete pending.current[sceneId];
    updateProjectSettings(project.id, { [`edits.${sceneId}`]: edit }).catch((err) => {
      console.error('Could not save the edit:', err);
      setError(friendlyError(err));
    });
  };
  // Leaving the page saves what the timers had not saved yet.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => Object.keys(pending.current).forEach(flush), []);

  const change = (scene, field, value) => {
    setError('');
    const next = changeEdit(editOf(scene), field, value, lengthOf(scene), scene.activeAttempt);
    setDrafts((prev) => ({ ...prev, [scene.id]: next }));
    pending.current[scene.id] = next;
    clearTimeout(timers.current[scene.id]);
    timers.current[scene.id] = setTimeout(() => flush(scene.id), SAVE_DELAY_MS);
  };

  // The preview: one player that goes through the scenes, each from its start to its end.
  const current = playing !== null ? ready[playing] : null;
  const range = current ? keptRange(editOf(current.scene), lengthOf(current.scene)) : null;
  const applyTo = (video) => {
    if (!video || !current) return;
    const edit = editOf(current.scene);
    video.muted = Boolean(edit?.muted);
    video.volume = Math.min(1, Math.max(0, edit?.volume ?? 1)); // a browser cannot play louder than 100%
    video.currentTime = range.start;
    video.play?.()?.catch?.(() => {});
  };
  const next = () => setPlaying((index) => (index !== null && index + 1 < ready.length ? index + 1 : null));
  const total = ready.reduce((sum, { scene }) => sum + keptRange(editOf(scene), lengthOf(scene)).length, 0);

  if (!ready.length) return null;

  return (
    <section className="card card-white editor-card" aria-labelledby={`${baseId}-title`}>
      <div className="editor-head">
        <div>
          <h2 className="music-title" id={`${baseId}-title`}>Edit the cut</h2>
          <p className="music-sub">
            Choose the part of each scene to keep, and how loud it is. About {total.toFixed(1)} seconds in total.
          </p>
        </div>
        <button
          type="button"
          id="editor-play"
          className="btn btn-secondary btn-sm"
          onClick={() => setPlaying(playing === null ? 0 : null)}
          disabled={disabled}
        >
          {playing === null ? 'Play the cut' : 'Stop'}
        </button>
      </div>

      {current && (
        <div className="editor-preview">
          <video
            // Keyed by scene, so each scene loads fresh and starts at its own in-point.
            key={current.scene.id}
            ref={player}
            src={current.scene.videoUrl}
            playsInline
            aria-label={`Preview of scene ${current.label}`}
            onLoadedMetadata={(event) => applyTo(event.currentTarget)}
            onTimeUpdate={(event) => { if (event.currentTarget.currentTime >= range.end - 0.03) next(); }}
            onEnded={next}
          />
          <p className="field-hint">
            Scene {current.label}. Captions, music and the chosen voice are added when you stitch.
          </p>
        </div>
      )}

      <ol className="editor-scenes">
        {ready.map(({ scene, label }) => {
          const edit = editOf(scene);
          const length = lengthOf(scene);
          const kept = keptRange(edit, length);
          const summary = editSummary(edit, length);
          const row = `${baseId}-${scene.id}`;
          return (
            <li key={scene.id} className={`editor-scene ${current?.scene.id === scene.id ? 'is-playing' : ''}`}>
              <video
                className="editor-thumb"
                src={scene.videoUrl}
                muted
                playsInline
                preload="metadata"
                aria-hidden="true"
                tabIndex={-1}
                onLoadedMetadata={(event) => {
                  const seconds = event.currentTarget.duration;
                  if (Number.isFinite(seconds) && seconds > 0) setDurations((prev) => ({ ...prev, [scene.id]: seconds }));
                }}
              />
              <div className="editor-controls">
                <div className="editor-scene-head">
                  <span className="editor-scene-name">Scene {label}</span>
                  <span className="editor-scene-note">{summary || `All ${length.toFixed(1)}s, automatic cut`}</span>
                  {edit && (
                    <button type="button" className="link-button" onClick={() => {
                      setDrafts((prev) => ({ ...prev, [scene.id]: null }));
                      pending.current[scene.id] = null;
                      flush(scene.id);
                    }} disabled={disabled}>
                      Reset
                    </button>
                  )}
                </div>
                <div className="editor-sliders">
                  <label htmlFor={`${row}-start`}>Start</label>
                  <input
                    id={`${row}-start`} type="range" min={0} max={length} step={0.1} value={kept.start}
                    aria-label={`Scene ${label} starts at`} disabled={disabled}
                    onChange={(e) => change(scene, 'start', Number(e.target.value))}
                  />
                  <output htmlFor={`${row}-start`}>{kept.start.toFixed(1)}s</output>
                  <label htmlFor={`${row}-end`}>End</label>
                  <input
                    id={`${row}-end`} type="range" min={0} max={length} step={0.1} value={kept.end}
                    aria-label={`Scene ${label} ends at`} disabled={disabled}
                    onChange={(e) => change(scene, 'end', Number(e.target.value))}
                  />
                  <output htmlFor={`${row}-end`}>{kept.end.toFixed(1)}s</output>
                  <label htmlFor={`${row}-volume`}>Voice</label>
                  <input
                    id={`${row}-volume`} type="range" min={0} max={MAX_SCENE_VOLUME * 100} step={5}
                    value={edit?.muted ? 0 : Math.round((edit?.volume ?? 1) * 100)}
                    aria-label={`Scene ${label} voice volume`} disabled={disabled || Boolean(edit?.muted)}
                    onChange={(e) => change(scene, 'volume', Number(e.target.value) / 100)}
                  />
                  <output htmlFor={`${row}-volume`}>{edit?.muted ? 'Muted' : `${Math.round((edit?.volume ?? 1) * 100)}%`}</output>
                </div>
                <label className="gen-run-option" htmlFor={`${row}-mute`}>
                  <input
                    type="checkbox" id={`${row}-mute`} checked={Boolean(edit?.muted)} disabled={disabled}
                    onChange={(e) => change(scene, 'muted', e.target.checked)}
                  />
                  Mute this scene&apos;s own sound (the music still plays)
                </label>
              </div>
            </li>
          );
        })}
      </ol>

      <div aria-live="polite">
        {error && <p className="gen-note is-error" role="alert">{error}</p>}
      </div>
    </section>
  );
}
