import React, { useRef, useState } from 'react';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { storage } from '../services/firebase';

const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/**
 * Optional picture a scene's video must end on (e.g. the product held up to the camera).
 * The video model fills in the movement between the starting picture and this one.
 *
 * @param {string}   imageUrl      Download URL of the end picture ('' when none)
 * @param {string}   storagePrefix Storage folder (users/{uid}/projects/{pid}/scenes/{id})
 * @param {function} onChange      ({ ref, url } | null) => Promise|void. The parent saves it.
 * @param {function} onBusyChange  Optional (isUploading) => void
 * @param {boolean}  disabled
 */
export default function EndPicturePicker({ imageUrl = '', storagePrefix = '', onChange, onBusyChange, disabled = false }) {
  const fileInputRef = useRef(null);
  const [uploading, setUploadingState] = useState(false);
  const [error, setError] = useState('');

  const setUploading = (value) => {
    setUploadingState(value);
    onBusyChange?.(value);
  };

  const openFilePicker = () => {
    setError('');
    fileInputRef.current?.click();
  };

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
      const path = `${storagePrefix}/end_${Date.now()}.${EXTENSIONS[file.type]}`;
      const fileRef = ref(storage, path);
      await uploadBytes(fileRef, file, { contentType: file.type });
      const url = await getDownloadURL(fileRef);
      await onChange?.({ ref: path, url });
    } catch (err) {
      console.error('End picture upload failed:', err);
      setError('The upload failed. Check your connection and try again.');
    } finally {
      setUploading(false);
    }
  };

  const remove = async () => {
    setError('');
    try {
      await onChange?.(null);
    } catch (err) {
      console.error('Could not remove the end picture:', err);
      setError('Could not remove the picture. Try again.');
    }
  };

  return (
    <div className="start-picker-wrap">
      {imageUrl ? (
        <div className="start-preview end-preview">
          <img src={imageUrl} alt="Picture this scene ends on" />
          <p className="start-preview-text">
            The next take ends on this picture. Say in the prompt how the scene gets there.
          </p>
          <div className="start-preview-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={openFilePicker} disabled={disabled || uploading}>
              Replace
            </button>
            <button type="button" className="btn btn-ghost btn-sm start-remove" onClick={remove} disabled={disabled || uploading}>
              Remove
            </button>
          </div>
        </div>
      ) : (
        <div className="start-preview start-preview-empty end-preview">
          <button type="button" className="btn btn-secondary btn-sm" onClick={openFilePicker} disabled={disabled || uploading}>
            {uploading ? 'Uploading…' : 'Add end picture'}
          </button>
          <p className="start-preview-text">
            For a product reveal: upload the exact shot the scene should finish on, and the video is made to arrive there.
          </p>
        </div>
      )}

      {uploading && imageUrl && <p className="start-note">Uploading the new picture…</p>}
      <div aria-live="polite">
        {error && <p className="start-note start-note-error">{error}</p>}
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
