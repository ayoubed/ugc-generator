import React, { useEffect, useId, useRef, useState } from 'react';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { storage } from '../services/firebase';
import { updateProjectSettings } from '../hooks/useProject';
import { friendlyError } from '../utils/errors';
import { END_CARD_SECONDS, projectEndCard } from '../utils/projectProgress';

const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const SAVE_DELAY_MS = 700;

/**
 * Optional closing card, added after the last scene when the video is stitched: a real product
 * picture with a headline and a smaller line (offer, link, handle). Generated scenes can get a
 * label wrong; this frame is always right.
 *
 * @param {object}  project
 * @param {string}  storagePrefix users/{uid}/projects/{pid}
 * @param {boolean} disabled
 */
export default function EndCardCard({ project, storagePrefix = '', disabled = false }) {
  const baseId = useId();
  const fileInputRef = useRef(null);
  const card = projectEndCard(project);
  const [headline, setHeadline] = useState(card.headline);
  const [subline, setSubline] = useState(card.subline);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef(null);
  const pending = useRef(null);

  const save = async (partial) => {
    setError('');
    try {
      await updateProjectSettings(project.id, partial);
    } catch (err) {
      console.error('Could not save the end card:', err);
      setError(friendlyError(err));
    }
  };

  // Text is saved a moment after typing stops, and right away when the card goes away.
  const flush = () => {
    clearTimeout(timer.current);
    if (pending.current) {
      const partial = pending.current;
      pending.current = null;
      save(partial);
    }
  };
  const saveSoon = (partial) => {
    pending.current = { ...(pending.current || {}), ...partial };
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DELAY_MS);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => flush, []);

  const handleFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError('Use a PNG, JPG or WebP picture.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError('That picture is over 20 MB. Use a smaller one.');
      return;
    }
    if (!storagePrefix) {
      setError('You need to be signed in to upload pictures.');
      return;
    }
    try {
      setUploading(true);
      setError('');
      const path = `${storagePrefix}/end_card_${Date.now()}.${EXTENSIONS[file.type]}`;
      const fileRef = ref(storage, path);
      await uploadBytes(fileRef, file, { contentType: file.type });
      const url = await getDownloadURL(fileRef);
      await updateProjectSettings(project.id, {
        'endCard.imageRef': path,
        'endCard.imageUrl': url,
        'endCard.enabled': true,
      });
    } catch (err) {
      console.error('End card picture upload failed:', err);
      setError('The upload failed. Check your connection and try again.');
    } finally {
      setUploading(false);
    }
  };

  const locked = disabled || uploading;
  const on = card.enabled && Boolean(card.imageRef);

  return (
    <section className="card card-white music-card" aria-labelledby={`${baseId}-title`}>
      <div className="music-head">
        <span className="music-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="3" width="14" height="18" rx="2" />
            <line x1="9" y1="15" x2="15" y2="15" />
            <line x1="10" y1="18" x2="14" y2="18" />
          </svg>
        </span>
        <div>
          <h2 className="music-title" id={`${baseId}-title`}>End card</h2>
          <p className="music-sub">
            A closing frame with your real product picture and a call to action, added after the last scene.
            The music carries through it.
          </p>
        </div>
      </div>

      {card.imageRef ? (
        <>
          <div className="start-preview end-preview">
            {card.imageUrl && <img src={card.imageUrl} alt="End card picture" />}
            <p className="start-preview-text">
              {on ? 'The video ends on this picture.' : 'The end card is off. The picture is kept in case you turn it back on.'}
            </p>
            <div className="start-preview-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => fileInputRef.current?.click()} disabled={locked}>
                {uploading ? 'Uploading…' : 'Replace'}
              </button>
            </div>
          </div>

          <label className="gen-run-option" htmlFor={`${baseId}-on`} style={{ marginTop: '12px' }}>
            <input
              type="checkbox"
              id={`${baseId}-on`}
              checked={on}
              disabled={locked}
              onChange={(e) => save({ 'endCard.enabled': e.target.checked })}
            />
            Add the end card to the video
          </label>

          {on && (
            <div className="end-card-fields">
              <label className="label" htmlFor={`${baseId}-headline`}>Headline</label>
              <input
                id={`${baseId}-headline`}
                className="input"
                type="text"
                maxLength={80}
                placeholder="e.g. GLOWLEAF Revitalising Serum"
                value={headline}
                disabled={disabled}
                onChange={(e) => { setHeadline(e.target.value); saveSoon({ 'endCard.headline': e.target.value }); }}
                onBlur={flush}
              />
              <label className="label" htmlFor={`${baseId}-subline`}>Smaller line</label>
              <input
                id={`${baseId}-subline`}
                className="input"
                type="text"
                maxLength={120}
                placeholder="e.g. Link in bio · 20% off this week"
                value={subline}
                disabled={disabled}
                onChange={(e) => { setSubline(e.target.value); saveSoon({ 'endCard.subline': e.target.value }); }}
                onBlur={flush}
              />
              <label className="label" htmlFor={`${baseId}-seconds`}>Shown for</label>
              <select
                id={`${baseId}-seconds`}
                className="input"
                value={String(card.seconds)}
                disabled={disabled}
                onChange={(e) => save({ 'endCard.seconds': Number(e.target.value) })}
              >
                {END_CARD_SECONDS.map((s) => (
                  <option key={s} value={String(s)}>{s} seconds</option>
                ))}
              </select>
              <p className="field-hint">Leave both lines empty to show the picture alone. Stitch again to see the card.</p>
            </div>
          )}
        </>
      ) : (
        <div className="start-preview start-preview-empty end-preview">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileInputRef.current?.click()} disabled={locked}>
            {uploading ? 'Uploading…' : 'Add product picture'}
          </button>
          <p className="start-preview-text">PNG, JPG or WebP, up to 20 MB. A clean packshot works best.</p>
        </div>
      )}

      <div aria-live="polite">
        {error && <p className="gen-note is-error" role="alert">{error}</p>}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_TYPES.join(',')}
        onChange={handleFile}
        className="visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
      />
    </section>
  );
}
