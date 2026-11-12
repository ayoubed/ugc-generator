import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { deleteField } from 'firebase/firestore';
import Layout from '../components/Layout';
import Stepper from '../components/Stepper';
import LoadingSpinner from '../components/LoadingSpinner';
import VideoPreview from '../components/VideoPreview';
import CaptionPreview from '../components/CaptionPreview';
import TakesUsed from '../components/TakesUsed';
import FinishCard from '../components/FinishCard';
import MusicCard from '../components/MusicCard';
import EndCardCard from '../components/EndCardCard';
import SaveIndicator from '../components/SaveIndicator';
import { useAuth } from '../hooks/useAuth';
import { useNow } from '../hooks/useNow';
import { useDoneNotifications } from '../hooks/useDoneNotifications';
import { useFinalVideoUrl } from '../hooks/useFinalVideoUrl';
import { createProject, updateProjectSettings, useProject, useScenes } from '../hooks/useProject';
import { stitchVideos } from '../services/api';
import { friendlyError } from '../utils/errors';
import { askToNotify } from '../utils/notify';
import { downloadName, notReadyReason, versionKey, versionName } from '../utils/finalVideo';
import {
  STEP,
  allScenesReady,
  currentFinalVideo,
  finalVideoChangeReason,
  finalVideoVersions,
  formatDateTime,
  formatElapsed,
  hasOwnCaptionText,
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

/**
 * The last step: choose captions, cuts, music and the end card, stitch, then watch and download.
 * The result (player, versions) sits beside the choices, so trying another caption style or
 * track is one stitch away without leaving the page.
 */
function ProjectVideo({ projectId: id }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { project, loading: projectLoading } = useProject(id);
  const { scenes, loading: scenesLoading } = useScenes(id);

  // ── Caption text being typed, per scene, shown on top of what is saved ──
  const [drafts, setDrafts] = useState({});
  const draftsRef = useRef({});
  const timersRef = useRef({});
  const [saveState, setSaveState] = useState('idle');

  // ── Versions and stitching ──
  const [selectedKey, setSelectedKey] = useState(null); // null = follow the latest version
  const [freshVersion, setFreshVersion] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const [stitchRequesting, setStitchRequesting] = useState(false);
  const [stitchRequestError, setStitchRequestError] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const stageRef = useRef(null);

  const now = useNow(project?.status === 'stitching' || project?.musicStatus === 'generating');
  useDoneNotifications(project, scenes);
  const versions = finalVideoVersions(project);
  const current = currentFinalVideo(project);

  // When a stitch finishes while this page is open, switch to the new version and say so.
  // Only after this page saw the stitch running, so a cached snapshot replaced by the
  // server's copy is never announced as a new version.
  const [sawStitching, setSawStitching] = useState(false);
  if (project?.status === 'stitching' && !sawStitching) setSawStitching(true);

  const currentKey = project ? versionKey(current) || 'none' : null;
  const [seenKey, setSeenKey] = useState(currentKey);
  if (currentKey !== seenKey) {
    setSeenKey(currentKey);
    if (seenKey !== null && current?.version && sawStitching) {
      setFreshVersion(current.version);
      setSelectedKey(null);
      setDownloadFailed(false);
    }
  }

  // The new version plays at the top of the page; bring it into view.
  useEffect(() => {
    if (freshVersion) stageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [freshVersion]);

  const selected = (selectedKey && versions.find((v) => versionKey(v) === selectedKey)) || current;
  const { url: videoUrl, loading: urlLoading } = useFinalVideoUrl(selected);

  const selectVersion = (video) => {
    setSelectedKey(versionKey(video) === versionKey(current) ? null : versionKey(video));
    setDownloadFailed(false);
  };

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
    if (await flushAll()) navigate(path);
  };

  const handleStitch = async () => {
    setStitchRequestError('');
    askToNotify();
    setFreshVersion(null);
    setStitchRequesting(true);
    try {
      // The server reads the caption text from the project, so pending edits are saved first.
      if (!(await flushAll())) {
        setStitchRequestError("Couldn't save your caption edits, so the stitch wasn't started. Check your connection and try again.");
        return;
      }
      await stitchVideos(id);
      setSawStitching(true);
    } catch (err) {
      console.error('Could not start stitching:', err);
      setStitchRequestError(friendlyError(err));
    } finally {
      setStitchRequesting(false);
    }
  };

  const handleDownload = async () => {
    if (!videoUrl) return;
    setDownloadFailed(false);
    setDownloading(true);
    try {
      const response = await fetch(videoUrl);
      if (!response.ok) throw new Error(`Download failed (${response.status})`);
      const blobUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = downloadName(project, selected);
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Revoking right away can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } catch (err) {
      console.error('Download error:', err);
      setDownloadFailed(true);
    } finally {
      setDownloading(false);
    }
  };

  const handleNewProject = async () => {
    setCreateError('');
    setCreating(true);
    try {
      navigate(stepPath(await createProject(), STEP.IDEA));
    } catch (err) {
      console.error('Could not create a project:', err);
      setCreateError(friendlyError(err));
      setCreating(false);
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
  const settings = project?.settings || {};
  const portrait = settings.aspectRatio !== '16:9';
  const labels = sceneLabels(scenes);
  const included = scenes.map((scene, idx) => ({ scene, label: labels[idx] })).filter(({ scene }) => !isSceneSkipped(scene));
  const style = projectCaptionStyle(project);
  const previewScene = included.find(({ scene }) => sceneHasVideo(scene))?.scene || null;
  const textOf = (scene) => (scene.id in drafts ? drafts[scene.id] : sceneCaptionText(project, scene));

  const ready = allScenesReady(scenes);
  const readyCount = scenesReadyCount(scenes);
  const waitingReason = ready ? '' : notReadyReason(scenes);
  const stitching = isStitching(project, now);
  const stuck = isStitchStuck(project, now);
  const stitchError = !stitching && !stuck ? project?.stitchError || '' : '';
  const reason = current ? finalVideoChangeReason(current, scenes, project) : '';
  // Unsaved caption edits count as a change too.
  const upToDate = ready && current && !current.legacy && !reason && !stuck && !stitchError && !Object.keys(drafts).length;
  const stitchElapsed = stitching ? (now - (stitchStartedMillis(project) || now)) / 1000 : 0;
  const isLatestSelected = Boolean(selected) && versionKey(selected) === versionKey(current);

  let note = '';
  let tone = '';
  if (stitchRequestError) {
    note = stitchRequestError;
    tone = 'is-error';
  } else if (stitching) {
    note = `Stitching · ${formatElapsed(stitchElapsed)}. It keeps going if you leave this page.`;
  } else if (!ready) {
    note = `${waitingReason}. Finish them on the Generate step first.`;
  } else if (stuck) {
    note = 'The last stitch stopped responding. Start it again.';
    tone = 'is-warning';
  } else if (stitchError) {
    note = `The last stitch failed: ${stitchError}`;
    tone = 'is-error';
  } else if (reason) {
    note = reason;
    tone = 'is-warning';
  } else if (upToDate) {
    note = `${versionName(current)} already has these choices.`;
    tone = 'is-success';
  } else if (current) {
    note = 'Stitch again to be sure the video uses the takes and choices you see here.';
  } else {
    note = 'Every scene has a video. Stitch them into your final video.';
    tone = 'is-success';
  }

  // A short message for screen readers when the stitch state changes.
  let liveMessage = '';
  if (stitching) liveMessage = 'Stitching your final video.';
  else if (freshVersion) liveMessage = `Version ${freshVersion} of your final video is ready.`;
  else if (stuck) liveMessage = 'Stitching stopped responding.';
  else if (stitchError) liveMessage = 'Stitching failed.';

  const stage = (
    <div className="video-result" ref={stageRef}>
      {freshVersion && current?.version === freshVersion && !stitching && (
        <div className="export-alert is-success">
          <div className="export-alert-text">
            <p className="export-alert-title">
              {freshVersion === 1 ? 'Your final video is ready' : `Version ${freshVersion} is ready`}
            </p>
            <p>Watch it, then download it.</p>
          </div>
          <button type="button" id="video-dismiss-fresh" className="btn btn-ghost btn-sm export-alert-dismiss" onClick={() => setFreshVersion(null)} aria-label="Dismiss">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}

      {stitching && (
        <div className="music-status" role="status">
          <LoadingSpinner size="sm" />
          <span>
            {current ? 'Stitching a new version' : 'Stitching your final video'} · {formatElapsed(stitchElapsed)}
          </span>
        </div>
      )}

      {current && selected ? (
        <>
          <section className={`export-stage ${portrait ? 'is-portrait' : 'is-landscape'}`} aria-label={`${versionName(selected)} player`}>
            <div className="export-player">
              {urlLoading ? (
                <div className="export-player-state" style={{ aspectRatio: portrait ? '9 / 16' : '16 / 9' }}>
                  <LoadingSpinner size="md" label="Loading video…" />
                </div>
              ) : videoUrl ? (
                <VideoPreview key={videoUrl} src={videoUrl} aspectRatio={portrait ? '9/16' : '16/9'} />
              ) : (
                <div className="export-player-state is-missing" style={{ aspectRatio: portrait ? '9 / 16' : '16 / 9' }}>
                  <p>This video file can&apos;t be found. Stitch a new version to replace it.</p>
                </div>
              )}
            </div>
          </section>

          <section className="card card-white export-details" aria-labelledby="video-version-title">
            <div className="export-details-head">
              <h2 className="export-details-title" id="video-version-title">{versionName(selected)}</h2>
              <span className={`export-pill ${isLatestSelected ? 'is-latest' : ''}`}>{isLatestSelected ? 'Latest' : 'Older version'}</span>
            </div>
            <p className="field-hint" style={{ marginTop: 0 }}>
              {[formatDateTime(selected.createdAt), `${selected.sceneCount || selected.scenes?.length || included.length} scenes`,
                `${settings.aspectRatio || '9:16'} · ${settings.resolution || '720p'}`].filter(Boolean).join(' · ')}
            </p>

            <div className="export-download">
              <button type="button" id="video-download" className="btn btn-primary btn-lg export-download-btn" onClick={handleDownload} disabled={!videoUrl || downloading}>
                {downloading ? (
                  <LoadingSpinner size="sm" label="Preparing download…" />
                ) : (
                  <>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    {selected.version ? `Download version ${selected.version}` : 'Download video'}
                  </>
                )}
              </button>
              {videoUrl && (
                <a id="video-open-tab" className="export-open-link" href={videoUrl} target="_blank" rel="noopener noreferrer">
                  Open in a new tab
                </a>
              )}
              {downloadFailed && (
                <p className="export-note is-error" role="alert">
                  The download didn&apos;t start. Open the video in a new tab and save it from there.
                </p>
              )}
            </div>

            {isLatestSelected && reason && !stitching && (
              <p className="export-note is-warning"><strong>Out of date.</strong> {reason}</p>
            )}
            {!isLatestSelected && (
              <div className="export-note">
                <p>You&apos;re watching an older version. {versionName(current)} is the latest.</p>
                <button type="button" id="video-show-latest" className="link-button" onClick={() => selectVersion(current)}>
                  Show the latest version
                </button>
              </div>
            )}

            <TakesUsed video={selected} scenes={scenes} />
          </section>

          {versions.length > 1 && (
            <section className="card card-white export-versions" aria-labelledby="video-versions-title">
              <h2 className="export-section-title" id="video-versions-title">
                All versions <span className="export-count">{versions.length}</span>
              </h2>
              <ul className="export-version-list">
                {versions.map((video) => {
                  const key = versionKey(video);
                  const isSelected = key === versionKey(selected);
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        id={`video-version-${key}`}
                        className={`export-version ${isSelected ? 'is-selected' : ''}`}
                        aria-pressed={isSelected}
                        onClick={() => selectVersion(video)}
                      >
                        <span className="export-version-name">{versionName(video)}</span>
                        <span className="export-version-date">{formatDateTime(video.createdAt) || 'Date unknown'}</span>
                        {key === versionKey(current) && <span className="export-pill is-latest">Latest</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </>
      ) : (
        <>
          <CaptionPreview
            scene={previewScene}
            style={style}
            text={included.length ? textOf(included[0].scene) : ''}
            portrait={portrait}
          />
          <p className="field-hint">
            {ready
              ? 'Your video appears here once it is stitched.'
              : `${readyCount} of ${included.length} scenes are ready. Your video appears here once they are stitched.`}
          </p>
        </>
      )}
    </div>
  );

  return (
    <Layout>
      <div className="container page-wrap">
        <Stepper
          currentStep={STEP.VIDEO}
          maxReachableStep={maxReachableStep(project, scenes)}
          onStepClick={(step) => goTo(stepPath(id, step))}
        />

        <header className="page-head">
          <div className="page-head-text">
            <h1 className="page-title">{current ? 'Your video' : 'Finish your video'}</h1>
            <p className="page-subtitle">
              Choose the captions, the cuts, the music and the end card, then stitch. Change anything and stitch again:
              earlier versions stay here.
            </p>
          </div>
          <SaveIndicator state={saveState} onRetry={flushAll} />
        </header>

        <p className="visually-hidden" role="status">{liveMessage}</p>

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
            <div className="video-layout">
              {stage}

              <div className="video-choices">
                <FinishCard project={project} disabled={stitching}>
                  {current && style !== 'none' && (
                    <div className="video-style-preview">
                      <CaptionPreview scene={previewScene} style={style} text={included.length ? textOf(included[0].scene) : ''} portrait={portrait} />
                    </div>
                  )}
                  {style !== 'none' && (
                    <details className="cap-texts">
                      <summary className="export-subhead">Caption text for each scene</summary>
                      <p className="field-hint">
                        Starts as each scene&apos;s script. Change it when the speaker says something else in the take you kept,
                        or leave a scene empty to show no caption on it.
                      </p>
                      {included.map(({ scene, label }) => (
                        <div className="form-group cap-text" key={scene.id}>
                          <div className="cap-text-head">
                            <label className="label" htmlFor={`video-caption-${scene.id}`}>Scene {label}</label>
                            {(hasOwnCaptionText(project, scene) || scene.id in drafts) && (
                              <button type="button" className="link-button" onClick={() => handleUseScript(scene.id)}>
                                Use the script again
                              </button>
                            )}
                          </div>
                          <textarea
                            id={`video-caption-${scene.id}`}
                            className="textarea"
                            rows={2}
                            value={textOf(scene)}
                            disabled={stitching}
                            onChange={(e) => handleTextChange(scene.id, e.target.value)}
                            onBlur={() => saveText(scene.id)}
                            placeholder="No caption on this scene"
                          />
                          <HeardInstead
                            said={takeCheck(scene, scene.activeAttempt)?.spokenText || ''}
                            caption={textOf(scene)}
                            disabled={stitching}
                            onUse={(said) => handleTextChange(scene.id, said)}
                          />
                        </div>
                      ))}
                    </details>
                  )}
                </FinishCard>

                <MusicCard project={project} now={now} disabled={stitching} />
                <EndCardCard
                  project={project}
                  storagePrefix={user ? `users/${user.uid}/projects/${id}` : ''}
                  disabled={stitching}
                />

                <div className="page-actions">
                  <Link to="/" id="video-dashboard" className="btn btn-ghost">All videos</Link>
                  <div className="page-actions-end">
                    {createError && <p className="page-actions-note is-error" role="alert">{createError}</p>}
                    <button type="button" id="video-new-project" className="btn btn-secondary" onClick={handleNewProject} disabled={creating}>
                      {creating ? <LoadingSpinner size="sm" label="Creating…" /> : '+ New video'}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="gen-footer" role="region" aria-label="Stitch the final video">
              <button type="button" id="video-back-generate" className="btn btn-secondary btn-lg" onClick={() => goTo(stepPath(id, STEP.GENERATE))}>
                ← Generate
              </button>
              <div className="gen-footer-end">
                <div className="gen-footer-status">
                  <span className="gen-footer-count">{readyCount}/{included.length} ready</span>
                  <div className={`gen-footer-note ${tone}`} role={stitchRequestError ? 'alert' : undefined} aria-live={stitchRequestError ? undefined : 'polite'}>
                    {stitching && <LoadingSpinner size="sm" />}
                    {note}
                  </div>
                </div>
                {upToDate && !stitching ? (
                  <button type="button" id="video-download-footer" className="btn btn-primary btn-lg" onClick={handleDownload} disabled={!videoUrl || downloading}>
                    {downloading ? <LoadingSpinner size="sm" label="Preparing…" /> : 'Download'}
                  </button>
                ) : (
                  <button type="button" id="video-stitch" className="btn btn-primary btn-lg" onClick={handleStitch} disabled={!ready || stitching || stitchRequesting}>
                    {stitchRequesting ? <LoadingSpinner size="sm" label="Starting…" /> : stitching ? 'Stitching…' : current ? 'Stitch new version' : 'Stitch final video'}
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

/** The automatic check heard something else than the caption says: offer what it heard. */
function HeardInstead({ said, caption, disabled, onUse }) {
  const squash = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!said || squash(said) === squash(caption)) return null;
  return (
    <p className="field-hint">
      The take in use seems to say: “{said}”{' '}
      <button type="button" className="link-button" onClick={() => onUse(said)} disabled={disabled}>
        Use this
      </button>
    </p>
  );
}

export default function VideoPage() {
  const { id } = useParams();
  // A fresh instance per project, so caption edits and the selected version never leak between projects.
  return <ProjectVideo key={id} projectId={id} />;
}
