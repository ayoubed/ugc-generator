import React, { useState, useRef } from 'react';

/**
 * ImageUpload component with drag-and-drop zone and thumbnail preview.
 * @param {function} onUpload - Callback (file: File) => void
 * @param {string} previewUrl - Initial or current image URL / Storage path
 * @param {function} onRemove - Optional remove callback
 */
export default function ImageUpload({
  onUpload,
  previewUrl = '',
  onRemove,
  label = 'Starting Image of Person',
  description = 'Upload a high-quality photo of the UGC creator or person speaking',
}) {
  const [isDragging, setIsDragging] = useState(false);
  const [localPreview, setLocalPreview] = useState('');
  const fileInputRef = useRef(null);

  const displayUrl = localPreview || previewUrl;

  const handleFiles = (files) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!file.type.match(/^image\/(jpeg|jpg|png|webp)/)) {
      alert('Please upload a valid PNG or JPG image.');
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setLocalPreview(objectUrl);
    onUpload?.(file);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  };

  const handleClear = (e) => {
    e.stopPropagation();
    setLocalPreview('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    onRemove?.();
  };

  return (
    <div className="form-group">
      {label && <label className="label">{label}</label>}
      {description && (
        <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', marginBottom: '8px' }}>
          {description}
        </p>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/jpg,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => handleFiles(e.target.files)}
      />

      {displayUrl ? (
        <div
          style={{
            position: 'relative',
            borderRadius: 'var(--radius-card)',
            border: '1px solid var(--color-border)',
            overflow: 'hidden',
            backgroundColor: 'var(--bg-card)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '12px',
          }}
        >
          <img
            src={displayUrl}
            alt="Uploaded preview"
            style={{
              maxHeight: '220px',
              maxWidth: '100%',
              borderRadius: '8px',
              objectFit: 'contain',
              boxShadow: 'var(--shadow-sm)',
            }}
          />
          <div
            style={{
              position: 'absolute',
              bottom: '16px',
              right: '16px',
              display: 'flex',
              gap: '8px',
            }}
          >
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => fileInputRef.current?.click()}
            >
              Replace
            </button>
            {onRemove && (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={handleClear}
              >
                Remove
              </button>
            )}
          </div>
        </div>
      ) : (
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          style={{
            border: `2px dashed ${isDragging ? 'var(--color-accent)' : 'var(--color-border)'}`,
            borderRadius: 'var(--radius-card)',
            backgroundColor: isDragging ? 'var(--color-accent-light)' : '#ffffff',
            padding: '32px 16px',
            textAlign: 'center',
            cursor: 'pointer',
            transition: 'all var(--transition-fast)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
          }}
        >
          <div
            style={{
              width: '44px',
              height: '44px',
              borderRadius: '50%',
              backgroundColor: 'var(--color-accent-light)',
              color: 'var(--color-accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '4px',
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </div>
          <span style={{ fontSize: '0.9375rem', fontWeight: 500, color: 'var(--text-primary)' }}>
            Drop image here or click to browse
          </span>
          <span style={{ fontSize: '0.8125rem', color: 'var(--text-tertiary)' }}>
            Supports PNG, JPG (up to 50MB)
          </span>
        </div>
      )}
    </div>
  );
}
