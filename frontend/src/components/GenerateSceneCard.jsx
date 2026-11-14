import React, { useId, useState } from 'react';
import StatusBadge from './StatusBadge';
import VideoPreview from './VideoPreview';
import LoadingSpinner from './LoadingSpinner';
import StartPicturePicker from './StartPicturePicker';
import EndPicturePicker from './EndPicturePicker';
import { useStorageUrl } from '../hooks/useStorageUrl';
import { startBlocker } from '../utils/startBlocker';
import { startsOnStoryboard, unusedFrame } from '../utils/storyboard';
import { editStoryboardFrame } from '../services/api';
import { takeContextPictureCount, usedCreatorPhoto } from '../utils/takePictures';
import {
  isProductLed,
  FROM_PREVIOUS_SOURCES,
  activeTakeNumber,
  canRefineTake,
  continuityNote,
  effectiveImageSource,
  formatDateTime,
  formatElapsed,
  isSceneBusy,
  isSceneSkipped,
  sceneChangesSinceTake,
  sceneHasVideo,
  sceneStatus,
  sceneTakes,
  takeCheck,
  toMillis,
  isBusyAndFresh,
} from '../utils/projectProgress';
import { SCENE_AUDIO_VOICE_ONLY, projectSceneAudio } from '../data/guidelineTags';

/** Same limit as the API (jobs.MAX_SAVED_TAKES): older takes are removed when a new one is saved. */
const MAX_SAVED_TAKES = 3;


function joinList(items) {
  if (items.length <= 1) return items[0] || '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function describeStart(take, prevLabel) {
  const fromTake = take.sourceSceneAttempt ? ` (take ${take.sourceSceneAttempt})` : '';
  switch (take.imageSource) {
    case 'creator':
      return 'the creator photo';
    case 'uploaded':
      return 'a custom picture';
    case 'last_frame':
      return `the last frame of ${prevLabel}${fromTake}`;
    case 'ai_cut':
      return `a camera cut from ${prevLabel}${fromTake}`;
    case 'extend':
      return take.extended
        ? `${prevLabel}'s video${fromTake}, continued in the same shot`
        : `the last frame of ${prevLabel}${fromTake}`;
    default:
      return '';
  }
}

function ContextThumb({ image }) {
  const url = useStorageUrl(image.url || image.storageRef || '');
  if (!url) return <span className="ref-strip-placeholder" aria-hidden="true" />;
  return <img src={url} alt={image.description || 'Context picture'} title={image.description || ''} loading="lazy" />;
}

/** "In video" switch: on = the scene is part of the final video. */
function IncludeSwitch({ checked, disabled, title, onChange, sceneNumber }) {
  return (
    <label className={`include-switch ${disabled ? 'is-disabled' : ''}`} title={title}>
      <span className="include-switch-text">In video</span>
      <button
        type="button"
        role="switch"
        id={`gen-include-${sceneNumber}`}
        className="switch"
        aria-checked={checked}
        aria-label={`Include scene ${sceneNumber} in the final video`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-thumb" aria-hidden="true" />
      </button>
    </label>
  );
}

/**
 * One scene on the Generate page: what the next take will use (left) and the takes made so far (right).
 * Making or choosing a take here never changes other scenes.
 *
 * @param {object}   scene          Scene doc, with any unsaved prompt edit already applied
 * @param {number}   now            Current time in ms (ticks while something is running)
 * @param {boolean}  requesting     The request to start a take is in flight
 * @param {string}   error          Last request error for this scene
 * @param {function} onGenerate     (editPrompt | null) => Promise<boolean>
 * @param {function} onSelectTake   (attempt) => Promise<boolean>
 * @param {function} onCancel       () => Promise<boolean>; stops the take being made
 * @param {function} onEditScript   Opens the Script step
 * @param {number}   prevNumber     Number of the scene that plays before this one (skipped scenes don't count)
 * @param {number}   nextNumber     Number of the scene that plays after this one
 * @param {boolean}  canSkip        False for the last scene still in the video
 * @param {function} onToggleSkip   (skipped) => Promise
 */
export default function GenerateSceneCard({
  scene,
  sceneNumber,
  isFirst,
  prevScene,
  prevNumber = null,
  nextScene,
  nextNumber = null,
  project,
  pictureLimit = 6,
  now,
  creatorImageUrl,
  storagePrefix,
  requesting = false,
  error = '',
  canSkip = true,
  onToggleSkip,
  onPromptChange,
  onPromptBlur,
  onImageSourceChange,
  onCustomImageChange,
  onEndImageChange,
  onGenerate,
  onSelectTake,
  onCancel,
  onEditScript,
  alternativeCount = 0,
  onUseSpokenText,
}) {
  const baseId = useId();
  const [viewed, setViewed] = useState(null); // null = follow the take in use
  const [pickerBusy, setPickerBusy] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const [refineOpen, setRefineOpen] = useState(false);
  const [refineText, setRefineText] = useState('');
  const [switchingTo, setSwitchingTo] = useState(null);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [usingFrame, setUsingFrame] = useState(false);
  const boardFrame = unusedFrame(scene);   // drawn on the Storyboard step, but not accepted

  const useBoardFrame = async () => {
    setSourceError('');
    setUsingFrame(true);
    try {
      await editStoryboardFrame(project.id, scene.id, boardFrame.id, { accepted: true });
    } catch (err) {
      setSourceError(err?.message || 'Could not use the storyboard picture. Try again.');
    } finally {
      setUsingFrame(false);
    }
  };

  const status = sceneStatus(scene);
  const busy = isSceneBusy(scene);
  const fresh = isBusyAndFresh(scene, now);
  const stale = busy && !fresh;
  const hasVideo = sceneHasVideo(scene);
  const takes = sceneTakes(scene);
  const activeNumber = activeTakeNumber(scene);
  const activeRecord = takes.find((t) => t.attempt === activeNumber) || null;
  const viewedNumber = viewed != null && takes.some((t) => t.attempt === viewed) ? viewed : activeNumber;
  const viewedTake = takes.find((t) => t.attempt === viewedNumber) || null;
  const viewedCheck = viewedTake ? takeCheck(scene, viewedTake.attempt) : null;
  const videoSrc = viewedTake ? viewedTake.storageRef || viewedTake.videoUrl : scene.storageRef || scene.videoUrl;
  // scene.attempt counts every take started, including failed and cancelled ones, so the next one is +1.
  const lastTake = Math.max(scene.attempt || 0, takes.length ? takes[takes.length - 1].attempt : 0);
  const pendingTake = busy ? scene.attempt || lastTake : lastTake + 1;
  const elapsed = busy ? (now - (toMillis(scene.updatedAt) || now)) / 1000 : 0;

  const isPortrait = project?.settings?.aspectRatio !== '16:9';
  const ratio = isPortrait ? '9/16' : '16/9';
  const frameStyle = { aspectRatio: ratio, maxWidth: isPortrait ? '260px' : '100%' };

  const source = effectiveImageSource(scene, isFirst);
  const prevLabel = prevNumber ? `Scene ${prevNumber}` : 'the previous scene';
  const nextLabel = nextNumber ? `Scene ${nextNumber}` : 'the next scene';
  const blocker = startBlocker({ scene, source, prevScene, prevLabel, project, now, pickerBusy, pictureLimit });
  const canStart = !fresh && !requesting && !blocker;
  const canRefine = hasVideo && !busy && canRefineTake(activeRecord);

  const pictures = [...(project?.globalImages || []), ...(scene.sceneImages || [])].filter((img) => img && img.storageRef);

  const changes = sceneChangesSinceTake(scene, isFirst, project);
  const continuity = continuityNote(scene, prevScene, prevLabel);
  const nextContinues =
    nextScene && sceneHasVideo(nextScene) && FROM_PREVIOUS_SOURCES.includes(effectiveImageSource(nextScene, false));
  const promptChangedSinceViewed =
    viewedTake && typeof viewedTake.scenePrompt === 'string'
    && viewedTake.scenePrompt.replace(/\s+/g, ' ').trim() !== (scene.prompt || '').replace(/\s+/g, ' ').trim();

  let startLabel = 'Generate video';
  if (hasVideo) startLabel = 'Make a new take';
  else if (status === 'failed' || stale) startLabel = 'Try again';

  let badge;
  if (fresh) {
    badge = (
      <StatusBadge status={status} label={`${status === 'queued' ? 'Queued' : 'Generating'} · ${formatElapsed(elapsed)}`} />
    );
  } else if (stale) {
    badge = <StatusBadge status="failed" label="Not responding" />;
  } else if (hasVideo) {
    badge = <StatusBadge status="completed" label={activeNumber ? `Ready · take ${activeNumber}` : 'Ready'} />;
  } else if (status === 'failed') {
    badge = <StatusBadge status="failed" />;
  } else {
    badge = <StatusBadge status="pending" label="No video yet" />;
  }

  const handleStart = async () => {
    setViewed(null);
    setRefineOpen(false);
    await onGenerate?.(null);
  };

  const handleRefine = async (event) => {
    event.preventDefault();
    const text = refineText.trim();
    if (!text) return;
    setViewed(null);
    const ok = await onGenerate?.(text);
    if (ok) {
      setRefineOpen(false);
      setRefineText('');
    }
  };

  const handleUseTake = async (attempt) => {
    setSwitchingTo(attempt);
    const ok = await onSelectTake?.(attempt);
    setSwitchingTo(null);
    if (ok) setViewed(null);
  };

  const handleCancel = async () => {
    setCancelling(true);
    await onCancel?.();
    setCancelling(false);
  };

  const cancelButton = (variant) => (
    <button
      type="button"
      className={`btn btn-sm ${variant}`}
      onClick={handleCancel}
      disabled={cancelling}
      aria-label={`Cancel take ${pendingTake} of scene ${sceneNumber}`}
    >
      {cancelling ? 'Cancelling…' : stale ? 'Clear' : 'Cancel take'}
    </button>
  );

  const handleSourceChange = async (next) => {
    setSourceError('');
    try {
      await onImageSourceChange?.(next);
    } catch (err) {
      console.error('Could not save the starting picture choice:', err);
      setSourceError('Could not save your choice. Try again.');
    }
  };

  const busyText = status === 'queued' ? `Take ${pendingTake} is waiting to start` : `Making take ${pendingTake}`;

  const skipped = isSceneSkipped(scene);
  const handleToggle = async (include) => {
    setToggleError('');
    setToggling(true);
    try {
      await onToggleSkip?.(!include);
    } catch (err) {
      console.error('Could not change whether the scene is in the video:', err);
      setToggleError('Could not save that. Check your connection and try again.');
    } finally {
      setToggling(false);
    }
  };
  // An alternative shares its spot in the video with other scenes; only one of them is in the video.
  const inGroup = alternativeCount > 0;
  let switchTitle = skipped ? 'Put this scene back in the final video' : 'Leave this scene out of the final video';
  if (inGroup && skipped) switchTitle = 'Use this alternative in the final video instead of the current one';
  if (fresh) switchTitle = 'Wait for the take to finish';
  else if (!skipped && !canSkip) switchTitle = 'At least one scene has to stay in the video';
  const switchControl = (
    <IncludeSwitch
      checked={!skipped}
      disabled={toggling || fresh || (!skipped && !canSkip)}
      title={switchTitle}
      onChange={handleToggle}
      sceneNumber={sceneNumber}
    />
  );

  if (skipped) {
    const summary = scene.script ? `“${scene.script}”` : scene.description || 'No script yet.';
    return (
      <article
        id={`scene-${scene.id}`}
        tabIndex={-1}
        className="card card-white gen-card is-skipped"
        aria-labelledby={`${baseId}-title`}
      >
        <header className="gen-card-head">
          <div className="scene-card-heading">
            <span className="scene-number" aria-hidden="true">{sceneNumber}</span>
            <h2 className="scene-card-title" id={`${baseId}-title`}>Scene {sceneNumber}</h2>
            <StatusBadge status="pending" label={inGroup ? 'Alternative, not in use' : 'Skipped'} />
          </div>
          {switchControl}
        </header>
        <p className="gen-skipped-summary">{summary}</p>
        <p className="field-hint">
          {inGroup
            ? 'Another alternative of this spot is in the video. Switch this one on to use it instead, then make its take.'
            : 'Left out of the final video.'}
          {takes.length > 0 ? ` Its ${takes.length} take${takes.length === 1 ? ' is' : 's are'} kept.` : ''}
          {inGroup ? '' : ' Switch it back on to use it again.'}
        </p>
        {toggleError && <p className="gen-note is-error" role="alert">{toggleError}</p>}
      </article>
    );
  }

  return (
    <article
      id={`scene-${scene.id}`}
      tabIndex={-1}
      className={`card card-white gen-card ${fresh ? 'is-busy' : ''}`}
      aria-labelledby={`${baseId}-title`}
    >
      <header className="gen-card-head">
        <div className="scene-card-heading">
          <span className={`scene-number ${hasVideo && !busy ? 'is-done' : ''}`} aria-hidden="true">
            {sceneNumber}
          </span>
          <h2 className="scene-card-title" id={`${baseId}-title`}>Scene {sceneNumber}</h2>
          {badge}
        </div>
        <div className="gen-card-head-end">
          {takes.length > 0 && (
            <span className="gen-card-takes">
              {takes.length} take{takes.length === 1 ? '' : 's'}
            </span>
          )}
          {switchControl}
        </div>
      </header>
      {toggleError && <p className="gen-note is-error" role="alert">{toggleError}</p>}

      <div className="gen-card-body">
        {/* What the next take uses */}
        <div className="gen-controls">
          <div className="gen-script">
            {scene.description && (
              <p className="gen-script-line">
                <span className="gen-script-label">Shows</span>
                <span>{scene.description}</span>
              </p>
            )}
            {scene.script && (
              <p className="gen-script-line">
                <span className="gen-script-label">Says</span>
                <span>“{scene.script}”</span>
              </p>
            )}
            {scene.context && (
              <p className="gen-script-line">
                <span className="gen-script-label">Where</span>
                <span>{scene.context}</span>
              </p>
            )}
            {!scene.description && !scene.script && (
              <p className="gen-script-line">
                This scene has no script yet.{' '}
                <button type="button" className="link-button" onClick={onEditScript}>Write it on the Script step</button>
              </p>
            )}
          </div>

          <div className="form-group">
            <label className="label" htmlFor={`${baseId}-prompt`}>Video prompt</label>
            <textarea
              id={`${baseId}-prompt`}
              className="textarea prompt-textarea"
              rows={4}
              value={scene.prompt || ''}
              onChange={(e) => onPromptChange?.(e.target.value)}
              onBlur={onPromptBlur}
              placeholder={'What They Say: …\nWhat happens: …'}
              aria-describedby={`${baseId}-prompt-hint`}
            />
            <p className="field-hint" id={`${baseId}-prompt-hint`}>
              {hasVideo ? 'Used for the next take. Takes you already made keep the prompt they were made with.' : 'Saved automatically.'}
              {projectSceneAudio(project?.settings) === SCENE_AUDIO_VOICE_ONLY
                ? ' Scenes are voice only; music is added over the whole video when you stitch.'
                : ''}
            </p>
          </div>

          <section className="gen-block" aria-labelledby={`${baseId}-start`}>
            <h3 className="gen-block-title" id={`${baseId}-start`}>{hasVideo ? 'Next take starts from' : 'Starts from'}</h3>
            <StartPicturePicker
              isFirst={isFirst}
              previousLabel={prevLabel}
              previousHasVideo={sceneHasVideo(prevScene)}
              value={source}
              onChange={handleSourceChange}
              creatorImageUrl={creatorImageUrl}
              productLed={isProductLed(project)}
              customImageUrl={scene.customStartImageUrl || ''}
              storagePrefix={storagePrefix}
              onCustomImageChange={onCustomImageChange}
              onBusyChange={setPickerBusy}
              disabled={fresh}
            />
            {startsOnStoryboard(scene) && source === 'uploaded' && (
              <p className="gen-note">The custom picture is this scene&apos;s storyboard picture.</p>
            )}
            {boardFrame && (
              <p className="gen-note is-warning">
                This scene has a storyboard picture that is not used yet.{' '}
                <button type="button" className="link-button" onClick={useBoardFrame} disabled={usingFrame || fresh}>
                  {usingFrame ? 'Saving…' : 'Start on the storyboard picture'}
                </button>
              </p>
            )}
            {sourceError && <p className="gen-note is-error" role="alert">{sourceError}</p>}
          </section>

          {source !== 'extend' && (
            <section className="gen-block" aria-labelledby={`${baseId}-end`}>
              <h3 className="gen-block-title" id={`${baseId}-end`}>Ends on (optional)</h3>
              <EndPicturePicker
                imageUrl={scene.endImageUrl || ''}
                storagePrefix={storagePrefix}
                onChange={onEndImageChange}
                onBusyChange={setPickerBusy}
                disabled={fresh}
              />
            </section>
          )}

          {pictures.length > 0 && (
            <section className="gen-block" aria-labelledby={`${baseId}-pictures`}>
              <h3 className="gen-block-title" id={`${baseId}-pictures`}>Context pictures</h3>
              <div className="ref-strip">
                {pictures.map((image, i) => (
                  <ContextThumb key={image.id || image.storageRef || i} image={image} />
                ))}
              </div>
              <p className="field-hint">
                {`${pictures.length} of ${pictureLimit} pictures go with this scene. `}
                <button type="button" className="link-button" onClick={onEditScript}>Change pictures</button>
              </p>
            </section>
          )}

          <div className="gen-actions">
            <button type="button" className="btn btn-primary" onClick={handleStart} disabled={!canStart}>
              {requesting ? (
                <LoadingSpinner size="sm" label="Starting…" />
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <polygon points="6 4 20 12 6 20 6 4" />
                  </svg>
                  {startLabel}
                </>
              )}
            </button>
            {canRefine && !refineOpen && (
              <button type="button" className="btn btn-secondary" onClick={() => setRefineOpen(true)} disabled={requesting}>
                Refine take {activeNumber}
              </button>
            )}
          </div>

          {refineOpen && canRefine && (
            <form className="refine-box" onSubmit={handleRefine}>
              <label className="label" htmlFor={`${baseId}-refine`}>What should change in take {activeNumber}?</label>
              <textarea
                id={`${baseId}-refine`}
                className="textarea"
                rows={2}
                value={refineText}
                onChange={(e) => setRefineText(e.target.value)}
                placeholder="e.g. Make the lighting warmer and keep the phone in frame"
                autoFocus
              />
              <p className="field-hint">
                Makes take {pendingTake} from take {activeNumber} with your change. Take {activeNumber} stays available.
              </p>
              <div className="refine-actions">
                <button type="submit" className="btn btn-primary btn-sm" disabled={!refineText.trim() || requesting}>
                  {requesting ? 'Starting…' : 'Make refined take'}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRefineOpen(false)} disabled={requesting}>
                  Cancel
                </button>
              </div>
            </form>
          )}

          {blocker && !fresh && <p className="gen-note is-warning">{blocker}</p>}
          {stale && (
            <p className="gen-note is-warning">
              Take {pendingTake} has shown no progress for more than 15 minutes, so it has most likely stopped. Clear it or start it again.
            </p>
          )}
          {hasVideo && nextContinues && (
            <p className="gen-note">
              {nextLabel} continues from this scene. A new take here won't change {nextLabel}; make a new take of it
              afterwards if you want it to continue from the new one.
            </p>
          )}
          {error && <p className="gen-note is-error" role="alert">{error}</p>}
        </div>

        {/* Takes made so far */}
        <div className="gen-preview" aria-live="polite">
          {busy && !hasVideo ? (
            <div className={`gen-stage ${stale ? 'is-error' : 'is-dark'}`} style={frameStyle}>
              {stale ? (
                <>
                  <p className="gen-stage-title">Take {pendingTake} stopped responding</p>
                  <p className="gen-stage-hint">Start it again from the button on the left, or clear it.</p>
                  {cancelButton('btn-secondary')}
                </>
              ) : (
                <>
                  <LoadingSpinner size="lg" />
                  <p className="gen-stage-title">{status === 'queued' ? 'Waiting to start…' : `Making take ${pendingTake}…`}</p>
                  <p className="gen-stage-time">{formatElapsed(elapsed)}</p>
                  <p className="gen-stage-hint">Usually 1–3 minutes. You can leave this page; it keeps going.</p>
                  {cancelButton('btn-on-dark')}
                </>
              )}
            </div>
          ) : hasVideo ? (
            <>
              {busy && (
                <div className={`gen-progress-strip ${stale ? 'is-stale' : ''}`} role="status">
                  {stale ? null : <LoadingSpinner size="sm" />}
                  <span className="gen-progress-text">
                    {stale ? `Take ${pendingTake} stopped responding` : `${busyText} · ${formatElapsed(elapsed)}`}
                  </span>
                  {cancelButton('btn-ghost')}
                </div>
              )}

              <div className="gen-player" style={{ maxWidth: isPortrait ? '260px' : '100%' }}>
                <VideoPreview key={videoSrc} src={videoSrc} aspectRatio={ratio} />
              </div>

              {takes.length > 0 && (
                <div className="take-panel">
                  {takes.length > 1 && (
                    <div className="take-list" role="group" aria-label={`Takes of scene ${sceneNumber}`}>
                      {takes.map((take) => {
                        const isViewed = take.attempt === viewedNumber;
                        const inUse = take.attempt === activeNumber;
                        return (
                          <button
                            key={take.attempt}
                            type="button"
                            className={`take-chip ${isViewed ? 'is-viewed' : ''} ${inUse ? 'is-in-use' : ''}`}
                            aria-pressed={isViewed}
                            onClick={() => setViewed(take.attempt)}
                          >
                            Take {take.attempt}
                            {inUse && <span className="take-chip-tag">in use</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {viewedTake && (
                    <div className="take-meta">
                      <div className="take-meta-row">
                        <span className="take-meta-title">Take {viewedTake.attempt}</span>
                        {viewedTake.timestamp && <span className="take-meta-time">{formatDateTime(viewedTake.timestamp)}</span>}
                        {viewedTake.attempt === activeNumber ? (
                          <span className="take-status">In use</span>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleUseTake(viewedTake.attempt)}
                            disabled={busy || switchingTo != null}
                          >
                            {switchingTo === viewedTake.attempt ? 'Switching…' : 'Use this take'}
                          </button>
                        )}
                      </div>
                      <ul className="take-facts">
                        {describeStart(viewedTake, prevLabel) && <li>Started from {describeStart(viewedTake, prevLabel)}</li>}
                        {viewedTake.endImageRef && <li>Ends on your end picture</li>}
                        {viewedTake.startNote && <li>{viewedTake.startNote}</li>}
                        {viewedTake.editPrompt && (
                          <li>
                            Refined{viewedTake.refinedFrom ? ` from take ${viewedTake.refinedFrom}` : ''}: “{viewedTake.editPrompt}”
                          </li>
                        )}
                        {takeContextPictureCount(viewedTake) > 0 && (
                          <li>
                            Used {takeContextPictureCount(viewedTake)} context picture{takeContextPictureCount(viewedTake) === 1 ? '' : 's'}
                          </li>
                        )}
                        {usedCreatorPhoto(viewedTake) && <li>Used the creator photo to keep the person the same</li>}
                        {promptChangedSinceViewed && <li>Made with an earlier version of the prompt</li>}
                        <li>
                          {viewedTake.sceneAudio === SCENE_AUDIO_VOICE_ONLY
                            ? 'Audio: voice only'
                            : 'Audio: chosen by the video model (may include its own music)'}
                        </li>
                      </ul>
                      {viewedCheck && (
                        viewedCheck.ok ? (
                          <p className="take-check is-ok">Checked automatically: no problems found.</p>
                        ) : (
                          <div className="take-check is-flagged" role="note">
                            <p className="take-check-title">The automatic check flagged this take</p>
                            <ul>
                              {(viewedCheck.issues || []).map((issue, i) => (
                                <li key={`${issue.kind}-${i}`}>{issue.detail}</li>
                              ))}
                            </ul>
                            {viewedCheck.spokenText && (viewedCheck.issues || []).some((issue) => issue.kind === 'script') && (
                              <p className="take-check-said">
                                It says: “{viewedCheck.spokenText}”
                                {onUseSpokenText && viewedTake.attempt === activeNumber && (
                                  <>
                                    {' '}
                                    <button type="button" className="link-button" onClick={() => onUseSpokenText(viewedCheck.spokenText)}>
                                      Use this as the caption
                                    </button>
                                  </>
                                )}
                              </p>
                            )}
                            <p className="field-hint">Watch it before deciding. The check can be wrong.</p>
                          </div>
                        )
                      )}
                      {busy && viewedTake.attempt !== activeNumber && (
                        <p className="field-hint">You can switch takes once take {pendingTake} is ready.</p>
                      )}
                    </div>
                  )}

                  {takes.length > 1 && (
                    <p className="field-hint">
                      The take in use is the one that gets stitched{nextScene ? ` and that ${nextLabel} can continue from` : ''}.
                    </p>
                  )}
                  {takes.length >= MAX_SAVED_TAKES && (
                    <p className="field-hint">
                      {MAX_SAVED_TAKES} takes are kept per scene. A new take removes the oldest one that is not in use.
                    </p>
                  )}
                </div>
              )}

              {scene.errorMessage && !busy && (
                <p className="gen-note is-error">
                  {scene.failedAttempt ? `Take ${scene.failedAttempt} failed: ` : 'The last take failed: '}
                  {scene.errorMessage}
                  {activeNumber ? ` Take ${activeNumber} is still in use.` : ''}
                </p>
              )}
              {changes.length > 0 && !busy && (
                <p className="gen-note is-warning">
                  The {joinList(changes)} changed since take {activeNumber}. Make a new take to use{' '}
                  {changes.length > 1 ? 'them' : 'it'}.
                </p>
              )}
              {continuity && <p className="gen-note is-warning">{continuity}</p>}
            </>
          ) : status === 'failed' ? (
            <div className="gen-stage is-error" style={frameStyle}>
              <p className="gen-stage-title">{scene.failedAttempt ? `Take ${scene.failedAttempt} failed` : 'Generation failed'}</p>
              <p className="gen-stage-hint">{scene.errorMessage || 'Something went wrong while making this video.'}</p>
            </div>
          ) : (
            <div className="gen-stage is-empty" style={frameStyle}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <polygon points="6 4 20 12 6 20 6 4" />
              </svg>
              <p className="gen-stage-hint">The video appears here once it's made.</p>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
