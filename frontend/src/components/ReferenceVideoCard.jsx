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
            <textarea
              className="textarea is-line"
              rows={1}
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
      <textarea
        id={`${baseId}-cta`}
        className="textarea is-line"
        rows={1}
        maxLength={400}
        value={value.call_to_action || ''}
        disabled={disabled}
        onChange={(e) => setField('call_to_action', e.target.value)}
        onBlur={flush}
      />
      <label className="label" htmlFor={`${baseId}-music`} style={{ marginTop: '10px' }}>Music</label>
      <textarea
        id={`${baseId}-music`}
        className="textarea is-line"
        rows={1}
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

const STEPS = [
  { title: 'Upload their ad', text: 'A competitor’s video, or any ad you want to match.' },
  { title: 'See why it works', text: 'Its hook, parts, pacing and style, laid out for you.' },
  { title: 'Get your version', text: 'Your script follows the same structure, in your words.' },
];

/**
 * Idea page, at the top: start from a video that works, e.g. a competitor's ad. The video is
 * uploaded and broken down into its structure (hook, parts, pacing, music, call to action). When the
 * breakdown arrives while the page is open it fills in the form by itself and the script follows
 * its parts; the breakdown stays editable under "Review the breakdown". Only the structure is
 * reused: their words and frames never are.
 *
 * @param {object}   project
 * @param {string}   storagePrefix     users/{uid}/projects/{pid}
 * @param {function} onApply           () => void. Fills in the Idea form from the breakdown.
 * @param {function} onBreakdownChange (breakdown) => void. Called on every edit.
 * @param {string[]} filled            What the form currently holds from the video, e.g. ["5 scenes"].
 * @param {boolean}  disabled
 */
export default function ReferenceVideoCard({ project, storagePrefix = '', onApply, onBreakdownChange, filled = [], disabled = false }) {
  const baseId = useId();
  const fileInput = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const reference = project?.settings?.reference || null;
  const hasVideo = Boolean(reference?.storageRef);
  const breakdown = reference?.breakdown?.scenes?.length ? reference.breakdown : null;
  const startedAt = toMillis(project?.referenceStartedAt) || now;
  const analysing = hasVideo && !breakdown
    && project?.referenceStatus === 'analysing' && now - startedAt < STALE_MS;
  const failed = hasVideo && !breakdown && !analysing && !uploading;
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

  const follow = async () => {
    // The editor reports every edit to the parent, which applies its latest copy.
    onApply?.();
    await save({ 'reference.use': true });
  };

  // A breakdown that arrives while this page is waiting for it is put to use straight away: the
  // form is filled in and the script follows it. One that was already there when the page opened
  // is left alone, so "Stop following it" stays stopped.
  const waiting = useRef(false);
  const followRef = useRef(follow);
  useEffect(() => {
    followRef.current = follow;
  });
  useEffect(() => {
    if (uploading || analysing) {
      waiting.current = true;
      return;
    }
    if (!waiting.current) return;
    waiting.current = false;
    if (breakdown && !reference.use) followRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploading, analysing, Boolean(breakdown)]);

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

  const upload = async (file) => {
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

  const handleFile = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    upload(file);
  };

  const remove = () => {
    if (!window.confirm('Remove the reference video and its breakdown? Your idea, settings and script stay as they are.')) return;
    onBreakdownChange?.(null);
    save({ reference: null });
  };

  const locked = disabled || uploading;
  const dropProps = locked ? {} : {
    onDragOver: (event) => {
      event.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (event) => {
      event.preventDefault();
      setDragging(false);
      upload(event.dataTransfer?.files?.[0]);
    },
  };

  return (
    <section
      className={`card ref-hero ${hasVideo ? 'has-video' : ''} ${dragging ? 'is-dragging' : ''}`}
      aria-labelledby={`${baseId}-title`}
      {...(hasVideo ? {} : dropProps)}
    >
      {!hasVideo && (
        <>
          <div className="ref-hero-pitch">
            <p className="ref-hero-eyebrow">Optional shortcut</p>
            <h2 className="ref-hero-title" id={`${baseId}-title`}>Start from an ad that already works</h2>
            <p className="ref-hero-sub">
              Upload a competitor&apos;s video and get your own version of it. Only the structure is reused: their
              words and footage never are.
            </p>
            <div className="ref-hero-cta">
              <button type="button" id="reference-upload" className="btn btn-primary" onClick={() => fileInput.current?.click()} disabled={locked}>
                {uploading ? <LoadingSpinner size="sm" label="Uploading…" /> : 'Upload a video'}
              </button>
              <p className="ref-hero-hint">or drop it here · MP4, MOV or WebM, up to 50 MB · under a minute works best</p>
            </div>
          </div>
          <ol className="ref-hero-steps" aria-label="How it works">
            {STEPS.map((step, index) => (
              <li key={step.title} className="ref-hero-step">
                <span className="ref-hero-step-number" aria-hidden="true">{index + 1}</span>
                <span className="ref-hero-step-title">{step.title}</span>
                <span className="ref-hero-step-text">{step.text}</span>
              </li>
            ))}
          </ol>
        </>
      )}

      {hasVideo && (
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
            <div>
              <p className="ref-hero-eyebrow">Reference video</p>
              <h2 className="ref-hero-title is-small" id={`${baseId}-title`}>
                {inUse
                  ? `Your script follows this video’s ${breakdown.scenes.length} parts`
                  : breakdown ? 'The breakdown is ready' : analysing ? 'Watching the video' : 'Start from an ad that already works'}
              </h2>
              {breakdown?.summary && <p className="ref-summary">{breakdown.summary}</p>}
            </div>

            {analysing && (
              <div className="music-status" role="status">
                <LoadingSpinner size="sm" />
                <span>
                  This takes about a minute. The scenes, hook and style below are filled in for you when it is done;
                  meanwhile, write your idea and add your pictures.
                </span>
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

            {breakdown && inUse && (
              <div className="ref-filled" role="status">
                <p className="ref-filled-label">Filled in from the video. Change anything below.</p>
                {filled.length > 0 && (
                  <ul className="ref-filled-list" aria-label="Filled in from the video">
                    {filled.map((item) => <li key={item} className="ref-chip">{item}</li>)}
                  </ul>
                )}
                <p className="ref-filled-todo">Still yours to add: your idea, the person and your product.</p>
                <button type="button" className="link-button" onClick={() => save({ 'reference.use': false })} disabled={locked}>
                  Stop following it
                </button>
              </div>
            )}

            {breakdown && !inUse && (
              <div className="ref-actions">
                <button type="button" id="reference-use" className="btn btn-primary btn-sm" disabled={locked} onClick={follow}>
                  Use this structure
                </button>
                <p className="field-hint" style={{ margin: 0 }}>
                  Fills in the scenes, hook and style below and makes the script follow these parts. You still write
                  your own idea and add your own pictures.
                </p>
              </div>
            )}

            {breakdown && (
              <details className="ref-review">
                <summary>Review the breakdown · {breakdown.scenes.length} {breakdown.scenes.length === 1 ? 'part' : 'parts'}</summary>
                <BreakdownEditor
                  key={reference.storageRef}
                  projectId={project.id}
                  breakdown={breakdown}
                  disabled={locked}
                  onChange={onBreakdownChange}
                  onError={setError}
                />
              </details>
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
