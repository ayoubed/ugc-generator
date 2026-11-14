import React, { useId, useRef, useState } from 'react';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { storage } from '../services/firebase';
import { updateProjectSettings } from '../hooks/useProject';
import { editEndCard } from '../services/api';
import { friendlyError } from '../utils/errors';
import { END_CARD_SECONDS, projectEndCard } from '../utils/projectProgress';

const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/**
 * Optional closing card, added after the last scene when the video is stitched: one picture, shown
 * as it is. The picture is uploaded, and can then be changed with a short prompt (a new
 * background, a line of text): whatever the card says is part of the picture itself.
 *
 * @param {object}  project
 * @param {string}  storagePrefix users/{uid}/projects/{pid}
 * @param {boolean} disabled
 */
export default function EndCardCard({ project, storagePrefix = '', disabled = false }) {
  const baseId = useId();
  const fileInputRef = useRef(null);
  const card = projectEndCard(project);
  const [uploading, setUploading] = useState(false);
  const [changing, setChanging] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [error, setError] = useState('');

  const save = async (partial) => {
    setError('');
    try {
      await updateProjectSettings(project.id, partial);
    } catch (err) {
      console.error('Could not save the end card:', err);
      setError(friendlyError(err));
    }
  };

  const change = async (event) => {
    event.preventDefault();
    if (!instruction.trim()) return;
    setError('');
    setChanging(true);
    try {
      await editEndCard(project.id, instruction);
      setInstruction('');
    } catch (err) {
      setError(err?.message || 'Could not change the picture. Try again.');
    } finally {
      setChanging(false);
    }
  };

  // Puts back the picture the last prompt change replaced.
  const undo = () => save({
    'endCard.imageRef': card.previous.imageRef,
    'endCard.imageUrl': card.previous.imageUrl,
    'endCard.previous': null,
  });

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
        'endCard.previous': null,
        'endCard.enabled': true,
      });
    } catch (err) {
      console.error('End card picture upload failed:', err);
      setError('The upload failed. Check your connection and try again.');
    } finally {
      setUploading(false);
    }
  };

  const locked = disabled || uploading || changing;
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
            A closing picture, added after the last scene. Upload one, then change it with a prompt if you
            like. The music carries through it.
          </p>
        </div>
      </div>

      {card.imageRef ? (
        <>
          <div className="start-preview end-preview">
            {card.imageUrl && <img src={card.imageUrl} alt="End card picture" />}
            <p className="start-preview-text">
              {changing
                ? 'Changing the picture…'
                : on ? 'The video ends on this picture.' : 'The end card is off. The picture is kept in case you turn it back on.'}
            </p>
            <div className="start-preview-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => fileInputRef.current?.click()} disabled={locked}>
                {uploading ? 'Uploading…' : 'Replace'}
              </button>
              {card.previous && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={undo} disabled={locked}>
                  Undo the last change
                </button>
              )}
            </div>
          </div>

          <form className="board-change" onSubmit={change} style={{ marginTop: '12px' }}>
            <label className="label" htmlFor={`${baseId}-change`}>Change the picture with a prompt</label>
            <div className="board-change-row">
              <input
                id={`${baseId}-change`}
                className="input"
                type="text"
                maxLength={400}
                placeholder="e.g. put it on dark marble, and write “Link in bio” under it"
                value={instruction}
                disabled={locked}
                onChange={(e) => setInstruction(e.target.value)}
              />
              <button type="submit" className="btn btn-secondary" disabled={locked || !instruction.trim()}>
                {changing ? 'Changing…' : 'Change'}
              </button>
            </div>
          </form>

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
              <p className="field-hint">The picture is shown as it is. Stitch again to see the card.</p>
            </div>
          )}
        </>
      ) : (
        <div className="start-preview start-preview-empty end-preview">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileInputRef.current?.click()} disabled={locked}>
            {uploading ? 'Uploading…' : 'Add a picture'}
          </button>
          <p className="start-preview-text">PNG, JPG or WebP, up to 20 MB. A picture shaped like the video fills the frame.</p>
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
