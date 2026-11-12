import { useEffect, useState } from 'react';
import { fetchVoices } from '../services/api';

// Loaded once per page load and shared by every component that asks.
let cache = null;
let pending = null;

function load() {
  if (cache) return Promise.resolve(cache);
  if (!pending) {
    pending = fetchVoices()
      .then((data) => {
        cache = data;
        return data;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

/**
 * The voices a whole video can be re-voiced to (GET /api/voices).
 * Returns { available, voices, loading, error }. `available` is false when the server has no
 * voice service set up; the choice is then not offered at all.
 */
export function useVoices() {
  const [data, setData] = useState(cache);
  const [error, setError] = useState('');

  useEffect(() => {
    if (cache) return undefined;
    let alive = true;
    load()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.message || "Couldn't load the voices."));
    return () => {
      alive = false;
    };
  }, []);

  return {
    available: Boolean(data?.available),
    voices: data?.voices || [],
    loading: !data && !error,
    error,
  };
}
