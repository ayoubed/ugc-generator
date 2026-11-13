import React, { useId, useRef, useState } from 'react';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { storage } from '../services/firebase';

const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/**
 * Lets the user choose which picture a scene's video starts from.
 * Used on both the Edit Scenes and Generate pages so the choice is the same everywhere.
 *
 * @param {boolean}  isFirst             First scene (has no previous scene to continue from)
 * @param {string}   previousLabel       e.g. "Scene 2"
 * @param {boolean}  previousHasVideo    Whether the previous scene has a video to take a frame from
 * @param {string}   value               'creator' | 'last_frame' | 'extend' | 'ai_cut' | 'uploaded'
 * @param {function} onChange            (source) => void
 * @param {string}   creatorImageUrl     Download URL of the creator photo from Step 1
 * @param {string}   customImageUrl      Download URL of this scene's custom picture
 * @param {string}   storagePrefix       Storage folder for custom pictures (users/{uid}/projects/{pid}/scenes/{id})
 * @param {function} onCustomImageChange ({ ref, url } | null) => Promise|void. The parent saves it.
 * @param {function} onBusyChange        Optional (isUploading) => void, so the parent can hold off generating
 * @param {boolean}  disabled
 */
export default function StartPicturePicker({
  isFirst = false,
  previousLabel = 'the previous scene',
  previousHasVideo = false,
  value,
  onChange,
  creatorImageUrl = '',
  productLed = false,
  customImageUrl = '',
  storagePrefix = '',
  onCustomImageChange,
  onBusyChange,
  disabled = false,
}) {
  const baseId = useId();
  const fileInputRef = useRef(null);
  const [uploading, setUploadingState] = useState(false);
  const [uploadError, setUploadError] = useState('');

  const setUploading = (value) => {
    setUploadingState(value);
    onBusyChange?.(value);
  };

  const options = [
    productLed
      ? { value: 'creator', title: 'Product picture', sub: 'The first product picture from Step 1' }
      : { value: 'creator', title: 'Creator photo', sub: 'The photo from Step 1' },
    ...(isFirst
      ? []
      : [
          { value: 'last_frame', title: `Continue ${previousLabel}`, sub: 'Its last frame, so the scenes flow' },
          { value: 'extend', title: 'Same shot, keep rolling', sub: `${previousLabel}'s video is continued, no cut` },
          { value: 'ai_cut', title: 'Camera cut', sub: 'Same moment, drawn from a new camera angle' },
        ]),
    { value: 'uploaded', title: 'Custom picture', sub: 'Upload one for this scene' },
  ];

  const openFilePicker = () => {
    setUploadError('');
    fileInputRef.current?.click();
  };

  const handleFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    if (!ACCEPTED_TYPES.includes(file.type)) {
      setUploadError('Use a PNG, JPG or WebP picture.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setUploadError('That picture is over 20 MB. Use a smaller one.');
      return;
    }
    if (!storagePrefix) {
      setUploadError('You need to be signed in to upload pictures.');
      return;
    }

    try {
      setUploading(true);
      setUploadError('');
      const path = `${storagePrefix}/start_${Date.now()}.${EXTENSIONS[file.type]}`;
      const fileRef = ref(storage, path);
      await uploadBytes(fileRef, file, { contentType: file.type });
      const url = await getDownloadURL(fileRef);
      await onCustomImageChange?.({ ref: path, url });
    } catch (err) {
      console.error('Starting picture upload failed:', err);
      setUploadError('The upload failed. Check your connection and try again.');
    } finally {
      setUploading(false);
    }
  };

  const removeCustom = async () => {
    setUploadError('');
    try {
      await onCustomImageChange?.(null);
    } catch (err) {
      console.error('Could not remove the starting picture:', err);
      setUploadError('Could not remove the picture. Try again.');
    }
  };

  let preview = null;
  if (value === 'creator') {
    preview = creatorImageUrl ? (
      <div className="start-preview">
        <img src={creatorImageUrl} alt="Creator photo" />
        <p className="start-preview-text">The video starts from the creator photo you added in Step 1.</p>
      </div>
    ) : (
      <p className="start-note start-note-warning">
        There's no creator photo yet. Add one in Step 1, or upload a custom picture for this scene.
      </p>
    );
  } else if (value === 'last_frame' || value === 'ai_cut' || value === 'extend') {
    const what = {
      ai_cut: `Takes the last frame of ${previousLabel}'s current take and redraws it from a new camera position, posed for what this scene shows. Same person, products and room.`,
      extend: `The video model keeps filming from where ${previousLabel}'s current take ends, so movement, voice and light carry over. Best when nothing cuts between the two scenes. One continuous shot can be 30 seconds at most; context pictures and an end picture are not used.`,
      last_frame: `Takes the sharpest of the last frames of ${previousLabel}'s current take, so this scene continues where it ends.`,
    }[value];
    preview = (
      <>
        <div className="start-preview">
          <p className="start-preview-text">{what}</p>
        </div>
        {!previousHasVideo && (
          <p className="start-note start-note-warning">
            {previousLabel} has no video yet. Generate it first, or pick another starting picture.
          </p>
        )}
      </>
    );
  } else if (value === 'uploaded') {
    preview = customImageUrl ? (
      <div className="start-preview">
        <img src={customImageUrl} alt="Custom starting picture for this scene" />
        <p className="start-preview-text">This scene starts from your picture.</p>
        <div className="start-preview-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={openFilePicker}
            disabled={disabled || uploading}
          >
            Replace
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm start-remove"
            onClick={removeCustom}
            disabled={disabled || uploading}
          >
            Remove
          </button>
        </div>
      </div>
    ) : (
      <div className="start-preview start-preview-empty">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={openFilePicker}
          disabled={disabled || uploading}
        >
          {uploading ? 'Uploading…' : 'Upload picture'}
        </button>
        <p className="start-preview-text">
          PNG, JPG or WebP, up to 20 MB. Until you add one, the creator photo is used.
        </p>
      </div>
    );
  }

  return (
    <div className="start-picker-wrap">
      <fieldset className="start-picker" disabled={disabled}>
        <legend className="visually-hidden">Starting picture</legend>
        {options.map((option) => {
          const inputId = `${baseId}-${option.value}`;
          return (
            <label key={option.value} className="start-option" htmlFor={inputId}>
              <input
                type="radio"
                id={inputId}
                name={`${baseId}-start`}
                value={option.value}
                checked={value === option.value}
                onChange={() => onChange?.(option.value)}
              />
              <span className="start-option-title">{option.title}</span>
              <span className="start-option-sub">{option.sub}</span>
            </label>
          );
        })}
      </fieldset>

      {preview}

      {uploading && customImageUrl && <p className="start-note">Uploading the new picture…</p>}
      <div aria-live="polite">
        {uploadError && <p className="start-note start-note-error">{uploadError}</p>}
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
    </div>
  );
}
