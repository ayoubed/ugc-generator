import React from 'react';

/**
 * StatusBadge component showing a colored dot + text indicator
 * @param {string} status - 'draft' | 'scripted' | 'pending' | 'queued' | 'generating' | 'stitching' | 'completed' | 'failed'
 * @param {string} label - Optional text that replaces the default label (e.g. "Generating · 1:05")
 */
export default function StatusBadge({ status = 'pending', label = '', className = '' }) {
  const normalized = (status || 'pending').toLowerCase();

  const configs = {
    draft: {
      color: 'var(--text-tertiary)',
      bg: 'var(--bg-hover)',
      label: 'Draft',
      pulse: false,
    },
    scripted: {
      color: 'var(--color-info)',
      bg: 'var(--color-info-light)',
      label: 'Scripted',
      pulse: false,
    },
    pending: {
      color: 'var(--text-secondary)',
      bg: 'var(--bg-card)',
      label: 'Pending',
      pulse: false,
    },
    queued: {
      color: 'var(--color-accent-text)',
      bg: 'var(--color-accent-light)',
      label: 'Queued',
      pulse: true,
    },
    generating: {
      color: 'var(--color-warning-text)',
      bg: 'var(--color-warning-light)',
      label: 'Generating',
      pulse: true,
    },
    stitching: {
      color: 'var(--color-warning-text)',
      bg: 'var(--color-warning-light)',
      label: 'Stitching',
      pulse: true,
    },
    completed: {
      color: 'var(--color-success)',
      bg: 'var(--color-success-light)',
      label: 'Completed',
      pulse: false,
    },
    failed: {
      color: 'var(--color-error)',
      bg: 'var(--color-error-light)',
      label: 'Failed',
      pulse: false,
    },
  };

  const config = configs[normalized] || configs.pending;

  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '3px 8px',
        borderRadius: 'var(--radius-pill)',
        fontSize: '0.75rem',
        fontWeight: 500,
        backgroundColor: config.bg,
        color: config.color,
        border: `1px solid ${config.color}25`,
        userSelect: 'none',
      }}
    >
      <span
        className={config.pulse ? 'animate-pulse' : ''}
        style={{
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          backgroundColor: config.color,
          display: 'inline-block',
        }}
      />
      {label || config.label}
    </span>
  );
}
