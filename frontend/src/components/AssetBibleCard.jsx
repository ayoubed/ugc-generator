import React, { useId, useState } from 'react';
import AssetBibleFields from './AssetBibleFields';
import LoadingSpinner from './LoadingSpinner';
import { extractAssets } from '../services/api';
import { friendlyError } from '../utils/errors';
import { assetBibleFilledCount, normalizeAssetBible } from '../utils/assetBible';

/**
 * Idea page: the fixed details (products and props, speaker, setting) reused word for word in
 * every scene. "Fill in from my idea" drafts them with the script model; the user edits from there.
 * `embedded` drops the card frame and title, for use inside a section that already has them.
 */
export default function AssetBibleCard({ value, onChange, idea, projectId = null, productName = '', scriptModel, disabled = false, embedded = false }) {
  const baseId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const filled = assetBibleFilledCount(value);
  const hasIdea = Boolean(idea?.trim());

  const handleFill = async () => {
    // Filling in replaces what's there, so check before overwriting the user's own text.
    if (filled > 0 && !window.confirm('Replace the details below with new ones written from your idea and pictures?')) return;
    setBusy(true);
    setError('');
    try {
      onChange(normalizeAssetBible(await extractAssets(idea.trim(), scriptModel, projectId, productName)));
    } catch (err) {
      console.error('Could not fill in the details:', err);
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={embedded ? 'asset-card' : 'card card-white asset-card'} aria-labelledby={embedded ? undefined : `${baseId}-title`} aria-label={embedded ? 'Consistent details' : undefined}>
      <div className="asset-head">
        <div>
          {!embedded && (
            <h3 className="asset-title" id={`${baseId}-title`}>
              Consistent details
              <span className="asset-optional">(recommended)</span>
            </h3>
          )}
          <p className="asset-sub">
            Each scene is generated on its own, so anything shown in more than one scene needs one exact
            description. These are added to every scene, word for word.
            {embedded ? ' Left empty, they are written from your idea and pictures when the script is written.' : ''}
          </p>
        </div>
        <button
          type="button"
          id="asset-bible-fill"
          className="btn btn-secondary btn-sm asset-fill"
          onClick={handleFill}
          disabled={disabled || busy || !hasIdea}
          title={hasIdea ? undefined : 'Write your video idea first'}
        >
          {busy ? <LoadingSpinner size="sm" label="Writing…" /> : filled > 0 ? 'Rewrite from my idea' : 'Fill in from my idea'}
        </button>
      </div>

      <AssetBibleFields value={value} onChange={onChange} disabled={disabled || busy} />

      <div aria-live="polite">
        {error && <p className="export-note is-error" role="alert">{error}</p>}
      </div>
      <p className="field-hint">
        Be specific about anything that could change between scenes: colours, how many items, outfits.
      </p>
    </section>
  );
}
