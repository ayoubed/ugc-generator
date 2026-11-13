import React, { useState, useRef, useEffect, useId } from 'react';

/**
 * TagInput component with pill styling, suggestions dropdown, and max tags limit.
 * @param {string} label - Input label
 * @param {string} hint - Optional help text under the label
 * @param {string[]} tags - Array of active string tags
 * @param {string[]|{group: string, tags: string[]}[]} suggestions - Flat list or groups of suggestions
 * @param {function} onChange - Callback (newTags) => void
 * @param {number} maxTags - Maximum tags allowed (default 10)
 */
export default function TagInput({
  label = '',
  hint = '',
  tags = [],
  suggestions = [],
  onChange,
  maxTags = 10,
}) {
  const baseId = useId();
  const [inputValue, setInputValue] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const containerRef = useRef(null);
  const inputRef = useRef(null);

  // Close suggestions when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsFocused(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const addTag = (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (tags.length >= maxTags) return;
    if (tags.includes(trimmed)) {
      setInputValue('');
      return;
    }
    const updated = [...tags, trimmed];
    onChange?.(updated);
    setInputValue('');
  };

  const removeTag = (indexToRemove) => {
    const updated = tags.filter((_, idx) => idx !== indexToRemove);
    onChange?.(updated);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(inputValue);
    } else if (e.key === 'Escape') {
      setIsFocused(false);
    } else if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
      e.preventDefault();
      removeTag(tags.length - 1);
    }
  };

  // Normalise to groups, then drop suggestions already added or not matching the typed text.
  const query = inputValue.trim().toLowerCase();
  const groups = (suggestions || []).length && typeof suggestions[0] === 'string'
    ? [{ group: '', tags: suggestions }]
    : (suggestions || []);
  const lowerTags = tags.map((t) => t.toLowerCase());
  const availableGroups = groups
    .map((g) => ({
      group: g.group,
      tags: g.tags.filter((s) => !lowerTags.includes(s.toLowerCase()) && s.toLowerCase().includes(query)),
    }))
    .filter((g) => g.tags.length > 0);

  const canAddMore = tags.length < maxTags;
  const inputId = `${baseId}-input`;

  return (
    <div
      className="form-group"
      ref={containerRef}
      style={{ position: 'relative' }}
      onBlur={(e) => {
        if (!containerRef.current?.contains(e.relatedTarget)) setIsFocused(false);
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
        {label && <label className="label" htmlFor={inputId} style={{ marginBottom: 0 }}>{label}</label>}
        <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
          {tags.length}/{maxTags}
        </span>
      </div>
      {hint && (
        <p className="field-hint" id={`${baseId}-hint`} style={{ margin: '0 0 6px' }}>{hint}</p>
      )}

      <div
        onClick={() => inputRef.current?.focus()}
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '6px',
          padding: '6px 10px',
          backgroundColor: isFocused ? '#ffffff' : 'var(--bg-field)',
          border: `1px solid ${isFocused ? 'var(--color-accent)' : 'var(--color-border-field)'}`,
          boxShadow: isFocused ? '0 0 0 3px rgba(79, 70, 229, 0.12)' : 'none',
          borderRadius: 'var(--radius-input)',
          minHeight: '42px',
          cursor: 'text',
          transition: 'border-color var(--transition-fast), box-shadow var(--transition-fast)',
        }}
      >
        {tags.map((tag, idx) => (
          <span key={`${tag}-${idx}`} className="tag-pill">
            <span>{tag}</span>
            <button
              type="button"
              className="remove-btn"
              onClick={(e) => {
                e.stopPropagation();
                removeTag(idx);
              }}
              title="Remove tag"
              aria-label={`Remove ${tag}`}
            >
              ×
            </button>
          </span>
        ))}

        {canAddMore && (
          <input
            id={inputId}
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onFocus={() => setIsFocused(true)}
            onKeyDown={handleKeyDown}
            aria-describedby={hint ? `${baseId}-hint` : undefined}
            placeholder={tags.length === 0 ? 'Pick a suggestion or type your own…' : ''}
            style={{
              flex: '1 1 80px',
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontSize: '0.8125rem',
              color: 'var(--text-primary)',
              padding: '2px 4px',
              minWidth: '80px',
            }}
          />
        )}
      </div>

      {/* Suggestions Dropdown */}
      {isFocused && canAddMore && availableGroups.length > 0 && (
        <div
          className="tag-suggestions"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            backgroundColor: '#ffffff',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-input)',
            boxShadow: 'var(--shadow-md)',
            zIndex: 30,
            maxHeight: '260px',
            overflowY: 'auto',
            padding: '4px',
          }}
        >
          {availableGroups.map((g) => (
            <div key={g.group || 'all'} role="group" aria-label={g.group || 'Suggestions'}>
              <div className="tag-suggestions-heading">
                {g.group || 'Suggestions'}
              </div>
              {g.tags.map((suggestion) => (
                <button
                  type="button"
                  key={suggestion}
                  className="tag-suggestion"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    addTag(suggestion);
                    inputRef.current?.focus();
                  }}
                >
                  + {suggestion}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
