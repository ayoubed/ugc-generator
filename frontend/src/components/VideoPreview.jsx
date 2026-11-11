import React, { useState, useEffect } from 'react';
import { resolveStorageUrl } from '../services/api';
import LoadingSpinner from './LoadingSpinner';

/**
 * Minimal HTML5 video player component that resolves Firebase Storage paths
 * via getDownloadURL if not already a full URL.
 * @param {string} src - Storage path or direct video URL
 * @param {string} poster - Optional poster thumbnail
 * @param {string} className - Optional container styling
 * @param {string} aspectRatio - '9/16' | '16/9' or css aspect-ratio
 */
export default function VideoPreview({
  src,
  poster = '',
  className = '',
  style = {},
  aspectRatio = '9/16',
  autoPlay = false,
  loop = false,
  muted = false,
}) {
  const [resolvedUrl, setResolvedUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    if (!src) return;

    resolveStorageUrl(src)
      .then((url) => {
        if (active) {
          setResolvedUrl(url);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (active) {
          console.error('Error resolving video preview URL:', err);
          setError('Could not load video');
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [src]);

  if (!src) {
    return (
      <div
        className={className}
        style={{
          width: '100%',
          aspectRatio,
          backgroundColor: '#0f172a',
          borderRadius: 'var(--radius-card)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-tertiary)',
          gap: '8px',
          border: '1px solid var(--color-border)',
        }}
      >
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <polygon points="5 3 19 12 5 21 5 3"></polygon>
        </svg>
        <span style={{ fontSize: '0.8125rem' }}>No video available</span>
      </div>
    );
  }

  return (
    <div
      className={className}
      style={{
        width: '100%',
        maxWidth: '100%',
        position: 'relative',
        backgroundColor: '#000000',
        borderRadius: 'var(--radius-card)',
        overflow: 'hidden',
        border: '1px solid var(--color-border)',
        boxShadow: 'var(--shadow-sm)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        aspectRatio,
        ...style,
      }}
    >
      {loading && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(15, 23, 42, 0.75)',
            zIndex: 10,
            color: '#ffffff',
            gap: '8px',
          }}
        >
          <LoadingSpinner size="md" />
          <span style={{ fontSize: '0.8125rem' }}>Loading video...</span>
        </div>
      )}

      {error ? (
        <div style={{ color: 'var(--color-error)', fontSize: '0.875rem', padding: '16px', textAlign: 'center' }}>
          {error}
        </div>
      ) : resolvedUrl ? (
        <video
          src={resolvedUrl}
          poster={poster}
          controls
          autoPlay={autoPlay}
          loop={loop}
          muted={muted}
          playsInline
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            display: 'block',
          }}
        />
      ) : null}
    </div>
  );
}
