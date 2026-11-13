import { auth, storage } from './firebase';
import { ref, getDownloadURL } from 'firebase/storage';

/**
 * Retrieves the Firebase ID token for the authenticated user
 * and constructs the Authorization header object.
 */
export async function getAuthHeaders() {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('User is not authenticated');
  }
  const token = await currentUser.getIdToken();
  return {
    Authorization: `Bearer ${token}`,
  };
}

/**
 * Resolves a Firebase Storage path or URL into a viewable HTTPS download URL.
 * If already an HTTP/blob URL, returns it directly.
 */
export async function resolveStorageUrl(pathOrUrl) {
  if (!pathOrUrl) return '';
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://') || pathOrUrl.startsWith('blob:')) {
    return pathOrUrl;
  }
  try {
    const storageRef = ref(storage, pathOrUrl);
    return await getDownloadURL(storageRef);
  } catch (err) {
    console.error('Failed to get download URL for storage path:', pathOrUrl, err);
    return pathOrUrl;
  }
}

/**
 * The video and script models the app offers, with what each supports.
 * Calls GET /api/models (no auth needed).
 */
export async function fetchModels() {
  const response = await fetch('/api/models');
  if (!response.ok) throw new Error(`Couldn't load the model list: ${response.statusText}`);
  return response.json();
}

/**
 * Draft the Asset Bible (speaker, products and props, setting, look) from a video idea.
 * Calls POST /api/extract-assets. Nothing is saved; returns { character, hero_props, setting, visual_style }.
 */
export async function extractAssets(idea, llmModel, projectId = null, productName = '') {
  const authHeaders = await getAuthHeaders();
  const response = await fetch('/api/extract-assets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
    // With a project, the server writes the details from its photo and pictures, not the idea alone.
    body: JSON.stringify({
      idea,
      llm_model: llmModel || null,
      project_id: projectId || null,
      product_name: productName?.trim() || null,
    }),
  });

  if (!response.ok) {
    let errorMsg = `Server error: ${response.statusText}`;
    try {
      const errorData = await response.json();
      errorMsg = errorData.detail || errorData.message || errorMsg;
    } catch {
      // ignore json parse error
    }
    throw new Error(errorMsg);
  }

  const data = await response.json();
  return data.asset_bible;
}

/**
 * Generate scenes for a project.
 * Calls POST /api/generate-scenes
 */
export async function generateScenes(projectId, data) {
  const authHeaders = await getAuthHeaders();
  
  const payload = {
    projectId,
    project_id: projectId,
    ...data,
  };

  const response = await fetch('/api/generate-scenes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let errorMsg = `Server error: ${response.statusText}`;
    try {
      const errorData = await response.json();
      errorMsg = errorData.detail || errorData.message || errorMsg;
    } catch {
      // ignore json parse error
    }
    throw new Error(errorMsg);
  }

  return response.json();
}

/**
 * Generate video for an individual scene.
 * Calls POST /api/projects/{pid}/scenes/{n}/generate as multipart/form-data
 */
export async function generateVideo(projectId, sceneIndex, imageSource, imageFile = null, editPrompt = null) {
  const authHeaders = await getAuthHeaders();

  const formData = new FormData();
  formData.append('image_source', imageSource);
  formData.append('imageSource', imageSource);
  
  if (imageFile) {
    formData.append('file', imageFile);
    formData.append('image', imageFile);
  }
  if (editPrompt) {
    formData.append('edit_prompt', editPrompt);
  }

  const response = await fetch(`/api/projects/${projectId}/scenes/${sceneIndex}/generate`, {
    method: 'POST',
    headers: {
      ...authHeaders,
    },
    body: formData,
  });

  if (!response.ok) {
    let errorMsg = `Failed to generate video: ${response.statusText}`;
    try {
      const errorData = await response.json();
      errorMsg = errorData.detail || errorData.message || errorMsg;
    } catch {
      // ignore
    }
    throw new Error(errorMsg);
  }

  return response.json();
}

/**
 * Stitch all generated scene videos together into a final video.
 * Calls POST /api/projects/{pid}/stitch
 */
export async function stitchVideos(projectId) {
  const authHeaders = await getAuthHeaders();

  const response = await fetch(`/api/projects/${projectId}/stitch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
  });

  if (!response.ok) {
    let errorMsg = `Failed to stitch videos: ${response.statusText}`;
    try {
      const errorData = await response.json();
      errorMsg = errorData.detail || errorData.message || errorMsg;
    } catch {
      // ignore
    }
    throw new Error(errorMsg);
  }

  return response.json();
}

/**
 * Make a past attempt the scene's active video (used for stitching, by the next scene, and for edits).
 * Calls POST /api/projects/{pid}/scenes/{n}/select-attempt
 */
export async function selectAttempt(projectId, sceneIndex, attempt) {
  const authHeaders = await getAuthHeaders();

  const response = await fetch(`/api/projects/${projectId}/scenes/${sceneIndex}/select-attempt`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
    body: JSON.stringify({ attempt }),
  });

  if (!response.ok) {
    let errorMsg = `Failed to switch attempt: ${response.statusText}`;
    try {
      const errorData = await response.json();
      errorMsg = errorData.detail || errorData.message || errorMsg;
    } catch {
      // ignore
    }
    throw new Error(errorMsg);
  }

  return response.json();
}

/**
 * Stop the take a scene is making. The scene goes back to the take it was using right away.
 * Calls POST /api/projects/{pid}/scenes/{n}/cancel
 */
export async function cancelSceneGeneration(projectId, sceneIndex) {
  const authHeaders = await getAuthHeaders();

  const response = await fetch(`/api/projects/${projectId}/scenes/${sceneIndex}/cancel`, {
    method: 'POST',
    headers: authHeaders,
  });

  if (!response.ok) {
    let errorMsg = `Could not cancel: ${response.statusText}`;
    try {
      const errorData = await response.json();
      errorMsg = errorData.detail || errorData.message || errorMsg;
    } catch {
      // ignore
    }
    throw new Error(errorMsg);
  }

  return response.json();
}

/**
 * Make an instrumental music track for the whole video (runs in the background; watch
 * project.musicStatus). Calls POST /api/projects/{pid}/music/generate
 */
export async function generateMusic(projectId, { prompt = '', model = null, volume = null } = {}) {
  const authHeaders = await getAuthHeaders();

  const response = await fetch(`/api/projects/${projectId}/music/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
    body: JSON.stringify({ prompt, model, volume }),
  });

  if (!response.ok) {
    let errorMsg = `Failed to make music: ${response.statusText}`;
    try {
      const errorData = await response.json();
      errorMsg = errorData.detail || errorData.message || errorMsg;
    } catch {
      // ignore
    }
    throw new Error(errorMsg);
  }

  return response.json();
}

/** POST/DELETE to the API with the user's token; throws an Error carrying the server's message. */
async function callApi(path, { method = 'POST', body, fallback = 'Request failed' } = {}) {
  const authHeaders = await getAuthHeaders();
  const response = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json', ...authHeaders } : authHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    let errorMsg = `${fallback}: ${response.statusText}`;
    try {
      const errorData = await response.json();
      errorMsg = errorData.detail || errorData.message || errorMsg;
    } catch {
      // ignore
    }
    throw new Error(errorMsg);
  }
  return response.json();
}

/**
 * Make a take for every scene that has no video yet, one after another (watch project.generateAll).
 * With stitch=true the final video is stitched when the last scene is done; with retake=true a
 * scene whose first take is flagged by the automatic check gets one more take.
 */
export function generateAllScenes(projectId, { stitch = false, retake = false, remake = [] } = {}) {
  // remake: ids of scenes to make a NEW take of although they have a video.
  return callApi(`/api/projects/${projectId}/generate-all`, { body: { stitch, retake, remake }, fallback: 'Could not start generating' });
}

/** Stop a generate-all run: cancels the take being made and starts no further scene. */
export function cancelGenerateAll(projectId) {
  return callApi(`/api/projects/${projectId}/generate-all/cancel`, { fallback: 'Could not stop' });
}

/**
 * Copy a project with its script, pictures, style and music (no takes or final videos).
 * Returns { id, hasScript }.
 */
export async function duplicateProject(projectId) {
  const data = await callApi(`/api/projects/${projectId}/duplicate`, { fallback: 'Could not duplicate the project' });
  return { id: data.project_id, hasScript: Boolean(data.scenes) };
}

/**
 * Break down an uploaded reference video (watch project.referenceStatus; the result lands in
 * project.settings.reference.breakdown).
 */
export function analyseReference(projectId, storageRef, name = '') {
  return callApi(`/api/projects/${projectId}/reference/analyse`, {
    body: { storage_ref: storageRef, name },
    fallback: 'Could not start the breakdown',
  });
}

/** Delete a project with its scenes and files; running takes are stopped. */
export function deleteProjectEverywhere(projectId) {
  return callApi(`/api/projects/${projectId}`, { method: 'DELETE', fallback: 'Could not delete the project' });
}

/**
 * Calls GET /api/voices: { available, voices: [{ id, name, description, previewUrl }] }.
 * `available` is false when the server has no voice service set up.
 */
export async function fetchVoices() {
  const authHeaders = await getAuthHeaders();
  const response = await fetch('/api/voices', { headers: authHeaders });
  if (!response.ok) {
    let errorMsg = `Could not load the voices: ${response.statusText}`;
    try {
      const errorData = await response.json();
      errorMsg = errorData.detail || errorData.message || errorMsg;
    } catch {
      // ignore
    }
    throw new Error(errorMsg);
  }
  return response.json();
}
