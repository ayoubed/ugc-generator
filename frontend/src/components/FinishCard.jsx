import React, { useId, useState } from 'react';
import { updateProjectSettings } from '../hooks/useProject';
import { friendlyError } from '../utils/errors';
import { CAPTION_OPTIONS, projectCaptionStyle, projectTightCuts } from '../utils/projectProgress';

/**
 * Finishing touches added when stitching: burned-in captions (from each scene's script) and
 * tightened cuts. Changing them marks the current final video as out of date, so the user
 * stitches again to see them.
 */
export default function FinishCard({ project, disabled = false, children }) {
  const baseId = useId();
  const [error, setError] = useState('');
  const style = projectCaptionStyle(project);
  const tight = projectTightCuts(project);

  const save = async (partial) => {
    setError('');
    try {
      await updateProjectSettings(project.id, partial);
    } catch (err) {
      console.error('Could not save the finishing choices:', err);
      setError(friendlyError(err));
    }
  };

  return (
    <section className="card card-white music-card" aria-labelledby={`${baseId}-title`}>
      <div className="music-head">
        <span className="music-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <line x1="7" y1="14" x2="11" y2="14" />
            <line x1="13" y1="14" x2="17" y2="14" />
          </svg>
        </span>
        <div>
          <h2 className="music-title" id={`${baseId}-title`}>Captions and cuts</h2>
          <p className="music-sub">
            Captions sit above the area the apps cover with buttons. They are added when the video is stitched.
          </p>
        </div>
      </div>

      <fieldset className="start-picker" aria-labelledby={`${baseId}-title`} disabled={disabled}>
        {CAPTION_OPTIONS.map((option) => (
          <label key={option.value} className="start-option" htmlFor={`${baseId}-${option.value}`}>
            <input
              type="radio"
              id={`${baseId}-${option.value}`}
              name={`${baseId}-captions`}
              value={option.value}
              checked={style === option.value}
              onChange={() => save({ 'captions.style': option.value })}
            />
            <span className="start-option-title">{option.title}</span>
            <span className="start-option-sub">{option.sub}</span>
          </label>
        ))}
      </fieldset>

      <label className="gen-run-option" htmlFor={`${baseId}-tight`} style={{ marginTop: '12px' }}>
        <input
          type="checkbox"
          id={`${baseId}-tight`}
          checked={tight}
          disabled={disabled}
          onChange={(e) => save({ tightCuts: e.target.checked })}
        />
        Tighten cuts: remove the pause before the first word and after the last word of each scene
      </label>

      <p className="field-hint">
        Caption timing is estimated from where speech is heard, so a word can be slightly early or late.
      </p>
      {error && <p className="gen-note is-error" role="alert">{error}</p>}
      {children}
    </section>
  );
}
