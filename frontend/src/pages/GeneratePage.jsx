import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Layout from '../components/Layout';
import Stepper from '../components/Stepper';
import FinalVideoBanner from '../components/FinalVideoBanner';
import GenerateSceneCard from '../components/GenerateSceneCard';
import LoadingSpinner from '../components/LoadingSpinner';
import SaveIndicator from '../components/SaveIndicator';
import { useAuth } from '../hooks/useAuth';
import { useNow } from '../hooks/useNow';
import { updateProjectSettings, updateScene, useProject, useScenes } from '../hooks/useProject';
import { useStorageUrl } from '../hooks/useStorageUrl';
import { useModels, resolveVideoModel, modelPictureLimit } from '../hooks/useModels';
import {
  cancelGenerateAll,
  cancelSceneGeneration,
  generateAllScenes,
  generateVideo,
  selectAttempt,
} from '../services/api';
import { useDoneNotifications } from '../hooks/useDoneNotifications';
import { askToNotify } from '../utils/notify';
import { friendlyError } from '../utils/errors';
import {
  activeTakeNumber,
  allScenesReady,
  currentFinalVideo,
  effectiveImageSource,
  finalVideoChangeReason,
  formatElapsed,
  formatSceneList as listScenes,
  isSceneBusy,
  isSceneSkipped,
  isStitchStuck,
  isStitching,
  maxReachableStep,
  previousIncludedScene,
  sceneChangesSinceTake,
  sceneHasVideo,
  sceneStatus,
  sceneAlternatives,
  sceneLabels,
  sceneSlot,
  scenesReadyCount,
  stepPath,
  stitchStartedMillis,
  takeCheck,
  toMillis,
  isBusyAndFresh,
} from '../utils/projectProgress';

const SAVE_DELAY_MS = 800;
// Saving waits for the server, so it would hang forever offline. Give up after this long.
const SAVE_TIMEOUT_MS = 15000;

function omit(map, key) {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** How one scene shows in the overview. */
function trackState(scene, isFirst, now, project) {
  if (isSceneSkipped(scene)) return { key: 'skipped', label: 'Skipped' };
  if (isSceneBusy(scene)) {
    if (!isBusyAndFresh(scene, now)) return { key: 'stuck', label: 'Not responding' };
    if (sceneStatus(scene) === 'queued') return { key: 'busy', label: 'Queued' };
    const elapsed = (now - (toMillis(scene.updatedAt) || now)) / 1000;
    return { key: 'busy', label: `Generating · ${formatElapsed(elapsed)}` };
  }
  if (sceneHasVideo(scene)) {
    const take = activeTakeNumber(scene);
    const takeLabel = take ? `Take ${take}` : 'Ready';
    if (sceneChangesSinceTake(scene, isFirst, project).length) return { key: 'changed', label: `${takeLabel} · edited since` };
    if (take && takeCheck(scene, take)?.ok === false) return { key: 'changed', label: `${takeLabel} · check it` };
    return { key: 'ready', label: takeLabel };
  }
  if (sceneStatus(scene) === 'failed') return { key: 'failed', label: 'Failed' };
  return { key: 'empty', label: 'No video yet' };
}

function GenerateVideos({ projectId: id }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { project, loading: projectLoading } = useProject(id);
  const { scenes, loading: scenesLoading } = useScenes(id);
  const creatorImageUrl = useStorageUrl(project?.startingImageRef || '');
  const { videoModels } = useModels();

  // Unsaved prompt edits per scene, shown on top of the live Firestore scenes.
  const [drafts, setDraftsState] = useState({});
  const draftsRef = useRef({});
  const timersRef = useRef({});
  const inFlightRef = useRef(new Map());
  const scenesRef = useRef(scenes);
  const [saveState, setSaveState] = useState('idle'); // 'idle' | 'saving' | 'saved' | 'error'
  const [requesting, setRequesting] = useState({});
  const [sceneErrors, setSceneErrors] = useState({});
  // Stitching is started on the Video step; these keep the footer's wording in one place.
  const stitchRequesting = false;
  const stitchError = '';
  const [pageError, setPageError] = useState('');
  const [navigating, setNavigating] = useState(false);
  const [runRequesting, setRunRequesting] = useState(false);
  const [runError, setRunError] = useState('');
  const [stitchWhenDone, setStitchWhenDone] = useState(true);
  const [retakeFlagged, setRetakeFlagged] = useState(false); // off by default: it can cost an extra take per scene

  useDoneNotifications(project, scenes);

  useEffect(() => {
    scenesRef.current = scenes;
  }, [scenes]);

  const setDrafts = useCallback((updater) => {
    draftsRef.current = updater(draftsRef.current);
    setDraftsState(draftsRef.current);
  }, []);

  const refreshSaveState = useCallback(() => {
    if (Object.keys(timersRef.current).length || inFlightRef.current.size) setSaveState('saving');
    else if (Object.keys(draftsRef.current).length) setSaveState('error');
    else setSaveState((prev) => (prev === 'idle' ? 'idle' : 'saved'));
  }, []);

  /** Saves a scene's prompt edit. Resolves to false when the save failed (the edit is kept). */
  const savePrompt = useCallback(async (sceneId) => {
    clearTimeout(timersRef.current[sceneId]);
    delete timersRef.current[sceneId];

    if (!(sceneId in draftsRef.current) || !scenesRef.current.some((s) => s.id === sceneId)) {
      // Nothing to save, or the scene was deleted in the meantime.
      setDrafts((prev) => omit(prev, sceneId));
      refreshSaveState();
      return true;
    }

    const prompt = draftsRef.current[sceneId];
    const promise = updateScene(id, sceneId, { prompt });
    inFlightRef.current.set(sceneId, promise);
    let ok = true;
    try {
      await promise;
      // Keep the draft if it changed again while the save was in flight.
      setDrafts((prev) => (prev[sceneId] === prompt ? omit(prev, sceneId) : prev));
    } catch (err) {
      ok = false;
      console.error(`Could not save the prompt of scene ${sceneId}:`, err);
    } finally {
      if (inFlightRef.current.get(sceneId) === promise) inFlightRef.current.delete(sceneId);
    }
    refreshSaveState();
    return ok;
  }, [id, refreshSaveState, setDrafts]);

  const scheduleSave = useCallback((sceneId) => {
    clearTimeout(timersRef.current[sceneId]);
    timersRef.current[sceneId] = setTimeout(() => savePrompt(sceneId), SAVE_DELAY_MS);
    setSaveState('saving');
  }, [savePrompt]);

  /** Saves every pending edit right away. Resolves to false if something could not be saved. */
  const flushAll = useCallback(async () => {
    Object.values(timersRef.current).forEach(clearTimeout);
    timersRef.current = {};
    const results = await Promise.all(Object.keys(draftsRef.current).map((sceneId) => savePrompt(sceneId)));
    return results.every(Boolean);
  }, [savePrompt]);

  // Leaving the page (navbar, back button) must not drop edits that are still waiting to be saved.
  useEffect(() => {
    const timers = timersRef;
    const pendingDrafts = draftsRef;
    return () => {
      Object.values(timers.current).forEach(clearTimeout);
      timers.current = {};
      Object.entries(pendingDrafts.current).forEach(([sceneId, prompt]) => {
        updateScene(id, sceneId, { prompt }).catch((err) => console.error(`Could not save scene ${sceneId}:`, err));
      });
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
    () => scenes.map((scene) => (scene.id in drafts ? { ...scene, prompt: drafts[scene.id] } : scene)),
    [scenes, drafts]
  );

  const somethingRunning =
    scenes.some(isSceneBusy) || project?.status === 'stitching' || stitchRequesting || Object.keys(requesting).length > 0
    || ['running', 'stitching'].includes(project?.generateAll?.status);
  const now = useNow(somethingRunning);

  const setSceneError = (sceneId, message) =>
    setSceneErrors((prev) => (message ? { ...prev, [sceneId]: message } : omit(prev, sceneId)));

  const handlePromptChange = (sceneId, value) => {
    setDrafts((prev) => ({ ...prev, [sceneId]: value }));
    scheduleSave(sceneId);
  };

  const handlePromptBlur = (sceneId) => {
    if (sceneId in draftsRef.current) savePrompt(sceneId);
  };

  /** Starts a take (or a refined take when editPrompt is set). Resolves to true when it was queued. */
  const handleGenerate = async (scene, isFirst, editPrompt) => {
    const sceneId = scene.id;
    setSceneError(sceneId, '');
    askToNotify();
    setRequesting((prev) => ({ ...prev, [sceneId]: true }));
    try {
      // The server reads the prompt from the scene, so the latest edit has to be saved first.
      const saved = await withTimeout(savePrompt(sceneId), SAVE_TIMEOUT_MS).catch(() => false);
      if (!saved) {
        setSceneError(sceneId, "Couldn't save your prompt, so the take wasn't started. Check your connection and try again.");
        return false;
      }
      await generateVideo(id, sceneId, effectiveImageSource(scene, isFirst), null, editPrompt || null);
      return true;
    } catch (err) {
      console.error(`Could not start a take of scene ${sceneId}:`, err);
      setSceneError(sceneId, friendlyError(err));
      return false;
    } finally {
      setRequesting((prev) => omit(prev, sceneId));
    }
  };

  const handleSelectTake = async (sceneId, attempt) => {
    setSceneError(sceneId, '');
    try {
      await selectAttempt(id, sceneId, attempt);
      return true;
    } catch (err) {
      console.error(`Could not switch scene ${sceneId} to take ${attempt}:`, err);
      setSceneError(sceneId, friendlyError(err));
      return false;
    }
  };

  const handleCancel = async (sceneId) => {
    setSceneError(sceneId, '');
    try {
      await cancelSceneGeneration(id, sceneId);
      return true;
    } catch (err) {
      console.error(`Could not cancel the take of scene ${sceneId}:`, err);
      setSceneError(sceneId, friendlyError(err));
      return false;
    }
  };

  /** Puts a scene in or out of the final video. Throws when the save fails (the card shows it). */
  const handleToggleSkip = async (sceneId, skipped) => {
    setSceneError(sceneId, '');
    const scene = scenesRef.current.find((s) => s.id === sceneId);
    // Only one scene of a spot is in the video: choosing an alternative switches the others off.
    const others = skipped ? [] : sceneAlternatives(scenesRef.current, scene).filter((s) => !isSceneSkipped(s));
    await withTimeout(
      Promise.all([
        updateScene(id, sceneId, { skipped }),
        ...others.map((s) => updateScene(id, s.id, { skipped: true })),
      ]),
      SAVE_TIMEOUT_MS
    );
  };

  const handleCustomImageChange = (sceneId, image) =>
    updateScene(
      id,
      sceneId,
      image
        ? { customStartImageRef: image.ref, customStartImageUrl: image.url, imageSource: 'uploaded' }
        : { customStartImageRef: null, customStartImageUrl: null }
    );

  const handleEndImageChange = (sceneId, image) =>
    updateScene(id, sceneId, image
      ? { endImageRef: image.ref, endImageUrl: image.url }
      : { endImageRef: null, endImageUrl: null });

  const goTo = async (path) => {
    setPageError('');
    setNavigating(true);
    const ok = await withTimeout(flushAll(), SAVE_TIMEOUT_MS).catch(() => false);
    setNavigating(false);
    if (!ok) {
      setPageError("Your latest prompt edits aren't saved yet. Check your connection, then try again.");
      return;
    }
    navigate(path);
  };

  /** Makes every missing scene in order on the server, and stitches at the end when asked. */
  const handleGenerateAll = async () => {
    setRunError('');
    askToNotify();
    setRunRequesting(true);
    try {
      // The server reads the prompts from the scenes, so pending edits have to be saved first.
      const saved = await withTimeout(flushAll(), SAVE_TIMEOUT_MS).catch(() => false);
      if (!saved) {
        setRunError("Couldn't save your latest prompt edits, so nothing was started. Check your connection and try again.");
        return;
      }
      await generateAllScenes(id, { stitch: stitchWhenDone, retake: retakeFlagged });
    } catch (err) {
      console.error('Could not start generating all scenes:', err);
      setRunError(friendlyError(err));
    } finally {
      setRunRequesting(false);
    }
  };

  const handleStopAll = async () => {
    setRunError('');
    setRunRequesting(true);
    try {
      await cancelGenerateAll(id);
    } catch (err) {
      console.error('Could not stop generating:', err);
      setRunError(friendlyError(err));
    } finally {
      setRunRequesting(false);
    }
  };

  // Captions, cuts and music are chosen on the Video step, which also starts the stitch.
  const handleStitch = () => goTo(stepPath(id, 4));

  const jumpToScene = (sceneId) => {
    const card = document.getElementById(`scene-${sceneId}`);
    if (!card) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    card.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    card.focus({ preventScroll: true });
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

  const settings = project?.settings || {};
  // What each scene is called: 1, 2, 3, or "2A"/"2B" for the alternatives of one spot.
  const labels = sceneLabels(mergedScenes);
  // Where each scene sits in the final video: skipped scenes are left out, so "previous" and "next"
  // mean the closest scenes that are still in the video (the API uses the same rule).
  const placement = mergedScenes.map((scene, idx) => {
    const prev = previousIncludedScene(mergedScenes, idx);
    let next = null;
    for (let j = idx + 1; j < mergedScenes.length; j += 1) {
      if (!isSceneSkipped(mergedScenes[j]) && sceneSlot(mergedScenes[j]) !== sceneSlot(scene)) {
        next = { scene: mergedScenes[j], number: labels[j] };
        break;
      }
    }
    return { prev, next, isFirst: !prev };
  });
  const sceneCount = mergedScenes.filter((s) => !isSceneSkipped(s)).length;
  const skippedCount = mergedScenes.length - sceneCount;
  const readyCount = scenesReadyCount(mergedScenes);
  const ready = allScenesReady(mergedScenes);
  const busyNumbers = [];
  const stuckNumbers = [];
  const missingNumbers = [];
  mergedScenes.forEach((scene, idx) => {
    if (isSceneSkipped(scene)) return;
    if (isSceneBusy(scene)) (isBusyAndFresh(scene, now) ? busyNumbers : stuckNumbers).push(labels[idx]);
    else if (!sceneHasVideo(scene)) missingNumbers.push(labels[idx]);
  });

  const finalVideo = currentFinalVideo(project);
  const finalReason = finalVideo ? finalVideoChangeReason(finalVideo, mergedScenes, project) : '';
  const stitching = isStitching(project, now);
  const stitchStuck = isStitchStuck(project, now);
  const lastStitchFailed = Boolean(project?.stitchError) && !stitching;
  const stitchElapsed = stitching ? (now - (stitchStartedMillis(project) || now)) / 1000 : 0;
  const finalLabel = finalVideo?.version ? `Final video v${finalVideo.version}` : 'Your final video';

  // A "generate all" run: alive while a scene is generating, it is stitching, or it was heard from recently.
  const run = project?.generateAll || null;
  const runHeard = toMillis(run?.updatedAt);
  const runActive = ['running', 'stitching'].includes(run?.status)
    && (busyNumbers.length > 0 || stitching || (Boolean(runHeard) && now - runHeard < 2 * 60 * 1000));
  const runFailed = run?.status === 'failed' && !runActive && missingNumbers.length > 0 ? run.error || 'Generating stopped.' : '';
  const canGenerateAll = !runActive && missingNumbers.length > 0 && busyNumbers.length === 0 && !stitching;

  let overviewSub = 'Generate each scene. A scene that continues from the one before it needs that scene finished first.';
  if (busyNumbers.length) {
    overviewSub = `${listScenes(busyNumbers)} ${busyNumbers.length === 1 ? 'is' : 'are'} generating. Generation keeps going if you leave this page.`;
  } else if (ready) {
    if (!finalVideo) overviewSub = 'Every scene has a video. Continue to the Video step to add captions and music and stitch them.';
    else if (finalReason) overviewSub = `${finalReason} Stitch a new version on the Video step.`;
    else overviewSub = `${finalLabel} matches the takes in use.`;
  }
  if (skippedCount && !busyNumbers.length) {
    overviewSub += ` ${skippedCount === 1 ? '1 scene is' : `${skippedCount} scenes are`} skipped and left out of the final video.`;
  }

  // The stitch bar: what is in the way, or what to do next.
  const stitchLabel = finalVideo ? 'Stitch a new version' : 'Finish the video';
  let stitchNote = '';
  let stitchTone = '';
  let primaryAction = null;
  const openExport = () => goTo(stepPath(id, 4));

  if (stitching) {
    stitchNote = `Stitching your final video · ${formatElapsed(stitchElapsed)}`;
    primaryAction = (
      <button type="button" id="gen-open-export" className="btn btn-primary btn-lg" onClick={openExport} disabled={navigating}>
        Watch progress
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
    );
  } else {
    if (!ready) {
      const parts = [];
      if (busyNumbers.length) parts.push(`Wait for ${listScenes(busyNumbers)} to finish`);
      if (stuckNumbers.length) parts.push(`${listScenes(stuckNumbers)} stopped responding. Start ${stuckNumbers.length === 1 ? 'it' : 'them'} again`);
      if (missingNumbers.length) parts.push(`${listScenes(missingNumbers)} ${missingNumbers.length === 1 ? 'needs' : 'need'} a video`);
      stitchNote = `${parts.join(' · ')} before stitching.`;
    } else if (stitchStuck) {
      stitchNote = 'The last stitch stopped responding. Start it again.';
      stitchTone = 'is-warning';
    } else if (lastStitchFailed) {
      stitchNote = `The last stitch failed: ${project.stitchError}`;
      stitchTone = 'is-error';
    } else if (finalReason) {
      stitchNote = finalReason;
      stitchTone = 'is-warning';
    } else if (finalVideo?.legacy) {
      stitchNote = 'Your final video is ready. Stitch again if you changed any takes.';
    } else if (finalVideo) {
      stitchNote = `${finalLabel} is up to date.`;
      stitchTone = 'is-success';
    } else {
      stitchNote = 'Every scene has a video.';
      stitchTone = 'is-success';
    }

    const upToDate = ready && finalVideo && !finalVideo.legacy && !finalReason && !stitchStuck && !lastStitchFailed;
    if (upToDate) {
      primaryAction = (
        <button type="button" id="gen-view-final" className="btn btn-primary btn-lg" onClick={openExport} disabled={navigating}>
          View final video
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      );
    } else {
      primaryAction = (
        <button
          type="button"
          id="gen-stitch"
          className="btn btn-primary btn-lg"
          onClick={handleStitch}
          disabled={!ready || stitchRequesting || navigating}
        >
          {stitchRequesting ? (
            <LoadingSpinner size="sm" label="Starting…" />
          ) : (
            <>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <rect x="2" y="6" width="6" height="12" rx="1.5" />
                <rect x="9" y="6" width="6" height="12" rx="1.5" />
                <rect x="16" y="6" width="6" height="12" rx="1.5" />
              </svg>
              {stitchLabel}
            </>
          )}
        </button>
      );
    }
  }

  if (stitchError) {
    stitchNote = stitchError;
    stitchTone = 'is-error';
  }

  const modelLabel = resolveVideoModel(videoModels, settings.videoModel)?.label || '';

  return (
    <Layout>
      <div className="container page-wrap">
        <Stepper
          currentStep={3}
          maxReachableStep={maxReachableStep(project, scenes)}
          onStepClick={(step) => goTo(stepPath(id, step))}
        />

        <header className="page-head">
          <div className="page-head-text">
            <h1 className="page-title">Generate your videos</h1>
            <p className="page-subtitle">
              Make a take of each scene and keep the ones you like. Then stitch them into one video.
            </p>
          </div>
          <SaveIndicator state={saveState} onRetry={flushAll} />
        </header>

        <FinalVideoBanner
          project={project}
          scenes={mergedScenes}
          onOpenExport={openExport}
          outdatedHint="Stitch a new version on the Video step to update it."
        />

        {pageError && <p className="page-alert" role="alert">{pageError}</p>}

        {scenesLoading || projectLoading ? (
          <div className="page-loading">
            <LoadingSpinner size="lg" label="Loading scenes…" />
          </div>
        ) : mergedScenes.length === 0 ? (
          <div className="card card-white empty-state">
            <h2 className="empty-state-title">No scenes yet</h2>
            <p className="empty-state-text">Write your script first. Each scene of the script becomes one video here.</p>
            <div className="empty-state-actions">
              <button type="button" className="btn btn-secondary" onClick={() => goTo(stepPath(id, 1))}>
                Back to Step 1
              </button>
              <button type="button" className="btn btn-primary" onClick={() => goTo(stepPath(id, 2))}>
                Go to Script
              </button>
            </div>
          </div>
        ) : (
          <>
            <section className="card card-white gen-overview" aria-labelledby="gen-overview-title">
              <div className="gen-overview-head">
                <div className="gen-overview-text">
                  <h2 className="gen-overview-title" id="gen-overview-title">
                    {ready
                      ? (sceneCount === 1 ? 'The scene in the video has a video' : `All ${sceneCount} scenes in the video are ready`)
                      : `${readyCount} of ${sceneCount} scenes ready`}
                  </h2>
                  <p className="gen-overview-sub" aria-live="polite">{overviewSub}</p>
                </div>
                <ul className="gen-overview-meta" aria-label="Video settings">
                  {modelLabel && <li>{modelLabel}</li>}
                  <li>{settings.aspectRatio || '9:16'}</li>
                  {settings.duration && <li>{settings.duration}s per scene</li>}
                  {settings.resolution && <li>{settings.resolution}</li>}
                </ul>
              </div>

              <ol className="gen-track" aria-label="Scenes">
                {mergedScenes.map((scene, idx) => {
                  const state = trackState(scene, placement[idx].isFirst, now, project);
                  return (
                    <li key={scene.id} className="gen-track-cell">
                      <button
                        type="button"
                        id={`gen-track-${scene.id}`}
                        className={`gen-track-item is-${state.key}`}
                        onClick={() => jumpToScene(scene.id)}
                        aria-label={`Scene ${labels[idx]}: ${state.label}. Go to scene.`}
                      >
                        <span className="gen-track-bar" aria-hidden="true" />
                        <span className="gen-track-name">Scene {labels[idx]}</span>
                        <span className="gen-track-state">{state.label}</span>
                      </button>
                    </li>
                  );
                })}
              </ol>

              {(runActive || canGenerateAll || runError) && (
                <div className="gen-run" role="region" aria-label="Generate all scenes">
                  {runActive ? (
                    <>
                      <div className="gen-run-status" aria-live="polite">
                        <LoadingSpinner size="sm" />
                        {run.status === 'stitching' || stitching
                          ? 'All scenes are ready. Stitching the final video.'
                          : run.currentNumber
                            ? `Generating all scenes: ${run.retaking ? 'retaking ' : ''}scene ${run.currentNumber} now, ${missingNumbers.length + busyNumbers.length} left${run.stitch ? ', then stitching' : ''}.`
                            : 'Starting the next scene.'}
                      </div>
                      {run.status !== 'stitching' && !stitching && (
                        <button type="button" id="gen-stop-all" className="btn btn-secondary" onClick={handleStopAll} disabled={runRequesting}>
                          {runRequesting ? 'Stopping…' : 'Stop'}
                        </button>
                      )}
                    </>
                  ) : canGenerateAll ? (
                    <>
                      <div className="gen-run-text">
                        <p className="gen-run-status">
                          {missingNumbers.length === 1
                            ? `Scene ${missingNumbers[0]} still needs a video.`
                            : `${missingNumbers.length} scenes still need a video. They are made one after another, and you can leave this page.`}
                        </p>
                        {runFailed && <p className="gen-note is-error" role="alert">{runFailed}</p>}
                        <label className="gen-run-option" htmlFor="gen-stitch-when-done">
                          <input
                            type="checkbox"
                            id="gen-stitch-when-done"
                            checked={stitchWhenDone}
                            onChange={(e) => setStitchWhenDone(e.target.checked)}
                          />
                          Stitch the final video when they are done
                        </label>
                        <label className="gen-run-option" htmlFor="gen-retake-flagged">
                          <input
                            type="checkbox"
                            id="gen-retake-flagged"
                            checked={retakeFlagged}
                            onChange={(e) => setRetakeFlagged(e.target.checked)}
                          />
                          Make one more take when the automatic check finds a problem (costs an extra take)
                        </label>
                      </div>
                      <button type="button" id="gen-generate-all" className="btn btn-primary" onClick={handleGenerateAll} disabled={runRequesting}>
                        {runRequesting ? <LoadingSpinner size="sm" label="Starting…" /> : missingNumbers.length === 1 ? 'Generate it' : `Generate all ${missingNumbers.length}`}
                      </button>
                    </>
                  ) : null}
                  {runError && <p className="gen-note is-error" role="alert">{runError}</p>}
                </div>
              )}
            </section>

            <div className="gen-list">
              {mergedScenes.map((scene, idx) => (
                <GenerateSceneCard
                  key={scene.id}
                  scene={scene}
                  sceneNumber={labels[idx]}
                  isFirst={placement[idx].isFirst}
                  prevScene={placement[idx].prev?.scene || null}
                  prevNumber={placement[idx].prev?.number || null}
                  nextScene={placement[idx].next?.scene || null}
                  nextNumber={placement[idx].next?.number || null}
                  canSkip={sceneCount > 1}
                  alternativeCount={sceneAlternatives(mergedScenes, scene).length}
                  onUseSpokenText={(text) => updateProjectSettings(id, { [`captions.texts.${scene.id}`]: text })
                    .catch(() => setSceneError(scene.id, "Couldn't save the caption. Check your connection and try again."))}
                  onToggleSkip={(skipped) => handleToggleSkip(scene.id, skipped)}
                  project={project}
                  pictureLimit={modelPictureLimit(resolveVideoModel(videoModels, settings.videoModel))}
                  now={now}
                  creatorImageUrl={creatorImageUrl}
                  storagePrefix={user ? `users/${user.uid}/projects/${id}/scenes/${scene.id}` : ''}
                  requesting={Boolean(requesting[scene.id])}
                  error={sceneErrors[scene.id] || ''}
                  onPromptChange={(value) => handlePromptChange(scene.id, value)}
                  onPromptBlur={() => handlePromptBlur(scene.id)}
                  onImageSourceChange={(source) => updateScene(id, scene.id, { imageSource: source })}
                  onCustomImageChange={(image) => handleCustomImageChange(scene.id, image)}
                  onEndImageChange={(image) => handleEndImageChange(scene.id, image)}
                  onGenerate={(editPrompt) => handleGenerate(scene, placement[idx].isFirst, editPrompt)}
                  onSelectTake={(attempt) => handleSelectTake(scene.id, attempt)}
                  onCancel={() => handleCancel(scene.id)}
                  onEditScript={() => goTo(stepPath(id, 2))}
                />
              ))}
            </div>

            <div className="gen-footer" role="region" aria-label="Stitch the final video">
              <button
                type="button"
                id="gen-back-script"
                className="btn btn-secondary btn-lg"
                onClick={() => goTo(stepPath(id, 2))}
                disabled={navigating}
              >
                ← Script
              </button>
              <div className="gen-footer-end">
                <div className="gen-footer-status">
                  <span className="gen-footer-count">
                    {readyCount}/{sceneCount} ready
                  </span>
                  <div
                    className={`gen-footer-note ${stitchTone}`}
                    role={stitchError ? 'alert' : undefined}
                    aria-live={stitchError ? undefined : 'polite'}
                  >
                    {stitching && <LoadingSpinner size="sm" />}
                    {stitchNote}
                  </div>
                </div>
                {primaryAction}
              </div>
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}

export default function GeneratePage() {
  const { id } = useParams();
  // A fresh instance per project, so unsaved edits and request state never leak between projects.
  return <GenerateVideos key={id} projectId={id} />;
}
