import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Layout from '../components/Layout';
import Stepper from '../components/Stepper';
import VideoPreview from '../components/VideoPreview';
import LoadingSpinner from '../components/LoadingSpinner';
import { useNow } from '../hooks/useNow';
import { useDoneNotifications } from '../hooks/useDoneNotifications';
import { askToNotify } from '../utils/notify';
import { createProject, useProject, useScenes } from '../hooks/useProject';
import { resolveStorageUrl, stitchVideos } from '../services/api';
import { friendlyError } from '../utils/errors';
import {
  allScenesReady,
  currentFinalVideo,
  finalVideoChangeReason,
  finalVideoVersions,
  formatDateTime,
  formatElapsed,
  formatSceneList,
  includedScenes,
  isSceneBusy,
  isSceneSkipped,
  isStitchStuck,
  isStitching,
  maxReachableStep,
  sceneHasVideo,
  sceneLabels,
  scenesReadyCount,
  stepPath,
  stitchStartedMillis,
} from '../utils/projectProgress';

function versionKey(video) {
  if (!video) return '';
  return video.version ? `v${video.version}` : 'legacy';
}

function versionName(video) {
  return video?.version ? `Version ${video.version}` : 'Final video';
}

function slugify(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
}

function downloadName(project, video) {
  const base = slugify(project?.title || project?.idea) || 'ugc-video';
  return `${base}${video?.version ? `-v${video.version}` : ''}.mp4`;
}

/** Why the scenes can't be stitched yet, e.g. "Scene 2 is still generating and Scene 3 needs a video". */
function notReadyReason(scenes) {
  const busy = [];
  const missing = [];
  const labels = sceneLabels(scenes);
  scenes.forEach((scene, idx) => {
    if (isSceneSkipped(scene)) return;
    if (isSceneBusy(scene)) busy.push(labels[idx]);
    else if (!sceneHasVideo(scene)) missing.push(labels[idx]);
  });
  const parts = [];
  if (busy.length) parts.push(`${formatSceneList(busy)} ${busy.length === 1 ? 'is' : 'are'} still generating`);
  if (missing.length) parts.push(`${formatSceneList(missing)} ${missing.length === 1 ? 'needs' : 'need'} a video`);
  return parts.join(' and ');
}

/**
 * A playable URL for a final video. A fresh URL from the storage path is preferred, because the
 * URL saved at stitch time can expire. Resolved URLs are cached, so switching versions is instant.
 */
function useFinalVideoUrl(video) {
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

function TakesUsed({ video, scenes }) {
  const used = video?.scenes || [];
  if (!used.length) return null;
  return (
    <div className="export-takes">
      <h3 className="export-subhead">Takes in this version</h3>
      <ul className="export-take-list">
        {used.map((entry, idx) => {
          const scene = scenes.find((s) => s.id === entry.sceneId);
          const usedAttempt = entry.attempt ?? null;
          const nowAttempt = scene ? scene.activeAttempt ?? null : null;
          let note = '';
          if (!scene) note = 'Scene deleted since';
          else if (nowAttempt !== usedAttempt) note = nowAttempt ? `Now uses take ${nowAttempt}` : 'Changed since';
          return (
            <li key={`${entry.sceneId}-${idx}`} className={`export-take ${note ? 'is-changed' : ''}`}>
              <span className="export-take-name">Scene {scene ? sceneLabels(scenes)[scenes.indexOf(scene)] : idx + 1}</span>
              <span className="export-take-value">{usedAttempt ? `Take ${usedAttempt}` : 'Original take'}</span>
              {note && <span className="export-take-note">{note}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ExportVideo({ projectId: id }) {
  const navigate = useNavigate();
  const { project, loading: projectLoading } = useProject(id);
  const { scenes, loading: scenesLoading } = useScenes(id);

  const [selectedKey, setSelectedKey] = useState(null); // null = follow the latest version
  const [freshVersion, setFreshVersion] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const [stitchRequesting, setStitchRequesting] = useState(false);
  const [stitchRequestError, setStitchRequestError] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const now = useNow(project?.status === 'stitching');
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

  const selected = (selectedKey && versions.find((v) => versionKey(v) === selectedKey)) || current;
  const { url: videoUrl, loading: urlLoading } = useFinalVideoUrl(selected);

  const selectVersion = (video) => {
    setSelectedKey(versionKey(video) === versionKey(current) ? null : versionKey(video));
    setDownloadFailed(false);
  };

  const handleStitch = async () => {
    setStitchRequestError('');
    askToNotify();
    setFreshVersion(null);
    setStitchRequesting(true);
    try {
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
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
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
      const newId = await createProject();
      navigate(stepPath(newId, 1));
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
  const isPortrait = settings.aspectRatio !== '16:9';
  // Skipped scenes are left out of the final video.
  const sceneCount = includedScenes(scenes).length;
  const readyCount = scenesReadyCount(scenes);
  const ready = allScenesReady(scenes);
  const stitching = isStitching(project, now);
  const stuck = isStitchStuck(project, now);
  const stitchError = !stitching && !stuck ? project?.stitchError || '' : '';
  const canStitch = ready && !stitching && !stitchRequesting;
  const reason = current ? finalVideoChangeReason(current, scenes, project) : '';
  const stitchElapsed = stitching ? (now - (stitchStartedMillis(project) || now)) / 1000 : 0;
  const isLatestSelected = Boolean(selected) && versionKey(selected) === versionKey(current);
  const waitingReason = ready ? '' : notReadyReason(scenes);

  const stitchButton = (label, className = 'btn btn-primary', buttonId = 'export-stitch') => (
    <button type="button" id={buttonId} className={className} onClick={handleStitch} disabled={!canStitch}>
      {stitchRequesting ? (
        <LoadingSpinner size="sm" label="Starting…" />
      ) : (
        <>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <rect x="2" y="6" width="6" height="12" rx="1.5" />
            <rect x="9" y="6" width="6" height="12" rx="1.5" />
            <rect x="16" y="6" width="6" height="12" rx="1.5" />
          </svg>
          {label}
        </>
      )}
    </button>
  );

  const goToGenerate = (label = 'Go to Generate') => (
    <button type="button" id="export-go-generate" className="btn btn-secondary" onClick={() => navigate(stepPath(id, 3))}>
      {label}
    </button>
  );

  const goToFinish = (
    <button type="button" id="export-go-finish-empty" className="btn btn-secondary" onClick={() => navigate(stepPath(id, 4))}>
      Captions, cuts and music
    </button>
  );

  // A short message for screen readers when the stitch state changes.
  let liveMessage = '';
  if (stitching) liveMessage = 'Stitching your final video.';
  else if (freshVersion) liveMessage = `Version ${freshVersion} of your final video is ready.`;
  else if (stuck) liveMessage = 'Stitching stopped responding.';
  else if (stitchError) liveMessage = 'Stitching failed.';

  // Status shown above the player. When it offers a stitch button, the empty state below does not.
  let notice = null;
  let noticeOffersStitch = false;
  if (stitching) {
    notice = (
      <section className="card card-white export-progress" aria-labelledby="export-progress-title">
        <div className="export-progress-row">
          <span className="export-progress-icon" aria-hidden="true">
            <LoadingSpinner size="md" />
          </span>
          <div className="export-progress-text">
            <h2 className="export-progress-title" id="export-progress-title">
              {current ? 'Stitching a new version' : 'Stitching your final video'}
            </h2>
            <p className="export-progress-sub">
              Joining {sceneCount} {sceneCount === 1 ? 'scene' : 'scenes'} into one video. This usually takes under a
              minute, and it keeps going if you leave this page.
            </p>
          </div>
          <span className="export-elapsed" role="timer" aria-label={`Elapsed time ${formatElapsed(stitchElapsed)}`}>
            {formatElapsed(stitchElapsed)}
          </span>
        </div>
      </section>
    );
  } else if (stuck) {
    noticeOffersStitch = true;
    notice = (
      <div className="export-alert is-warning">
        <div className="export-alert-text">
          <p className="export-alert-title">Stitching stopped responding</p>
          <p>It started a while ago and never finished, for example because the server restarted. Start it again.</p>
          {!ready && waitingReason && <p>Not ready to stitch again yet: {waitingReason}.</p>}
        </div>
        <div className="export-alert-actions">{ready ? stitchButton('Stitch again') : goToGenerate()}</div>
      </div>
    );
  } else if (stitchError) {
    noticeOffersStitch = true;
    notice = (
      <div className="export-alert is-error">
        <div className="export-alert-text">
          <p className="export-alert-title">The last stitch failed</p>
          <p>
            {current
              ? `${versionName(current)} is still available below. Try again, or make a new take of a scene if it keeps failing.`
              : 'Try again, or make a new take of a scene if it keeps failing.'}
          </p>
          {!ready && waitingReason && <p>Not ready to stitch again yet: {waitingReason}.</p>}
          <details className="export-alert-details">
            <summary>Error details</summary>
            <code>{stitchError}</code>
          </details>
        </div>
        <div className="export-alert-actions">{ready ? stitchButton('Try again') : goToGenerate()}</div>
      </div>
    );
  } else if (freshVersion && current?.version === freshVersion) {
    notice = (
      <div className="export-alert is-success">
        <div className="export-alert-text">
          <p className="export-alert-title">
            {freshVersion === 1 ? 'Your final video is ready' : `Version ${freshVersion} is ready`}
          </p>
          <p>Watch it below, then download it.</p>
        </div>
        <button
          type="button"
          id="export-dismiss-fresh"
          className="btn btn-ghost btn-sm export-alert-dismiss"
          onClick={() => setFreshVersion(null)}
          aria-label="Dismiss"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    );
  }

  let title = 'Final video';
  let subtitle = 'Join your scene videos into one video you can download.';
  if (current) {
    title = 'Your final video';
    subtitle = 'Watch and download it. After changing takes, stitch a new version. Earlier versions stay here.';
  } else if (stitching) {
    title = 'Stitching your final video';
    subtitle = 'Your scene videos are being joined into one video.';
  }

  // When an alert above already offers the next step (retry or go to Generate), the empty state is left out.
  let emptyState = null;
  if (!current && !stitching && !noticeOffersStitch) {
    if (scenes.length === 0) {
      emptyState = (
        <div className="card card-white empty-state">
          <h2 className="empty-state-title">No scenes yet</h2>
          <p className="empty-state-text">Write your script first. Each scene becomes one video, and the videos are joined here.</p>
          <div className="empty-state-actions">
            <button type="button" id="export-go-script" className="btn btn-primary" onClick={() => navigate(stepPath(id, 2))}>
              Go to Script
            </button>
          </div>
        </div>
      );
    } else if (ready) {
      emptyState = (
        <div className="card card-white empty-state">
          <span className="empty-state-icon" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <rect x="2" y="6" width="6" height="12" rx="1.5" />
              <rect x="9" y="6" width="6" height="12" rx="1.5" />
              <rect x="16" y="6" width="6" height="12" rx="1.5" />
            </svg>
          </span>
          <h2 className="empty-state-title">Ready to stitch</h2>
          <p className="empty-state-text">
            All {sceneCount} {sceneCount === 1 ? 'scene has a video' : 'scenes have a video'}. Stitch them into your final video.
          </p>
          <div className="empty-state-actions">
            {goToFinish}
            {stitchButton('Stitch all videos', 'btn btn-primary', 'export-stitch-empty')}
          </div>
        </div>
      );
    } else {
      emptyState = (
        <div className="card card-white empty-state">
          <h2 className="empty-state-title">No final video yet</h2>
          <p className="empty-state-text">
            {readyCount} of {sceneCount} scenes are ready. {waitingReason}. Finish them on the Generate step, then stitch
            them here.
          </p>
          <div className="empty-state-actions">{goToGenerate()}</div>
        </div>
      );
    }
  }

  return (
    <Layout>
      <div className="container page-wrap">
        <Stepper
          currentStep={5}
          maxReachableStep={maxReachableStep(project, scenes)}
          onStepClick={(step) => navigate(stepPath(id, step))}
        />

        <header className="page-head">
          <div className="page-head-text">
            <h1 className="page-title">{title}</h1>
            <p className="page-subtitle">{subtitle}</p>
          </div>
        </header>

        <p className="visually-hidden" role="status">{liveMessage}</p>

        {loading ? (
          <div className="page-loading">
            <LoadingSpinner size="lg" label="Loading your video…" />
          </div>
        ) : (
          <>
            {notice}
            {stitchRequestError && (
              <p className="page-alert" role="alert">
                {stitchRequestError}
              </p>
            )}

            {emptyState}


            {current && selected && (
              <div className="export-layout">
                <section
                  className={`export-stage ${isPortrait ? 'is-portrait' : 'is-landscape'}`}
                  aria-label={`${versionName(selected)} player`}
                >
                  <div className="export-player">
                    {urlLoading ? (
                      <div className="export-player-state" style={{ aspectRatio: isPortrait ? '9 / 16' : '16 / 9' }}>
                        <LoadingSpinner size="md" label="Loading video…" />
                      </div>
                    ) : videoUrl ? (
                      <VideoPreview key={videoUrl} src={videoUrl} aspectRatio={isPortrait ? '9/16' : '16/9'} />
                    ) : (
                      <div className="export-player-state is-missing" style={{ aspectRatio: isPortrait ? '9 / 16' : '16 / 9' }}>
                        <p>This video file can't be found. Stitch a new version to replace it.</p>
                      </div>
                    )}
                  </div>
                </section>

                <aside className="export-side">
                  <section className="card card-white export-details" aria-labelledby="export-version-title">
                    <div className="export-details-head">
                      <h2 className="export-details-title" id="export-version-title">{versionName(selected)}</h2>
                      {isLatestSelected ? (
                        <span className="export-pill is-latest">Latest</span>
                      ) : (
                        <span className="export-pill">Older version</span>
                      )}
                    </div>

                    <dl className="export-meta">
                      {formatDateTime(selected.createdAt) && (
                        <div>
                          <dt>Stitched</dt>
                          <dd>{formatDateTime(selected.createdAt)}</dd>
                        </div>
                      )}
                      <div>
                        <dt>Scenes</dt>
                        <dd>{selected.sceneCount || selected.scenes?.length || '—'}</dd>
                      </div>
                      <div>
                        <dt>Format</dt>
                        <dd>
                          {settings.aspectRatio || '9:16'} · {settings.resolution || '1080p'} · MP4
                        </dd>
                      </div>
                    </dl>

                    <div className="export-download">
                      <button
                        type="button"
                        id="export-download"
                        className="btn btn-primary btn-lg export-download-btn"
                        onClick={handleDownload}
                        disabled={!videoUrl || downloading}
                      >
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
                        <a id="export-open-tab" className="export-open-link" href={videoUrl} target="_blank" rel="noopener noreferrer">
                          Open in a new tab
                        </a>
                      )}
                      {downloadFailed && (
                        <p className="export-note is-error" role="alert">
                          The download didn&apos;t start. Open the video in a new tab and save it from there.
                        </p>
                      )}
                    </div>

                    {isLatestSelected && reason && (
                      <div className="export-note is-warning">
                        <p>
                          <strong>Out of date.</strong> {reason}
                        </p>
                        {stitching ? (
                          <p>A new version is being stitched.</p>
                        ) : !ready ? (
                          <p>{waitingReason} before you can stitch a new version.</p>
                        ) : (
                          !noticeOffersStitch && stitchButton('Stitch new version', 'btn btn-secondary btn-sm', 'export-stitch-new')
                        )}
                      </div>
                    )}

                    {isLatestSelected && !reason && !selected.scenes?.length && !stitching && (
                      <div className="export-note">
                        <p>This video was made before takes were tracked. Stitch again to be sure it uses the takes you picked.</p>
                        {ready && !noticeOffersStitch && stitchButton('Stitch new version', 'btn btn-secondary btn-sm', 'export-stitch-new')}
                      </div>
                    )}

                    {!isLatestSelected && (
                      <div className="export-note">
                        <p>You&apos;re watching an older version. {versionName(current)} is the latest.</p>
                        <button type="button" id="export-show-latest" className="link-button" onClick={() => selectVersion(current)}>
                          Show the latest version
                        </button>
                      </div>
                    )}

                    <TakesUsed video={selected} scenes={scenes} />
                  </section>

                  <section className="card card-white export-details">
                    <h2 className="export-section-title">Captions, cuts and music</h2>
                    <p className="field-hint" style={{ marginBottom: '12px' }}>
                      Change them on the Finish step, then stitch a new version. This version stays here.
                    </p>
                    <button type="button" id="export-go-finish" className="btn btn-secondary btn-sm" onClick={() => navigate(stepPath(id, 4))}>
                      Open the Finish step
                    </button>
                  </section>

                  {versions.length > 1 && (
                    <section className="card card-white export-versions" aria-labelledby="export-versions-title">
                      <h2 className="export-section-title" id="export-versions-title">
                        All versions <span className="export-count">{versions.length}</span>
                      </h2>
                      <ul className="export-version-list">
                        {versions.map((video) => {
                          const key = versionKey(video);
                          const isSelected = key === versionKey(selected);
                          const isLatest = key === versionKey(current);
                          return (
                            <li key={key}>
                              <button
                                type="button"
                                id={`export-version-${key}`}
                                className={`export-version ${isSelected ? 'is-selected' : ''}`}
                                aria-pressed={isSelected}
                                onClick={() => selectVersion(video)}
                              >
                                <span className="export-version-name">{versionName(video)}</span>
                                <span className="export-version-date">{formatDateTime(video.createdAt) || 'Date unknown'}</span>
                                {isLatest && <span className="export-pill is-latest">Latest</span>}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  )}
                </aside>
              </div>
            )}

            <div className="page-actions">
              <button type="button" id="export-back-finish" className="btn btn-secondary" onClick={() => navigate(stepPath(id, 4))}>
                ← Finish
              </button>
              <div className="page-actions-end">
                {createError && (
                  <p className="page-actions-note is-error" role="alert">
                    {createError}
                  </p>
                )}
                <Link to="/" id="export-dashboard" className="btn btn-ghost">
                  Dashboard
                </Link>
                <button type="button" id="export-new-project" className="btn btn-secondary" onClick={handleNewProject} disabled={creating}>
                  {creating ? <LoadingSpinner size="sm" label="Creating…" /> : '+ New project'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}

export default function ExportPage() {
  const { id } = useParams();
  // A fresh instance per project, so the selected version and request state never leak between projects.
  return <ExportVideo key={id} projectId={id} />;
}
