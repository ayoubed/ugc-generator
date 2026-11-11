import { useEffect, useState } from 'react';
import { fetchModels } from '../services/api';
import { MAX_REFERENCE_IMAGES } from '../services/referenceImages';

// Loaded once per page load and shared by every component that asks.
let cache = null;
let pending = null;

function load() {
  if (cache) return Promise.resolve(cache);
  if (!pending) {
    pending = fetchModels()
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
 * The offered video, script and music models (from GET /api/models).
 * Returns { videoModels, scriptModels, musicModels, default*Model, loading, error }.
 */
export function useModels() {
  const [data, setData] = useState(cache);
  const [error, setError] = useState('');

  useEffect(() => {
    if (cache) return undefined;
    let alive = true;
    load()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.message || "Couldn't load the model list."));
    return () => {
      alive = false;
    };
  }, []);

  return {
    videoModels: data?.video_models || [],
    scriptModels: data?.script_models || [],
    defaultVideoModel: data?.default_video_model || '',
    defaultScriptModel: data?.default_script_model || '',
    musicModels: data?.music_models || [],
    defaultMusicModel: data?.default_music_model || '',
    loading: !data && !error,
    error,
  };
}

/**
 * The video model a project uses: its saved choice if still offered, otherwise the default
 * (same rule as the backend, so retired models like Veo fall back cleanly).
 */
export function resolveVideoModel(videoModels, savedId) {
  return videoModels.find((m) => m.id === savedId) || videoModels[0] || null;
}

/** Picture limit for a model (falls back to the shared default while the list loads). */
export function modelPictureLimit(model) {
  return model?.max_reference_images ?? MAX_REFERENCE_IMAGES;
}
