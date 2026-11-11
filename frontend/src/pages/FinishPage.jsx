import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { deleteField } from 'firebase/firestore';
import Layout from '../components/Layout';
import Stepper from '../components/Stepper';
import LoadingSpinner from '../components/LoadingSpinner';
import FinishCard from '../components/FinishCard';
import MusicCard from '../components/MusicCard';
import EndCardCard from '../components/EndCardCard';
import { useAuth } from '../hooks/useAuth';
import SaveIndicator from '../components/SaveIndicator';
import { useNow } from '../hooks/useNow';
import { useDoneNotifications } from '../hooks/useDoneNotifications';
import { updateProjectSettings, useProject, useScenes } from '../hooks/useProject';
import { useStorageUrl } from '../hooks/useStorageUrl';
import { stitchVideos } from '../services/api';
import { friendlyError } from '../utils/errors';
import { askToNotify } from '../utils/notify';
import {
  STEP,
  allScenesReady,
  currentFinalVideo,
  finalVideoChangeReason,
  formatElapsed,
  formatSceneList,
  hasOwnCaptionText,
  isSceneBusy,
  isSceneSkipped,
  isStitchStuck,
  isStitching,
  maxReachableStep,
  projectCaptionStyle,
  sceneCaptionText,
  sceneHasVideo,
  sceneLabels,
  scenesReadyCount,
  stepPath,
  stitchStartedMillis,
  takeCheck,
} from '../utils/projectProgress';

const SAVE_DELAY_MS = 800;

/** A frame of the first scene with a sample caption, so the styles can be compared before stitching. */
function CaptionPreview({ scene, style, text, portrait }) {
  const url = useStorageUrl(scene?.storageRef || scene?.videoUrl || '');
  const words = (text || 'This is how your captions look').split(/\s+/).filter(Boolean);
  const count = style === 'pop' ? 2 : style === 'minimal' ? 5 : 3;
  const sample = words.slice(0, count);
  return (
    <figure className={`cap-preview ${portrait ? 'is-portrait' : 'is-landscape'}`}>
      <div className="cap-preview-frame">
        {url ? <video src={`${url}#t=0.5`} muted playsInline preload="metadata" aria-hidden="true" /> : null}
        {style !== 'none' && (
          <p className={`cap-sample is-${style}`} aria-hidden="true">
            {sample.map((word, i) => (
              <span key={`${word}-${i}`} className={style === 'highlight' && i === sample.length - 1 ? 'is-active' : ''}>
                {word.replace(/[.,;:]+$/, '')}{' '}
              </span>
            ))}
          </p>
        )}
      </div>
      <figcaption className="field-hint">
        {style === 'none' ? 'No captions.' : 'Approximate preview. The final look is set when the video is stitched.'}
      </figcaption>
    </figure>
  );
}

function FinishVideo({ projectId: id }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { project, loading: projectLoading } = useProject(id);
  const { scenes, loading: scenesLoading } = useScenes(id);

  // Caption text being typed, per scene, shown on top of what is saved.
  const [drafts, setDrafts] = useState({});
  const draftsRef = useRef({});
  const timersRef = useRef({});
  const [saveState, setSaveState] = useState('idle');
  const [stitchRequesting, setStitchRequesting] = useState(false);
  const [stitchError, setStitchError] = useState('');

  const now = useNow(project?.status === 'stitching' || project?.musicStatus === 'generating');
  useDoneNotifications(project, scenes);

  const saveText = async (sceneId) => {
    clearTimeout(timersRef.current[sceneId]);
    delete timersRef.current[sceneId];
    if (!(sceneId in draftsRef.current)) return true;
    const text = draftsRef.current[sceneId];
    try {
      await updateProjectSettings(id, { [`captions.texts.${sceneId}`]: text });
      if (draftsRef.current[sceneId] === text) {
        const next = { ...draftsRef.current };
        delete next[sceneId];
        draftsRef.current = next;
        setDrafts(next);
      }
      setSaveState(Object.keys(timersRef.current).length ? 'saving' : 'saved');
      return true;
    } catch (err) {
      console.error(`Could not save the caption of scene ${sceneId}:`, err);
      setSaveState('error');
      return false;
    }
  };

  const flushAll = async () => {
    const results = await Promise.all(Object.keys(draftsRef.current).map(saveText));
    return results.every(Boolean);
  };

  const handleTextChange = (sceneId, value) => {
    draftsRef.current = { ...draftsRef.current, [sceneId]: value };
    setDrafts(draftsRef.current);
    clearTimeout(timersRef.current[sceneId]);
    timersRef.current[sceneId] = setTimeout(() => saveText(sceneId), SAVE_DELAY_MS);
    setSaveState('saving');
  };

  const handleUseScript = async (sceneId) => {
    clearTimeout(timersRef.current[sceneId]);
    delete timersRef.current[sceneId];
    const next = { ...draftsRef.current };
    delete next[sceneId];
    draftsRef.current = next;
    setDrafts(next);
    try {
      await updateProjectSettings(id, { [`captions.texts.${sceneId}`]: deleteField() });
      setSaveState('saved');
    } catch (err) {
      console.error(`Could not reset the caption of scene ${sceneId}:`, err);
      setSaveState('error');
    }
  };

  // Leaving the page saves what the timers had not saved yet.
  useEffect(() => {
    const pending = draftsRef;
    const timers = timersRef;
    return () => {
      Object.values(timers.current).forEach(clearTimeout);
      Object.entries(pending.current).forEach(([sceneId, text]) => {
        updateProjectSettings(id, { [`captions.texts.${sceneId}`]: text })
          .catch((err) => console.error(`Could not save the caption of scene ${sceneId}:`, err));
      });
    };
  }, [id]);

  const goTo = async (path) => {
    const ok = await flushAll();
    if (ok) navigate(path);
  };

  const handleStitch = async () => {
    setStitchError('');
    askToNotify();
    setStitchRequesting(true);
    try {
      // The server reads the caption text from the project, so pending edits are saved first.
      if (!(await flushAll())) {
        setStitchError("Couldn't save your caption edits, so the stitch wasn't started. Check your connection and try again.");
        return;
      }
      await stitchVideos(id);
      navigate(stepPath(id, STEP.EXPORT));
    } catch (err) {
      console.error('Could not start stitching:', err);
      setStitchError(friendlyError(err));
    } finally {
      setStitchRequesting(false);
    }
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

  const loading = projectLoading || scenesLoading;
  const labels = sceneLabels(scenes);
  const included = scenes.map((scene, idx) => ({ scene, label: labels[idx] })).filter(({ scene }) => !isSceneSkipped(scene));
  const style = projectCaptionStyle(project);
  const portrait = project?.settings?.aspectRatio !== '16:9';
  const previewScene = included.find(({ scene }) => sceneHasVideo(scene))?.scene || null;
  const textOf = (scene) => (scene.id in drafts ? drafts[scene.id] : sceneCaptionText(project, scene));

  const ready = allScenesReady(scenes);
  const readyCount = scenesReadyCount(scenes);
  const busy = included.filter(({ scene }) => isSceneBusy(scene)).map(({ label }) => label);
  const missing = included.filter(({ scene }) => !isSceneBusy(scene) && !sceneHasVideo(scene)).map(({ label }) => label);
  const stitching = isStitching(project, now);
  const stuck = isStitchStuck(project, now);
  const finalVideo = currentFinalVideo(project);
  // Unsaved caption edits count as a change too.
  const reason = finalVideo ? finalVideoChangeReason(finalVideo, scenes, project) : '';
  const upToDate = ready && finalVideo && !finalVideo.legacy && !reason && !stuck && !project?.stitchError && !Object.keys(drafts).length;
  const stitchElapsed = stitching ? (now - (stitchStartedMillis(project) || now)) / 1000 : 0;

  let note = '';
  let tone = '';
  if (stitchError) {
    note = stitchError;
    tone = 'is-error';
  } else if (stitching) {
    note = `Stitching your final video · ${formatElapsed(stitchElapsed)}`;
  } else if (!ready) {
    const parts = [];
    if (busy.length) parts.push(`${formatSceneList(busy)} ${busy.length === 1 ? 'is' : 'are'} still generating`);
    if (missing.length) parts.push(`${formatSceneList(missing)} ${missing.length === 1 ? 'needs' : 'need'} a video`);
    note = `${parts.join(' and ')}. Finish them on the Generate step first.`;
  } else if (stuck) {
    note = 'The last stitch stopped responding. Start it again.';
    tone = 'is-warning';
  } else if (project?.stitchError) {
    note = `The last stitch failed: ${project.stitchError}`;
    tone = 'is-error';
  } else if (reason) {
    note = reason;
    tone = 'is-warning';
  } else if (upToDate) {
    note = `Final video${finalVideo.version ? ` v${finalVideo.version}` : ''} already has these choices.`;
    tone = 'is-success';
  } else {
    note = 'Every scene has a video. Stitch them into your final video.';
    tone = 'is-success';
  }

  return (
    <Layout>
      <div className="container page-wrap">
        <Stepper
          currentStep={STEP.FINISH}
          maxReachableStep={maxReachableStep(project, scenes)}
          onStepClick={(step) => goTo(stepPath(id, step))}
        />

        <header className="page-head">
          <div className="page-head-text">
            <h1 className="page-title">Finish your video</h1>
            <p className="page-subtitle">
              Choose the captions, the cuts and the music. They are added when the scenes are stitched into one video.
            </p>
          </div>
          <SaveIndicator state={saveState} onRetry={flushAll} />
        </header>

        {loading ? (
          <div className="page-loading">
            <LoadingSpinner size="lg" label="Loading…" />
          </div>
        ) : scenes.length === 0 ? (
          <div className="card card-white empty-state">
            <h2 className="empty-state-title">No scenes yet</h2>
            <p className="empty-state-text">Write your script and generate the scenes first.</p>
            <div className="empty-state-actions">
              <button type="button" className="btn btn-primary" onClick={() => navigate(stepPath(id, STEP.SCRIPT))}>
                Go to Script
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="finish-layout">
              <div className="finish-main">
                <FinishCard project={project} disabled={stitching}>
                  {style !== 'none' && (
                    <div className="cap-texts">
                      <h3 className="export-subhead">Caption text</h3>
                      <p className="field-hint">
                        Starts as each scene&apos;s script. Change it when the speaker says something else in the take you kept,
                        or leave a scene empty to show no caption on it.
                      </p>
                      {included.map(({ scene, label }) => (
                        <div className="form-group cap-text" key={scene.id}>
                          <div className="cap-text-head">
                            <label className="label" htmlFor={`finish-caption-${scene.id}`}>Scene {label}</label>
                            {(hasOwnCaptionText(project, scene) || scene.id in drafts) && (
                              <button type="button" className="link-button" onClick={() => handleUseScript(scene.id)}>
                                Use the script again
                              </button>
                            )}
                          </div>
                          <textarea
                            id={`finish-caption-${scene.id}`}
                            className="textarea"
                            rows={2}
                            value={textOf(scene)}
                            disabled={stitching}
                            onChange={(e) => handleTextChange(scene.id, e.target.value)}
                            onBlur={() => saveText(scene.id)}
                            placeholder="No caption on this scene"
                          />
                          {(() => {
                            // The automatic check heard something else than the caption says.
                            const said = takeCheck(scene, scene.activeAttempt)?.spokenText || '';
                            const squash = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
                            if (!said || squash(said) === squash(textOf(scene))) return null;
                            return (
                              <p className="field-hint">
                                The take in use seems to say: “{said}”{' '}
                                <button type="button" className="link-button" onClick={() => handleTextChange(scene.id, said)} disabled={stitching}>
                                  Use this
                                </button>
                              </p>
                            );
                          })()}
                        </div>
                      ))}
                    </div>
                  )}
                </FinishCard>

                <MusicCard project={project} now={now} disabled={stitching} />
                <EndCardCard
                  project={project}
                  storagePrefix={user ? `users/${user.uid}/projects/${id}` : ''}
                  disabled={stitching}
                />
              </div>

              <aside className="finish-side">
                <CaptionPreview
                  scene={previewScene}
                  style={style}
                  text={included.length ? textOf(included[0].scene) : ''}
                  portrait={portrait}
                />
              </aside>
            </div>

            <div className="gen-footer" role="region" aria-label="Stitch the final video">
              <button type="button" id="finish-back-generate" className="btn btn-secondary btn-lg" onClick={() => goTo(stepPath(id, STEP.GENERATE))}>
                ← Generate
              </button>
              <div className="gen-footer-end">
                <div className="gen-footer-status">
                  <span className="gen-footer-count">{readyCount}/{included.length} ready</span>
                  <p className={`gen-footer-note ${tone}`} role={stitchError ? 'alert' : undefined} aria-live={stitchError ? undefined : 'polite'}>
                    {stitching && <LoadingSpinner size="sm" />}
                    {note}
                  </p>
                </div>
                {(finalVideo || stitching) && (
                  <button type="button" id="finish-open-export" className={`btn btn-lg ${upToDate || stitching ? 'btn-primary' : 'btn-ghost'}`} onClick={() => goTo(stepPath(id, STEP.EXPORT))}>
                    {stitching ? 'Watch progress' : upToDate ? 'View final video' : 'View current version'}
                  </button>
                )}
                {!stitching && !upToDate && (
                  <button type="button" id="finish-stitch" className="btn btn-primary btn-lg" onClick={handleStitch} disabled={!ready || stitchRequesting}>
                    {stitchRequesting ? <LoadingSpinner size="sm" label="Starting…" /> : finalVideo ? 'Stitch new version' : 'Stitch final video'}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}

export default function FinishPage() {
  const { id } = useParams();
  // A fresh instance per project, so caption edits never leak from one project into another.
  return <FinishVideo key={id} projectId={id} />;
}
