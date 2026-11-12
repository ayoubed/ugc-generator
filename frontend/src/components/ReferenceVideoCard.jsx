import React, { useEffect, useId, useRef, useState } from 'react';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { storage } from '../services/firebase';
import LoadingSpinner from './LoadingSpinner';
import { updateProjectSettings } from '../hooks/useProject';
import { analyseReference } from '../services/api';
import { friendlyError } from '../utils/errors';
import { toMillis } from '../utils/projectProgress';

const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // same limit as the storage rules
const EXTENSIONS = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };
const STALE_MS = 10 * 60 * 1000; // same limit the API uses
const SAVE_DELAY_MS = 700;

const seconds = (value) => `${Math.round(Number(value) || 0)}s`;

/**
 * The breakdown of the reference video, editable. The parent keys this by video, so the fields
 * start from the saved breakdown and are then owned here.
 */
function BreakdownEditor({ projectId, breakdown, disabled, onChange, onError }) {
  const baseId = useId();
  const [value, setValue] = useState(breakdown);
  const timer = useRef(null);
  const pending = useRef(null);

  const flush = () => {
    clearTimeout(timer.current);
    if (!pending.current) return;
    const next = pending.current;
    pending.current = null;
    updateProjectSettings(projectId, { 'reference.breakdown': next }).catch((err) => {
      console.error('Could not save the breakdown:', err);
      onError(friendlyError(err));
    });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => flush, []);

  const change = (next) => {
    setValue(next);
    onChange?.(next);
    pending.current = next;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DELAY_MS);
  };
  const setField = (key, text) => change({ ...value, [key]: text });
  const setPart = (index, key, text) => change({
    ...value,
    scenes: value.scenes.map((part, i) => (i === index ? { ...part, [key]: text } : part)),
  });
  const removePart = (index) => change({ ...value, scenes: value.scenes.filter((_, i) => i !== index) });

  return (
    <div className="ref-breakdown">
      {value.summary && <p className="ref-summary">{value.summary}</p>}

      <label className="label" htmlFor={`${baseId}-hook`}>
        Hook{value.hook_type && value.hook_type !== 'Other' ? ` (${value.hook_type})` : ''}
      </label>
      <textarea
        id={`${baseId}-hook`}
        className="textarea"
        rows={2}
        maxLength={600}
        value={value.hook || ''}
        disabled={disabled}
        onChange={(e) => setField('hook', e.target.value)}
        onBlur={flush}
      />

      <p className="label" style={{ marginTop: '12px' }}>
        Parts ({value.scenes.length}). Each one becomes a scene.
      </p>
      <ol className="ref-parts">
        {value.scenes.map((part, index) => (
          // Parts have no id and can be removed, so the start time keeps a field's focus on its part.
          <li className="ref-part" key={`${part.start}-${part.end}`}>
            <div className="ref-part-head">
              <span className="export-pill">{seconds(part.start)} to {seconds(part.end)}</span>
              <input
                className="input ref-part-purpose"
                type="text"
                maxLength={300}
                aria-label={`What part ${index + 1} does`}
                value={part.purpose || ''}
                disabled={disabled}
                onChange={(e) => setPart(index, 'purpose', e.target.value)}
                onBlur={flush}
              />
              {value.scenes.length > 1 && (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => removePart(index)}
                  disabled={disabled}
                  aria-label={`Remove part ${index + 1}`}
                >
                  Remove
                </button>
              )}
            </div>
            {part.said && <p className="ref-said">They say: “{part.said}”</p>}
            <textarea
              className="textarea"
              rows={2}
              maxLength={600}
              aria-label={`What happens in part ${index + 1}`}
              value={part.happens || ''}
              disabled={disabled}
              onChange={(e) => setPart(index, 'happens', e.target.value)}
              onBlur={flush}
            />
            <input
              className="input"
              type="text"
              maxLength={400}
              aria-label={`How part ${index + 1} is filmed`}
              placeholder="How it is filmed"
              value={part.framing || ''}
              disabled={disabled}
              onChange={(e) => setPart(index, 'framing', e.target.value)}
              onBlur={flush}
            />
          </li>
        ))}
      </ol>

      <label className="label" htmlFor={`${baseId}-cta`}>How it closes</label>
      <input
        id={`${baseId}-cta`}
        className="input"
        type="text"
        maxLength={400}
        value={value.call_to_action || ''}
        disabled={disabled}
        onChange={(e) => setField('call_to_action', e.target.value)}
        onBlur={flush}
      />
      <label className="label" htmlFor={`${baseId}-music`} style={{ marginTop: '10px' }}>Music</label>
      <input
        id={`${baseId}-music`}
        className="input"
        type="text"
        maxLength={400}
        placeholder="No music in the video"
        value={value.music_mood || ''}
        disabled={disabled}
        onChange={(e) => setField('music_mood', e.target.value)}
        onBlur={flush}
      />
      {(value.pacing || value.caption_style) && (
        <p className="field-hint">
          {value.pacing}
          {value.pacing && value.caption_style ? ' ' : ''}
          {value.caption_style ? `Captions: ${value.caption_style}` : ''}
        </p>
      )}
    </div>
  );
}

/**
 * Idea page: start from a video that works, e.g. a competitor's ad. The video is uploaded, broken
 * down into its structure (hook, parts, pacing, music, call to action) and shown next to the
 * breakdown so it can be corrected. "Use this structure" fills in the form and makes the script
 * follow the parts. Only the structure is reused: their words and frames never are.
 *
 * @param {object}   project
 * @param {string}   storagePrefix     users/{uid}/projects/{pid}
 * @param {function} onApply           (breakdown) => void. Fills in the Idea form.
 * @param {function} onBreakdownChange (breakdown) => void. Called on every edit.
 * @param {boolean}  disabled
 */
export default function ReferenceVideoCard({ project, storagePrefix = '', onApply, onBreakdownChange, disabled = false }) {
  const baseId = useId();
  const fileInput = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const reference = project?.settings?.reference || null;
  const breakdown = reference?.breakdown?.scenes?.length ? reference.breakdown : null;
  const startedAt = toMillis(project?.referenceStartedAt) || now;
  const analysing = Boolean(reference?.storageRef) && !breakdown
    && project?.referenceStatus === 'analysing' && now - startedAt < STALE_MS;
  const failed = Boolean(reference?.storageRef) && !breakdown && !analysing && !uploading;
  const inUse = Boolean(breakdown && reference.use);

  // While the video is being watched, re-check now and then so a stuck analysis is noticed.
  useEffect(() => {
    if (!analysing) return undefined;
    const interval = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(interval);
  }, [analysing]);

  const save = async (partial) => {
    setError('');
    try {
      await updateProjectSettings(project.id, partial);
    } catch (err) {
      console.error('Could not save the reference video:', err);
      setError(friendlyError(err));
    }
  };

  const analyse = async (storageRef, name) => {
    setError('');
    try {
      await analyseReference(project.id, storageRef, name);
      setNow(Date.now());
    } catch (err) {
      console.error('Could not start the breakdown:', err);
      setError(friendlyError(err));
    }
  };

  const handleFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!EXTENSIONS[file.type]) {
      setError('Use an MP4, MOV or WebM video.');
      return;
    }
    if (file.size > MAX_VIDEO_BYTES) {
      setError('That video is over 50 MB. Use a shorter or more compressed one.');
      return;
    }
    if (!storagePrefix) {
      setError('You need to be signed in to upload a video.');
      return;
    }
    setUploading(true);
    setError('');
    try {
      const path = `${storagePrefix}/reference/video_${Date.now()}.${EXTENSIONS[file.type]}`;
      const fileRef = ref(storage, path);
      await uploadBytes(fileRef, file, { contentType: file.type });
      const url = await getDownloadURL(fileRef);
      onBreakdownChange?.(null);
      await updateProjectSettings(project.id, {
        reference: { storageRef: path, url, name: file.name.slice(0, 200), breakdown: null, use: false },
      });
      await analyseReference(project.id, path, file.name.slice(0, 200));
      setNow(Date.now());
    } catch (err) {
      console.error('Reference video upload failed:', err);
      setError(friendlyError(err));
    } finally {
      setUploading(false);
    }
  };

  const remove = () => {
    if (!window.confirm('Remove the reference video and its breakdown? Your idea, settings and script stay as they are.')) return;
    onBreakdownChange?.(null);
    save({ reference: null });
  };

  const locked = disabled || uploading;

  return (
    <section className="card card-white asset-card" aria-labelledby={`${baseId}-title`}>
      <div className="asset-head">
        <div>
          <h3 className="asset-title" id={`${baseId}-title`}>
            Start from a video that works
            <span className="asset-optional">(optional)</span>
          </h3>
          <p className="asset-sub">
            Upload an ad you want to match, for example a competitor&apos;s. The app breaks down its hook, parts and
            pacing, and writes your script with the same structure. Their words and footage are never reused.
          </p>
        </div>
      </div>

      {!reference?.storageRef && (
        <div className="start-preview start-preview-empty">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileInput.current?.click()} disabled={locked}>
            {uploading ? <LoadingSpinner size="sm" label="Uploading…" /> : 'Upload a video'}
          </button>
          <p className="start-preview-text">MP4, MOV or WebM, up to 50 MB. Short ads work best (under a minute).</p>
        </div>
      )}

      {reference?.storageRef && (
        <div className="ref-layout">
          <div className="ref-video">
            {reference.url && <video src={reference.url} controls playsInline preload="metadata" aria-label="Reference video" />}
            <div className="ref-video-actions">
              <button type="button" className="link-button" onClick={() => fileInput.current?.click()} disabled={locked || analysing}>
                {uploading ? 'Uploading…' : 'Replace'}
              </button>
              <button type="button" className="link-button" onClick={remove} disabled={locked}>
                Remove
              </button>
            </div>
          </div>

          <div className="ref-main">
            {analysing && (
              <div className="music-status" role="status">
                <LoadingSpinner size="sm" />
                <span>Watching the video… This takes about a minute. You can keep filling in the page.</span>
              </div>
            )}

            {failed && (
              <div className="gen-note is-error" role="alert">
                <p style={{ marginBottom: '8px' }}>
                  The video could not be broken down{project?.referenceError ? `: ${project.referenceError}` : '.'}
                </p>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => analyse(reference.storageRef, reference.name)}
                  disabled={locked}
                >
                  Try again
                </button>
              </div>
            )}

            {breakdown && (
              <>
                <BreakdownEditor
                  key={reference.storageRef}
                  projectId={project.id}
                  breakdown={breakdown}
                  disabled={locked}
                  onChange={onBreakdownChange}
                  onError={setError}
                />
                {inUse ? (
                  <div className="gen-note" role="status">
                    <p style={{ marginBottom: '8px' }}>
                      The script will follow these {breakdown.scenes.length} parts. The hook, scene length, words per scene
                      and style were filled in from the video; change them freely.
                    </p>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => save({ 'reference.use': false })} disabled={locked}>
                      Stop following it
                    </button>
                  </div>
                ) : (
                  <div className="ref-actions">
                    <button
                      type="button"
                      id="reference-use"
                      className="btn btn-primary btn-sm"
                      disabled={locked}
                      onClick={async () => {
                        // The editor reports every edit to the parent, which applies its latest copy.
                        onApply?.();
                        await save({ 'reference.use': true });
                      }}
                    >
                      Use this structure
                    </button>
                    <p className="field-hint" style={{ margin: 0 }}>
                      Correct anything the breakdown got wrong first. This fills in the settings below; you still write
                      your own idea and add your own pictures.
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <div aria-live="polite">
        {error && <p className="gen-note is-error" role="alert">{error}</p>}
      </div>

      <input
        ref={fileInput}
        type="file"
        accept={Object.keys(EXTENSIONS).join(',')}
        onChange={handleFile}
        className="visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
      />
    </section>
  );
}
