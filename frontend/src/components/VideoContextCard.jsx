import React, { useId } from 'react';
import ReferenceImageUploader from './ReferenceImageUploader';
import AssetBibleFields from './AssetBibleFields';
import { ASSET_BIBLE_FIELDS, assetBibleFilledCount } from '../utils/assetBible';

/**
 * Top of the Script page: what applies to every scene. The video context (who, where, the look)
 * is written by the script writer and can be edited here; the video-wide pictures are shared with Step 1.
 *
 * @param {string}   value            Video context (with any unsaved edit applied)
 * @param {function} onChange         (text) => void, saved by the page
 * @param {object}   assetBible       Consistent details (with any unsaved edit applied)
 * @param {function} onAssetBibleChange (next) => void, saved by the page
 * @param {Array}    images           project.globalImages
 * @param {function} onImagesChange   (next) => Promise
 * @param {number}   pictureLimit     Pictures per scene for the chosen video model (video-wide + scene)
 * @param {number}   maxScenePictures Most scene-specific pictures any one scene has (they share the limit)
 * @param {number[]} staleScenes      Scene numbers whose take used an older video context
 */
export default function VideoContextCard({
  value,
  onChange,
  assetBible,
  onAssetBibleChange,
  images,
  onImagesChange,
  pictureLimit,
  maxScenePictures = 0,
  storagePrefix,
  staleScenes = [],
}) {
  const baseId = useId();
  const pictures = images || [];
  // Never let the video-wide pictures push a scene over the limit.
  const slots = Math.max(pictures.length, pictureLimit - maxScenePictures);
  const filledDetails = assetBibleFilledCount(assetBible);

  return (
    <section className="card card-white video-context-card" aria-labelledby={`${baseId}-title`}>
      <header className="video-context-head">
        <span className="video-context-icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="6" width="14" height="12" rx="2" />
            <path d="m16 10 6-3v10l-6-3" />
          </svg>
        </span>
        <div>
          <h2 className="video-context-title" id={`${baseId}-title`}>Whole video</h2>
          <p className="video-context-sub">Added to every scene's video prompt, so all scenes look like one video.</p>
        </div>
      </header>

      <div className="video-context-body">
        <div className="form-group video-context-text">
          <label className="label" htmlFor={`${baseId}-context`}>Video context</label>
          <textarea
            id={`${baseId}-context`}
            className="textarea"
            rows={5}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="e.g. A 24-year-old nursing student filming herself in her small dorm room in the evening. Messy desk with a laptop and a coffee mug, warm desk lamp. Relaxed, a bit tired, hoodie."
            aria-describedby={`${baseId}-context-hint`}
          />
          <p className="field-hint" id={`${baseId}-context-hint`}>
            Who the person is, where it's filmed and the overall look. Written with your script; edit it freely.
          </p>
          {staleScenes.length > 0 && (
            <p className="scene-take-note" role="status">
              {staleScenes.length === 1 ? `Scene ${staleScenes[0]} has a take` : `Scenes ${staleScenes.join(', ')} have takes`}{' '}
              made with a different video context or details. Make a new take on the Generate page to use these.
            </p>
          )}
        </div>

        <div className="video-context-pictures">
          <ReferenceImageUploader
            label="Video-wide pictures"
            hint="Products, places, outfits or other people that should appear in every scene. Say what each one is."
            images={pictures}
            maxImages={slots}
            storagePrefix={storagePrefix}
            onChange={onImagesChange}
            budgetNote={`Each scene can use ${pictureLimit} pictures in total, and these count towards every scene. A split that works well: up to 3 of the speaker from different angles, and up to 3 of the product (front, label close-up, in the hand). For a product, write the exact text on its label in the description.`}
          />
        </div>
      </div>

      <details className="asset-details">
        <summary className="asset-details-summary">
          <span className="asset-details-title">Consistent details</span>
          <span className="asset-details-count">
            {filledDetails ? `${filledDetails} of ${ASSET_BIBLE_FIELDS.length} filled in` : 'None yet'}
          </span>
        </summary>
        <p className="field-hint asset-details-hint">
          Exact descriptions of the products, speaker and setting, added to every scene word for word.
        </p>
        <AssetBibleFields value={assetBible} onChange={onAssetBibleChange} />
      </details>
    </section>
  );
}
