import React, { useId, useState } from 'react';
import VideoPreview from './VideoPreview';
import StatusBadge from './StatusBadge';
import ReferenceImageUploader from './ReferenceImageUploader';
import { getPromptSyncState } from '../utils/scenePrompt';
import {
  activeTakeNumber,
  isSceneBusy,
  isSceneSkipped,
  sceneHasVideo,
  sceneStatus,
  sceneTakes,
} from '../utils/projectProgress';

function promptHint(syncState) {
  if (syncState.kind === 'synced') {
    return 'Follows the script, description and context automatically. You can fine-tune it, and your own wording is kept.';
  }
  if (syncState.kind === 'custom') {
    return 'You wrote your own prompt, so changes to the script, description and context no longer update it.';
  }
  const parts = [
    ['“What They Say”', 'script', syncState.saySynced],
    ['“What happens”', 'description', syncState.happensSynced],
    ['“Context”', 'context', syncState.contextSynced],
  ];
  const edited = parts.filter(([, , synced]) => !synced);
  const followed = parts.filter(([, , synced]) => synced);
  return `${joinList(edited.map(([label]) => label))} ${edited.length > 1 ? 'have' : 'has'} your own wording, so ${joinList(
    edited.map(([, field]) => field)
  )} changes no longer update it. ${joinList(followed.map(([, field]) => field)).replace(/^./, (c) => c.toUpperCase())} changes still do.`;
}

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Editable scene card for the Script step (Step 2).
 *
 * @param {object}   scene              Scene doc (with any unsaved local text edits)
 * @param {number}   sceneNumber        1-based position
 * @param {string}   aspectRatio        '9:16' | '16:9'
 * @param {string}   storagePrefix      users/{uid}/projects/{pid}/scenes/{sceneId}
 * @param {number}   globalPictureCount Video-wide context pictures (they count towards each scene's limit)
 * @param {string[]} changesSinceTake   What changed since the current take, e.g. ['prompt']
 * @param {string}   continuity         Note when the current take no longer matches the previous scene
 * @param {function} onTextChange       (field, value) => void
 * @param {function} onRebuildPrompt    () => void
 * @param {function} onSceneImagesChange (images) => Promise|void
 * @param {function} onDelete           () => Promise|void, or null when the scene can't be deleted
 * @param {function} onAddAlternative   () => Promise|void: adds another version of this scene for the same spot
 * @param {number}   alternativeCount   Other scenes sharing this spot (only one of them is in the video)
 * @param {boolean}  autoFocus          Focus the first field when the card appears (newly added scene)
 */
export default function SceneCard({
  scene = {},
  sceneNumber = 1,
  aspectRatio = '9:16',
  storagePrefix = '',
  globalPictureCount = 0,
  pictureLimit = 6,
  changesSinceTake = [],
  continuity = '',
  onTextChange,
  onRebuildPrompt,
  onSceneImagesChange,
  onDelete,
  onAddAlternative,
  alternativeCount = 0,
  autoFocus = false,
}) {
  const baseId = useId();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const { description = '', script = '', context = '', prompt = '' } = scene;
  const syncState = getPromptSyncState(scene);
  const busy = isSceneBusy(scene);
  const status = sceneStatus(scene);
  const hasVideo = sceneHasVideo(scene);
  const takeNumber = activeTakeNumber(scene);
  const takeCount = sceneTakes(scene).length;
  const isPortrait = aspectRatio !== '16:9';
  const skipped = isSceneSkipped(scene);

  const sceneSlots = Math.max(0, pictureLimit - globalPictureCount);
  const scenePictures = scene.sceneImages || [];

  let badge;
  if (busy) badge = <StatusBadge status={status} />;
  else if (hasVideo) badge = <StatusBadge status="completed" label={takeNumber ? `Take ${takeNumber}` : 'Has video'} />;
  else if (status === 'failed') badge = <StatusBadge status="failed" />;
  else badge = <StatusBadge status="pending" label="No video yet" />;

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await onDelete?.();
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <article
      className={`card card-white scene-card ${busy ? 'is-busy' : ''} ${skipped ? 'is-skipped' : ''}`}
      aria-labelledby={`${baseId}-title`}
    >
      <header className="scene-card-head">
        <div className="scene-card-heading">
          <span className="scene-number" aria-hidden="true">{sceneNumber}</span>
          <h2 className="scene-card-title" id={`${baseId}-title`}>Scene {sceneNumber}</h2>
          {badge}
          {skipped && (
            <span
              title={alternativeCount > 0
                ? 'Another alternative of this spot is in the video. Choose this one on the Generate step to use it instead.'
                : 'Left out of the final video. Switch it back on in the Generate step.'}
            >
              <StatusBadge status="pending" label={alternativeCount > 0 ? 'Alternative, not in use' : 'Skipped'} />
            </span>
          )}
          {!skipped && alternativeCount > 0 && <StatusBadge status="completed" label="In the video" />}
        </div>

        {onAddAlternative && !confirmingDelete && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onAddAlternative}
            title="Add another version of this scene (for example a different hook). Only one version goes into the final video."
          >
            + Alternative
          </button>
        )}

        {onDelete && (
          confirmingDelete ? (
            <div className="inline-confirm" role="group" aria-label={`Delete scene ${sceneNumber}?`}>
              <span className="inline-confirm-text">Delete this scene{takeCount ? ' and its takes' : ''}?</span>
              <button type="button" className="btn btn-danger btn-sm" onClick={handleDelete} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmingDelete(false)} disabled={deleting}>
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-ghost btn-sm scene-delete"
              onClick={() => setConfirmingDelete(true)}
              disabled={busy}
              title={busy ? 'Wait for the video to finish generating' : `Delete scene ${sceneNumber}`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
              <span>Delete</span>
            </button>
          )
        )}
      </header>

      <div className={`scene-card-body ${hasVideo ? 'has-take' : ''}`}>
        <div className="scene-fields">
          <div className="form-group">
            <label className="label" htmlFor={`${baseId}-description`}>What happens (visual description)</label>
            <textarea
              id={`${baseId}-description`}
              className="textarea"
              rows={2}
              autoFocus={autoFocus}
              value={description}
              onChange={(e) => onTextChange?.('description', e.target.value)}
              placeholder="e.g. The creator looks into the camera, excited, holding the notebook…"
            />
          </div>

          <div className="form-group">
            <label className="label" htmlFor={`${baseId}-script`}>What they say (script)</label>
            <textarea
              id={`${baseId}-script`}
              className="textarea"
              rows={2}
              value={script}
              onChange={(e) => onTextChange?.('script', e.target.value)}
              placeholder="e.g. You won't believe how easy it was to make $500 this week…"
            />
          </div>

          <div className="form-group">
            <label className="label" htmlFor={`${baseId}-context`}>Context (setting, framing, location)</label>
            <textarea
              id={`${baseId}-context`}
              className="textarea"
              rows={2}
              value={context}
              onChange={(e) => onTextChange?.('context', e.target.value)}
              placeholder="e.g. Same bedroom desk as before, laptop open, late afternoon light from the window…"
              aria-describedby={`${baseId}-context-hint`}
            />
            <p className="field-hint" id={`${baseId}-context-hint`}>
              Just for this scene. The video context above and your guidelines from Step 1 are added to every scene.
            </p>
          </div>

          <div className="form-group">
            <label className="label" htmlFor={`${baseId}-prompt`}>Video prompt</label>
            <textarea
              id={`${baseId}-prompt`}
              className="textarea prompt-textarea"
              rows={4}
              value={prompt}
              onChange={(e) => onTextChange?.('prompt', e.target.value)}
              placeholder={'What They Say: …\nWhat happens: …\nContext: …'}
              aria-describedby={`${baseId}-prompt-hint`}
            />
            <div className={`prompt-hint is-${syncState.kind}`} id={`${baseId}-prompt-hint`}>
              <span className="prompt-hint-dot" aria-hidden="true" />
              <span className="prompt-hint-text">{promptHint(syncState)}</span>
              {syncState.kind !== 'synced' && onRebuildPrompt && (
                <button type="button" className="prompt-hint-action" onClick={onRebuildPrompt}>
                  Rebuild from script &amp; description
                </button>
              )}
            </div>
          </div>
        </div>

        {hasVideo && (
          <aside className="scene-take" aria-label={`Current video of scene ${sceneNumber}`}>
            <p className="scene-take-label">
              Current take{takeNumber ? ` · Take ${takeNumber}` : ''}
              {takeCount > 1 ? <span className="scene-take-count"> of {takeCount}</span> : null}
            </p>
            <div className="scene-take-player" style={{ maxWidth: isPortrait ? '220px' : '100%' }}>
              <VideoPreview
                key={scene.storageRef || scene.videoUrl}
                src={scene.storageRef || scene.videoUrl}
                aspectRatio={isPortrait ? '9/16' : '16/9'}
              />
            </div>
            {busy && <p className="scene-take-note is-info">A new take is being made. This one stays in use until it's ready.</p>}
            {changesSinceTake.length > 0 && (
              <p className="scene-take-note">
                The {joinList(changesSinceTake)} changed since this take. Make a new take on the Generate page to use{' '}
                {changesSinceTake.length > 1 ? 'them' : 'it'}.
              </p>
            )}
            {continuity && <p className="scene-take-note">{continuity}</p>}
          </aside>
        )}
      </div>

      <section className="scene-section" aria-labelledby={`${baseId}-pictures`}>
        <h3 className="scene-section-title" id={`${baseId}-pictures`}>Scene pictures</h3>
        <ReferenceImageUploader
          label="Pictures for this scene only"
          hint="Things that appear only in this scene, like a product close-up or a new place. Say what each one is. The picture the scene starts from is chosen on the Generate step, next to its takes."
          images={scenePictures}
          maxImages={Math.max(sceneSlots, scenePictures.length)}
          storagePrefix={storagePrefix ? `${storagePrefix}/context` : ''}
          onChange={onSceneImagesChange}
          budgetNote={
            globalPictureCount > 0
              ? `${globalPictureCount} video-wide picture${globalPictureCount === 1 ? '' : 's'} already count towards this scene's limit of ${pictureLimit}.`
              : ''
          }
          disabled={busy}
        />
      </section>
    </article>
  );
}
