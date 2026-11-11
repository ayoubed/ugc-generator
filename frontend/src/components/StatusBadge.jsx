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
      color: '#94a3b8',
      bg: '#f1f5f9',
      label: 'Draft',
      pulse: false,
    },
    scripted: {
      color: '#2563eb',
      bg: '#eff6ff',
      label: 'Scripted',
      pulse: false,
    },
    pending: {
      color: '#64748b',
      bg: '#f8fafc',
      label: 'Pending',
      pulse: false,
    },
    queued: {
      color: '#4f46e5',
      bg: '#eef2ff',
      label: 'Queued',
      pulse: true,
    },
    generating: {
      color: '#b45309',
      bg: '#fffbeb',
      label: 'Generating',
      pulse: true,
    },
    stitching: {
      color: '#b45309',
      bg: '#fffbeb',
      label: 'Stitching',
      pulse: true,
    },
    completed: {
      color: '#16a34a',
      bg: '#f0fdf4',
      label: 'Completed',
      pulse: false,
    },
    failed: {
      color: '#dc2626',
      bg: '#fef2f2',
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
