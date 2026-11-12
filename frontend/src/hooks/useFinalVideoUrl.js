import { useEffect, useState } from 'react';
import { resolveStorageUrl } from '../services/api';

/**
 * A playable URL for a final video. A fresh URL from the storage path is preferred, because the
 * URL saved at stitch time can expire. Resolved URLs are cached, so switching versions is instant.
 * Returns { url, loading }.
 */
export function useFinalVideoUrl(video) {
  const storageRef = video?.storageRef || '';
  const savedUrl = video?.videoUrl || '';
  const [cache, setCache] = useState({});
  const cached = storageRef ? cache[storageRef] : undefined;

  useEffect(() => {
    if (!storageRef || cached !== undefined) return undefined;
    let active = true;
    resolveStorageUrl(storageRef)
      .then((url) => (/^(https?:|blob:)/i.test(url || '') ? url : ''))
      .catch(() => '')
      .then((url) => {
        if (active) setCache((prev) => ({ ...prev, [storageRef]: url }));
      });
    return () => {
      active = false;
    };
  }, [storageRef, cached]);

  if (!storageRef) return { url: savedUrl, loading: false };
  if (cached === undefined) return { url: '', loading: true };
  return { url: cached || savedUrl, loading: false };
}
