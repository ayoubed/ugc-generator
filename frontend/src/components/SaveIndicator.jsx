import React from 'react';

/**
 * Autosave status for pages that save edits as you type.
 * @param {'idle'|'saving'|'saved'|'error'} state
 * @param {function} onRetry Saves the pending edits again
 */
export default function SaveIndicator({ state, onRetry }) {
  let content = <span className="save-indicator">Changes save automatically</span>;
  if (state === 'saving') {
    content = (
      <span className="save-indicator is-saving">
        <span className="save-dot" aria-hidden="true" />
        Saving…
      </span>
    );
  } else if (state === 'saved') {
    content = (
      <span className="save-indicator is-saved">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        All changes saved
      </span>
    );
  } else if (state === 'error') {
    content = (
      <span className="save-indicator is-error">
        Couldn't save your latest changes.
        <button type="button" className="link-button" onClick={onRetry}>Try again</button>
      </span>
    );
  }
  return <div className="save-indicator-wrap" aria-live="polite">{content}</div>;
}
