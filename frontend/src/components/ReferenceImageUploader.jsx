import React, { useEffect, useId, useRef, useState } from 'react';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { storage } from '../services/firebase';

const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_FILE_BYTES = 20 * 1024 * 1024; // Gemini Files API friendly size
const MAX_DESCRIPTION = 200;

function makeId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function extensionFor(file) {
  if (file.type === 'image/png') return 'png';
  if (file.type === 'image/webp') return 'webp';
  return 'jpg';
}

/**
 * Upload several "context pictures" and describe what each one is in the video
 * (e.g. "The product: a matte black water bottle").
 *
 * The parent owns the list and persists it (Firestore). Each entry is
 * { id, storageRef, url, description }.
 *
 * @param {Array}    images         Current list of pictures.
 * @param {function} onChange       (nextImages) => void | Promise. Called once per add/remove/description commit.
 * @param {string}   storagePrefix  Storage folder inside users/{uid}/projects/{pid}/...
 * @param {number}   maxImages      How many pictures this list may hold.
 * @param {string}   label          Field label.
 * @param {string}   hint           Helper text under the label.
 * @param {string}   budgetNote     Optional note about the shared picture budget.
 * @param {string}   modelWarning   Optional warning (e.g. the selected model ignores pictures).
 * @param {boolean}  disabled       Disable editing.
 */
export default function ReferenceImageUploader({
  images = [],
  onChange,
  storagePrefix,
  maxImages = 6,
  label = 'Context pictures',
  hint = 'Add pictures of products, places or people that should appear, and say what each one is.',
  budgetNote = '',
  modelWarning = '',
  disabled = false,
}) {
  const baseId = useId();
  const fileInputRef = useRef(null);
  const latestImages = useRef(images);
  const [pending, setPending] = useState([]); // [{ id, previewUrl }]
  const [drafts, setDrafts] = useState({}); // id -> description being typed
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    latestImages.current = images;
  }, [images]);

  // Release object URLs of in-flight previews on unmount
  useEffect(() => () => pending.forEach((p) => URL.revokeObjectURL(p.previewUrl)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const slotsLeft = Math.max(0, maxImages - images.length - pending.length);
  const canAdd = !disabled && slotsLeft > 0 && Boolean(storagePrefix);

  const handleFiles = async (fileList) => {
    setError('');
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    const valid = [];
    const problems = [];
    for (const file of files) {
      if (!ACCEPTED_TYPES.includes(file.type)) {
        problems.push(`${file.name}: use PNG, JPG or WEBP`);
      } else if (file.size > MAX_FILE_BYTES) {
        problems.push(`${file.name}: larger than 20 MB`);
      } else {
        valid.push(file);
      }
    }

    const accepted = valid.slice(0, slotsLeft);
    if (valid.length > accepted.length) {
      problems.push(`Only ${maxImages} picture${maxImages === 1 ? '' : 's'} fit here, so ${valid.length - accepted.length} were skipped`);
    }
    if (problems.length) setError(problems.join(' · '));
    if (accepted.length === 0) return;

    const batch = accepted.map((file) => ({ id: makeId(), file, previewUrl: URL.createObjectURL(file) }));
    setPending((prev) => [...prev, ...batch.map(({ id, previewUrl }) => ({ id, previewUrl }))]);

    // Upload in parallel, then commit ONCE so concurrent uploads can't overwrite each other.
    const results = await Promise.allSettled(
      batch.map(async ({ id, file }) => {
        const storageRef = `${storagePrefix}/${id}.${extensionFor(file)}`;
        const fileRef = ref(storage, storageRef);
        await uploadBytes(fileRef, file, { contentType: file.type });
        const url = await getDownloadURL(fileRef);
        return { id, storageRef, url, description: '' };
      })
    );

    const uploaded = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const failed = results.length - uploaded.length;

    try {
      if (uploaded.length) await onChange?.([...latestImages.current, ...uploaded]);
      if (failed) setError(`${failed} picture${failed === 1 ? '' : 's'} failed to upload. Please try again.`);
    } catch (err) {
      console.error('Saving context pictures failed:', err);
      setError('Could not save the pictures. Please try again.');
    } finally {
      batch.forEach(({ previewUrl }) => URL.revokeObjectURL(previewUrl));
      setPending((prev) => prev.filter((p) => !batch.some((b) => b.id === p.id)));
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const commitDescription = async (id) => {
    if (!(id in drafts)) return;
    const value = drafts[id].trim().slice(0, MAX_DESCRIPTION);
    const current = latestImages.current.find((img) => img.id === id);
    setDrafts((prev) => {
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });
    if (!current || (current.description || '') === value) return;
    try {
      await onChange?.(latestImages.current.map((img) => (img.id === id ? { ...img, description: value } : img)));
    } catch (err) {
      console.error('Saving description failed:', err);
      setError('Could not save the description. Please try again.');
    }
  };

  const removeImage = async (id) => {
    setError('');
    try {
      await onChange?.(latestImages.current.filter((img) => img.id !== id));
    } catch (err) {
      console.error('Removing picture failed:', err);
      setError('Could not remove the picture. Please try again.');
    }
  };

  const onDragOver = (e) => {
    e.preventDefault();
    if (canAdd) setIsDragging(true);
  };
  const onDragLeave = (e) => {
    e.preventDefault();
    setIsDragging(false);
  };
  const onDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (canAdd) handleFiles(e.dataTransfer.files);
  };

  const used = images.length + pending.length;
  const missingDescriptions = images.filter((img) => !(drafts[img.id] ?? img.description ?? '').trim()).length;

  return (
    <div className="ref-uploader">
      <div className="ref-uploader-head">
        <div>
          <span className="label" style={{ marginBottom: 2 }}>{label}</span>
          {hint && <p className="ref-uploader-hint">{hint}</p>}
        </div>
        <span className={`ref-count ${used >= maxImages ? 'is-full' : ''}`} aria-live="polite">
          {used}/{maxImages}
        </span>
      </div>

      {modelWarning && (images.length > 0 || pending.length > 0) && (
        <div className="ref-note ref-note-warning" role="note">{modelWarning}</div>
      )}

      <input
        ref={fileInputRef}
        id={`${baseId}-file`}
        type="file"
        multiple
        accept={ACCEPTED_TYPES.join(',')}
        className="visually-hidden"
        onChange={(e) => handleFiles(e.target.files)}
        disabled={!canAdd}
        tabIndex={-1}
      />

      <ul className="ref-grid" aria-label={label}>
        {images.map((img, i) => {
          const value = drafts[img.id] ?? img.description ?? '';
          const inputId = `${baseId}-desc-${img.id}`;
          return (
            <li key={img.id || img.storageRef} className="ref-item">
              <div className="ref-thumb">
                <img src={img.url} alt={img.description || `Context picture ${i + 1}`} loading="lazy" />
                {!disabled && (
                  <button
                    type="button"
                    className="ref-remove"
                    onClick={() => removeImage(img.id)}
                    aria-label={`Remove ${img.description || `picture ${i + 1}`}`}
                    title="Remove picture"
                  >
                    ×
                  </button>
                )}
              </div>
              <label htmlFor={inputId} className="visually-hidden">
                What is picture {i + 1}?
              </label>
              <input
                id={inputId}
                className={`input ref-desc ${value.trim() ? '' : 'is-empty'}`}
                type="text"
                value={value}
                maxLength={MAX_DESCRIPTION}
                placeholder="What is this? e.g. The product"
                disabled={disabled}
                onChange={(e) => setDrafts((prev) => ({ ...prev, [img.id]: e.target.value }))}
                onBlur={() => commitDescription(img.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    e.currentTarget.blur();
                  }
                }}
              />
            </li>
          );
        })}

        {pending.map((p) => (
          <li key={p.id} className="ref-item is-uploading" aria-busy="true">
            <div className="ref-thumb">
              <img src={p.previewUrl} alt="" />
              <span className="ref-uploading-overlay">
                <span className="ref-spinner" aria-hidden="true" />
                Uploading…
              </span>
            </div>
            <div className="ref-desc-skeleton" />
          </li>
        ))}

        {canAdd && (
          <li className="ref-item">
            <button
              type="button"
              className={`ref-add ${isDragging ? 'is-dragging' : ''}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span className="ref-add-title">Add pictures</span>
              <span className="ref-add-sub">Drop or browse · {slotsLeft} left</span>
            </button>
          </li>
        )}
      </ul>

      {!canAdd && !disabled && maxImages === 0 && (
        <div className="ref-note" role="note">No picture slots left for this scene.</div>
      )}
      {budgetNote && <p className="ref-uploader-hint" style={{ marginTop: 8 }}>{budgetNote}</p>}
      {missingDescriptions > 0 && (
        <p className="ref-uploader-hint ref-hint-warning">
          {missingDescriptions === 1 ? '1 picture has' : `${missingDescriptions} pictures have`} no description. Describing each one
          helps the AI use it correctly.
        </p>
      )}
      {error && (
        <div className="ref-note ref-note-error" role="alert">{error}</div>
      )}
    </div>
  );
}
