import React, { useState } from 'react';
import VideoPreview from './VideoPreview';
import LoadingSpinner from './LoadingSpinner';
import {
  currentFinalVideo,
  finalVideoChangeReason,
  finalVideoVersions,
  formatDateTime,
  isStitching,
} from '../utils/projectProgress';

/**
 * Keeps the final video within reach while the user goes back to edit scenes or regenerate takes.
 * Renders nothing until the project has been stitched (or a stitch is running / failed).
 *
 * @param {object}   project
 * @param {Array}    scenes       Current scenes (used to tell whether the final video is out of date)
 * @param {function} onOpenExport Opens the Export page
 * @param {string}   outdatedHint What to do when the final video no longer matches the scenes
 * @param {node}     children     Extra page-specific actions
 */
export default function FinalVideoBanner({
  project,
  scenes,
  onOpenExport,
  outdatedHint = 'Generate the scenes you changed, then stitch again to update it.',
  children,
}) {
  const [showPlayer, setShowPlayer] = useState(false);

  const current = currentFinalVideo(project);
  const stitching = isStitching(project);
  const stitchError = project?.stitchError || '';
  if (!current && !stitching && !stitchError) return null;

  const versionCount = finalVideoVersions(project).length;
  const reason = current ? finalVideoChangeReason(current, scenes, project) : '';
  const title = current
    ? `Final video${current.version ? ` v${current.version}` : ''}`
    : stitching ? 'Final video' : 'Final video not created';
  const created = current ? formatDateTime(current.createdAt) : '';
  const isPortrait = project?.settings?.aspectRatio !== '16:9';

  let stateClass = '';
  if (stitching) stateClass = 'is-stitching';
  else if (stitchError) stateClass = 'is-error';
  else if (reason) stateClass = 'is-outdated';

  return (
    <section className={`final-banner ${stateClass}`} aria-label="Final video">
      <div className="final-banner-row">
        <div className="final-banner-icon" aria-hidden="true">
          {stitching ? (
            <LoadingSpinner size="sm" />
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="3" />
              <polygon points="10 9 15 12 10 15 10 9" fill="currentColor" stroke="none" />
            </svg>
          )}
        </div>

        <div className="final-banner-body" aria-live="polite">
          <p className="final-banner-title">
            {title}
            {current && !stitching && !stitchError && (
              <span className={`final-banner-chip ${reason ? 'chip-warning' : 'chip-success'}`}>
                {reason ? 'Out of date' : 'Up to date'}
              </span>
            )}
          </p>
          <p className="final-banner-meta">
            {stitching && 'Stitching a new version. This usually takes under a minute.'}
            {!stitching && stitchError && (
              <>
                The last stitch failed: {stitchError}{' '}
                {current ? 'Your previous final video is still available.' : 'Try stitching again.'}
              </>
            )}
            {!stitching && !stitchError && reason && `${reason} ${outdatedHint}`}
            {!stitching && !stitchError && !reason && (
              <>
                {created ? `Stitched ${created}` : 'Your stitched video'}
                {versionCount > 1 ? ` · ${versionCount} versions` : ''}
              </>
            )}
          </p>
        </div>

        <div className="final-banner-actions">
          {current && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setShowPlayer((open) => !open)}
              aria-expanded={showPlayer}
            >
              {showPlayer ? 'Hide' : 'Watch here'}
            </button>
          )}
          {children}
          {(current || stitching) && onOpenExport && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onOpenExport}>
              Open Export
            </button>
          )}
        </div>
      </div>

      {showPlayer && current && (
        <div className="final-banner-player" style={{ width: isPortrait ? '240px' : '100%', maxWidth: '100%' }}>
          <VideoPreview
            key={current.storageRef || current.videoUrl}
            src={current.storageRef || current.videoUrl}
            aspectRatio={isPortrait ? '9/16' : '16/9'}
          />
        </div>
      )}
    </section>
  );
}
