import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import Layout from '../components/Layout';
import Stepper from '../components/Stepper';
import SceneCard from '../components/SceneCard';
import FinalVideoBanner from '../components/FinalVideoBanner';
import LoadingSpinner from '../components/LoadingSpinner';
import SaveIndicator from '../components/SaveIndicator';
import VideoContextCard from '../components/VideoContextCard';
import { useAuth } from '../hooks/useAuth';
import { deleteScene, updateProject, updateProjectSettings, updateScene, useProject, useScenes } from '../hooks/useProject';
import { useModels, resolveVideoModel, modelPictureLimit } from '../hooks/useModels';
import { useStorageUrl } from '../hooks/useStorageUrl';
import { db } from '../services/firebase';
import { buildScenePrompt, syncPromptWithField } from '../utils/scenePrompt';
import {
  contextPictureCount,
  continuityNote,
  defaultImageSource,
  maxReachableStep,
  sceneChangesSinceTake,
  isSceneSkipped,
  sceneAlternatives,
  sceneHasVideo,
  sceneLabels,
  sceneSlot,
  stepPath,
  previousIncludedScene,
} from '../utils/projectProgress';

const SAVE_DELAY_MS = 800;

function omit(map, key) {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

function EditScenes({ projectId: id }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { project, loading: projectLoading } = useProject(id);
  const { scenes, loading: scenesLoading } = useScenes(id);
  const creatorImageUrl = useStorageUrl(project?.startingImageRef || '');
  const { videoModels } = useModels();

  // Unsaved text edits per scene, shown on top of the live Firestore scenes.
  const [drafts, setDraftsState] = useState({});
  const draftsRef = useRef({});
  const timersRef = useRef({});
  const inFlightRef = useRef(new Map());
  const scenesRef = useRef(scenes);
  const [saveState, setSaveState] = useState('idle'); // 'idle' | 'saving' | 'saved' | 'error'
  const [actionError, setActionError] = useState('');
  const [adding, setAdding] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [justAddedId, setJustAddedId] = useState(null);

  // Unsaved edits to video-wide settings, e.g. { videoContext, assetBible } (null = nothing pending),
  // saved the same way as scene edits.
  const [contextDraft, setContextDraftState] = useState(null);
  const contextDraftRef = useRef(null);
  const contextTimerRef = useRef(null);
  const contextInFlightRef = useRef(null);

  useEffect(() => {
    scenesRef.current = scenes;
  }, [scenes]);

  const setDrafts = useCallback((updater) => {
    draftsRef.current = updater(draftsRef.current);
    setDraftsState(draftsRef.current);
  }, []);

  const setContextDraft = useCallback((value) => {
    contextDraftRef.current = value;
    setContextDraftState(value);
  }, []);

  const refreshSaveState = useCallback(() => {
    if (Object.keys(timersRef.current).length || inFlightRef.current.size || contextTimerRef.current || contextInFlightRef.current) {
      setSaveState('saving');
    } else if (Object.keys(draftsRef.current).length || contextDraftRef.current !== null) setSaveState('error');
    else setSaveState((prev) => (prev === 'idle' ? 'idle' : 'saved'));
  }, []);

  /** Saves the pending video-wide settings edits. Resolves to false when the save failed (the edits are kept). */
  const saveContext = useCallback(async () => {
    contextTimerRef.current = null;
    const draft = contextDraftRef.current;
    if (draft === null) {
      refreshSaveState();
      return true;
    }
    const promise = updateProjectSettings(id, draft);
    contextInFlightRef.current = promise;
    let ok = true;
    try {
      await promise;
      // Keep the draft only if it changed again while saving.
      if (contextDraftRef.current === draft) setContextDraft(null);
    } catch (err) {
      ok = false;
      console.error('Could not save the video-wide settings:', err);
    } finally {
      if (contextInFlightRef.current === promise) contextInFlightRef.current = null;
    }
    refreshSaveState();
    return ok;
  }, [id, refreshSaveState, setContextDraft]);

  /** Saves a scene's pending edits. Resolves to false when the save failed (the edits are kept). */
  const saveScene = useCallback(async (sceneId) => {
    delete timersRef.current[sceneId];
    const draft = draftsRef.current[sceneId];

    if (!draft || !Object.keys(draft).length || !scenesRef.current.some((s) => s.id === sceneId)) {
      // Nothing to save, or the scene was deleted in the meantime.
      setDrafts((prev) => omit(prev, sceneId));
      refreshSaveState();
      return true;
    }

    const saved = { ...draft };
    const promise = updateScene(id, sceneId, saved);
    inFlightRef.current.set(sceneId, promise);
    let ok = true;
    try {
      await promise;
      // Keep only what changed again while the save was in flight.
      setDrafts((prev) => {
        const current = prev[sceneId];
        if (!current) return prev;
        const remaining = Object.fromEntries(Object.entries(current).filter(([key, value]) => saved[key] !== value));
        return Object.keys(remaining).length ? { ...prev, [sceneId]: remaining } : omit(prev, sceneId);
      });
    } catch (err) {
      ok = false;
      console.error(`Could not save scene ${sceneId}:`, err);
    } finally {
      if (inFlightRef.current.get(sceneId) === promise) inFlightRef.current.delete(sceneId);
    }
    refreshSaveState();
    return ok;
  }, [id, refreshSaveState, setDrafts]);

  const scheduleSave = useCallback((sceneId) => {
    clearTimeout(timersRef.current[sceneId]);
    timersRef.current[sceneId] = setTimeout(() => saveScene(sceneId), SAVE_DELAY_MS);
    setSaveState('saving');
  }, [saveScene]);

  /** Saves everything right away. Resolves to false if something could not be saved. */
  const flushAll = useCallback(async () => {
    Object.values(timersRef.current).forEach(clearTimeout);
    timersRef.current = {};
    clearTimeout(contextTimerRef.current);
    contextTimerRef.current = null;
    await Promise.allSettled([...inFlightRef.current.values(), contextInFlightRef.current].filter(Boolean));
    const results = await Promise.all([
      ...Object.keys(draftsRef.current).map((sceneId) => saveScene(sceneId)),
      saveContext(),
    ]);
    return results.every(Boolean);
  }, [saveScene, saveContext]);

  // Leaving the page (navbar, back button) must not drop edits that are still waiting to be saved.
  useEffect(() => {
    const timers = timersRef;
    const pendingDrafts = draftsRef;
    const contextTimer = contextTimerRef;
    const pendingContext = contextDraftRef;
    return () => {
      Object.values(timers.current).forEach(clearTimeout);
      timers.current = {};
      Object.entries(pendingDrafts.current).forEach(([sceneId, draft]) => {
        if (draft && Object.keys(draft).length) {
          updateScene(id, sceneId, draft).catch((err) => console.error(`Could not save scene ${sceneId}:`, err));
        }
      });
      clearTimeout(contextTimer.current);
      if (pendingContext.current !== null) {
        updateProjectSettings(id, pendingContext.current)
          .catch((err) => console.error('Could not save the video-wide settings:', err));
      }
    };
  }, [id]);

  // Warn before closing the tab while edits are unsaved.
  useEffect(() => {
    if (saveState !== 'saving' && saveState !== 'error') return undefined;
    const onBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [saveState]);

  const mergedScenes = useMemo(
    () => scenes.map((scene) => (drafts[scene.id] ? { ...scene, ...drafts[scene.id] } : scene)),
    [scenes, drafts]
  );

  const handleTextChange = (sceneId, field, value) => {
    const scene = scenes.find((s) => s.id === sceneId);
    if (!scene) return;
    const before = { ...scene, ...draftsRef.current[sceneId] };
    const patch = { [field]: value };
    if (field === 'script' || field === 'description' || field === 'context') {
      // Only flows into the prompt while the matching prompt part still mirrors the old text.
      const nextPrompt = syncPromptWithField(before, field, value);
      if (nextPrompt !== (before.prompt || '')) patch.prompt = nextPrompt;
    }
    setDrafts((prev) => ({ ...prev, [sceneId]: { ...prev[sceneId], ...patch } }));
    scheduleSave(sceneId);
  };

  const scheduleSettingsSave = (partial) => {
    setContextDraft({ ...(contextDraftRef.current || {}), ...partial });
    clearTimeout(contextTimerRef.current);
    contextTimerRef.current = setTimeout(saveContext, SAVE_DELAY_MS);
    setSaveState('saving');
  };

  const handleContextChange = (value) => scheduleSettingsSave({ videoContext: value });
  const handleAssetBibleChange = (value) => scheduleSettingsSave({ assetBible: value });

  const handleRebuildPrompt = (sceneId) => {
    const scene = mergedScenes.find((s) => s.id === sceneId);
    if (!scene) return;
    setDrafts((prev) => ({
      ...prev,
      [sceneId]: {
        ...prev[sceneId],
        prompt: buildScenePrompt(scene.script, scene.description, scene.context),
      },
    }));
    scheduleSave(sceneId);
  };

  const handleCustomImageChange = (sceneId, image) =>
    updateScene(
      id,
      sceneId,
      image
        ? { customStartImageRef: image.ref, customStartImageUrl: image.url, imageSource: 'uploaded' }
        : { customStartImageRef: null, customStartImageUrl: null }
    );

  const handleDelete = async (sceneId) => {
    setActionError('');
    clearTimeout(timersRef.current[sceneId]);
    delete timersRef.current[sceneId];
    await inFlightRef.current.get(sceneId)?.catch(() => {});
    try {
      const scene = scenesRef.current.find((s) => s.id === sceneId);
      const others = sceneAlternatives(scenesRef.current, scene);
      await deleteScene(id, sceneId);
      // The scene that was in the video is gone: its first alternative takes the spot.
      if (scene && !isSceneSkipped(scene) && others.length && others.every(isSceneSkipped)) {
        await updateScene(id, others[0].id, { skipped: false });
      }
      setDrafts((prev) => omit(prev, sceneId));
    } catch (err) {
      console.error(`Could not delete scene ${sceneId}:`, err);
      setActionError('Could not delete the scene. Check your connection and try again.');
      if (draftsRef.current[sceneId]) scheduleSave(sceneId);
    }
    refreshSaveState();
  };

  const handleAddScene = async () => {
    setActionError('');
    setAdding(true);
    try {
      // Scene ids are numbers; deleting a scene leaves a gap, so never reuse the count as the id.
      const ids = scenes.map((s) => Number.parseInt(s.id, 10)).filter(Number.isFinite);
      const nextIndex = ids.length ? Math.max(...ids) + 1 : 0;
      const nextId = String(nextIndex);
      await setDoc(doc(db, 'projects', id, 'scenes', nextId), {
        index: nextIndex,
        description: '',
        script: '',
        context: '',
        prompt: '',
        imageSource: defaultImageSource(scenes.length === 0),
        videoStatus: 'pending',
        createdAt: serverTimestamp(),
      });
      setJustAddedId(nextId);
    } catch (err) {
      console.error('Could not add a scene:', err);
      setActionError('Could not add a scene. Check your connection and try again.');
    } finally {
      setAdding(false);
    }
  };

  /** Adds another version of a scene for the same spot in the video (e.g. a different hook). */
  const handleAddAlternative = async (sceneId) => {
    setActionError('');
    setAdding(true);
    try {
      const source = mergedScenes.find((s) => s.id === sceneId);
      if (!source) return;
      const ids = scenes.map((s) => Number.parseInt(s.id, 10)).filter(Number.isFinite);
      const nextIndex = ids.length ? Math.max(...ids) + 1 : 0;
      const nextId = String(nextIndex);
      await setDoc(doc(db, 'projects', id, 'scenes', nextId), {
        index: nextIndex,
        // Same spot as the scene it is an alternative of; not in the video until it is chosen.
        variantOf: String(sceneSlot(source)),
        skipped: true,
        description: source.description || '',
        script: source.script || '',
        context: source.context || '',
        prompt: source.prompt || '',
        // A custom starting picture belongs to the original scene, so the alternative starts from the default.
        imageSource: source.imageSource && source.imageSource !== 'uploaded'
          ? source.imageSource
          : defaultImageSource(!previousIncludedScene(mergedScenes, mergedScenes.indexOf(source))),
        videoStatus: 'pending',
        createdAt: serverTimestamp(),
      });
      setJustAddedId(nextId);
    } catch (err) {
      console.error('Could not add an alternative:', err);
      setActionError('Could not add an alternative. Check your connection and try again.');
    } finally {
      setAdding(false);
    }
  };

  const goTo = async (path) => {
    setActionError('');
    setNavigating(true);
    const ok = await flushAll();
    setNavigating(false);
    if (!ok) {
      setActionError("Your latest changes aren't saved yet. Check your connection, then try again.");
      return;
    }
    navigate(path);
  };

  if (!projectLoading && !project) {
    return (
      <Layout>
        <div className="container page-wrap">
          <div className="card card-white empty-state">
            <h1 className="empty-state-title">Project not found</h1>
            <p className="empty-state-text">It may have been deleted, or it belongs to another account.</p>
            <Link to="/" className="btn btn-primary">Back to dashboard</Link>
          </div>
        </div>
      </Layout>
    );
  }

  const aspectRatio = project?.settings?.aspectRatio || '9:16';
  const globalPictureCount = contextPictureCount(project, null);
  const pictureLimit = modelPictureLimit(resolveVideoModel(videoModels, project?.settings?.videoModel));
  const videoContext = contextDraft?.videoContext ?? project?.settings?.videoContext ?? '';
  const assetBible = contextDraft?.assetBible ?? project?.settings?.assetBible ?? null;
  // The project as it will be once pending edits are saved, for the "needs a new take" checks.
  const liveProject = project ? { ...project, settings: { ...(project.settings || {}), videoContext, assetBible } } : null;
  const sceneChanges = mergedScenes.map((scene, idx) =>
    sceneChangesSinceTake(scene, !previousIncludedScene(mergedScenes, idx), liveProject)
  );
  const labels = sceneLabels(mergedScenes);
  // Alternatives that are not in the video don't need a new take.
  const changedScenes = sceneChanges
    .map((changes, idx) => (changes.length && !isSceneSkipped(mergedScenes[idx]) ? labels[idx] : null))
    .filter(Boolean);
  const contextStaleScenes = sceneChanges
    .map((changes, idx) => (changes.includes('video context') || changes.includes('consistent details') ? labels[idx] : null))
    .filter(Boolean);
  const maxScenePictures = Math.max(0, ...mergedScenes.map((s) => contextPictureCount(null, s)));

  return (
    <Layout>
      <div className="container page-wrap">
        <Stepper
          currentStep={2}
          maxReachableStep={maxReachableStep(project, scenes)}
          onStepClick={(step) => goTo(stepPath(id, step))}
        />

        <header className="page-head">
          <div className="page-head-text">
            <h1 className="page-title">Review your script</h1>
            <p className="page-subtitle">
              Fine-tune what each scene shows and says, choose the picture it starts from and add any pictures it needs.
            </p>
          </div>
          <SaveIndicator state={saveState} onRetry={flushAll} />
        </header>

        <FinalVideoBanner
          project={project}
          scenes={scenes}
          onOpenExport={() => goTo(stepPath(id, 5))}
          outdatedHint="Make new takes of the scenes you changed on the Generate step, then stitch again on the Finish step."
        />

        {actionError && <p className="page-alert" role="alert">{actionError}</p>}

        {scenesLoading || projectLoading ? (
          <div className="page-loading">
            <LoadingSpinner size="lg" label="Loading scenes…" />
          </div>
        ) : scenes.length === 0 ? (
          <div className="card card-white empty-state">
            <h2 className="empty-state-title">No scenes yet</h2>
            <p className="empty-state-text">Write the script from your idea in Step 1, or add a scene by hand.</p>
            <div className="empty-state-actions">
              <button type="button" className="btn btn-secondary" onClick={() => goTo(stepPath(id, 1))}>
                Back to Step 1
              </button>
              <button type="button" className="btn btn-primary" onClick={handleAddScene} disabled={adding}>
                {adding ? 'Adding…' : 'Add a scene'}
              </button>
            </div>
          </div>
        ) : (
          <div className="scene-list">
            <VideoContextCard
              value={videoContext}
              onChange={handleContextChange}
              assetBible={assetBible}
              onAssetBibleChange={handleAssetBibleChange}
              images={project?.globalImages || []}
              onImagesChange={(next) => updateProject(id, { globalImages: next })}
              pictureLimit={pictureLimit}
              maxScenePictures={maxScenePictures}
              storagePrefix={user ? `users/${user.uid}/projects/${id}/context` : ''}
              staleScenes={contextStaleScenes}
            />
            {mergedScenes.map((scene, idx) => {
              // Skipped scenes aren't in the video, so a scene continues from the closest one that is.
              const prev = previousIncludedScene(mergedScenes, idx);
              const prevScene = prev?.scene || null;
              const prevLabel = prev ? `Scene ${prev.number}` : 'the previous scene';
              return (
                <SceneCard
                  key={scene.id}
                  scene={scene}
                  sceneNumber={labels[idx]}
                  alternativeCount={sceneAlternatives(mergedScenes, scene).length}
                  onAddAlternative={adding ? null : () => handleAddAlternative(scene.id)}
                  isFirst={!prev}
                  previousLabel={prevLabel}
                  previousHasVideo={sceneHasVideo(prevScene)}
                  aspectRatio={aspectRatio}
                  creatorImageUrl={creatorImageUrl}
                  storagePrefix={user ? `users/${user.uid}/projects/${id}/scenes/${scene.id}` : ''}
                  globalPictureCount={globalPictureCount}
                  pictureLimit={pictureLimit}
                  changesSinceTake={sceneChanges[idx]}
                  continuity={continuityNote(scene, prevScene, prevLabel)}
                  onTextChange={(field, value) => handleTextChange(scene.id, field, value)}
                  onRebuildPrompt={() => handleRebuildPrompt(scene.id)}
                  onImageSourceChange={(source) => updateScene(id, scene.id, { imageSource: source })}
                  onCustomImageChange={(image) => handleCustomImageChange(scene.id, image)}
                  onSceneImagesChange={(images) => updateScene(id, scene.id, { sceneImages: images })}
                  onDelete={scenes.length > 1 ? () => handleDelete(scene.id) : null}
                  autoFocus={scene.id === justAddedId}
                />
              );
            })}

            <button type="button" className="add-scene" onClick={handleAddScene} disabled={adding}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              {adding ? 'Adding…' : 'Add a scene'}
            </button>

            <div className="page-actions">
              <button type="button" className="btn btn-secondary btn-lg" onClick={() => goTo(stepPath(id, 1))} disabled={navigating}>
                ← Idea &amp; settings
              </button>
              <div className="page-actions-end">
                {changedScenes.length > 0 && (
                  <span className="page-actions-note">
                    {changedScenes.length === 1
                      ? `Scene ${changedScenes[0]} needs a new take`
                      : `Scenes ${changedScenes.join(', ')} need new takes`}
                  </span>
                )}
                <button type="button" className="btn btn-primary btn-lg" onClick={() => goTo(stepPath(id, 3))} disabled={navigating}>
                  {navigating ? 'Saving…' : 'Generate videos'}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}

export default function EditScenesPage() {
  const { id } = useParams();
  // A fresh instance per project, so unsaved edits never leak from one project into another.
  return <EditScenes key={id} projectId={id} />;
}
