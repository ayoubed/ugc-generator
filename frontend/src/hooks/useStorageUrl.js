import { useEffect, useState } from 'react';
import { resolveStorageUrl } from '../services/api';

/**
 * Resolves a Firebase Storage path (or passes through an http URL) to a usable URL.
 * Returns '' while loading, when the path is empty, or when the file can't be found.
 */
export function useStorageUrl(pathOrUrl) {
  const [resolved, setResolved] = useState({ key: '', url: '' });

  useEffect(() => {
    if (!pathOrUrl || /^https?:\/\//i.test(pathOrUrl)) return undefined;
    let active = true;
    resolveStorageUrl(pathOrUrl)
      .then((url) => {
        // resolveStorageUrl echoes the path back when the file can't be found.
        if (active) setResolved({ key: pathOrUrl, url: /^(https?:|blob:)/i.test(url || '') ? url : '' });
      })
      .catch((err) => {
        console.warn('Could not resolve storage URL:', err);
        if (active) setResolved({ key: pathOrUrl, url: '' });
      });
    return () => {
      active = false;
    };
  }, [pathOrUrl]);

  if (!pathOrUrl) return '';
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return resolved.key === pathOrUrl ? resolved.url : '';
}
