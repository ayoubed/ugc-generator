import React, { useId } from 'react';
import { ASSET_BIBLE_FIELDS, normalizeAssetBible } from '../utils/assetBible';

/**
 * The four Asset Bible text fields. Used on the Idea page and in the "Whole video" card on the
 * Scenes page, so both edit the same thing the same way.
 *
 * @param {object}   value     { character, hero_props, setting, visual_style }
 * @param {function} onChange  (next) => void, with the whole updated object
 * @param {boolean}  disabled
 */
export default function AssetBibleFields({ value, onChange, disabled = false }) {
  const baseId = useId();
  const ab = normalizeAssetBible(value);

  return (
    <div className="asset-fields">
      {ASSET_BIBLE_FIELDS.map(({ key, label, placeholder, wide }) => (
        <div className={`form-group asset-field${wide ? ' is-wide' : ''}`} key={key}>
          <label className="label" htmlFor={`${baseId}-${key}`}>{label}</label>
          <textarea
            id={`${baseId}-${key}`}
            className="textarea"
            rows={3}
            value={ab[key]}
            onChange={(e) => onChange({ ...ab, [key]: e.target.value })}
            placeholder={placeholder}
            disabled={disabled}
          />
        </div>
      ))}
    </div>
  );
}
