import React from 'react';

/**
 * Clean CSS-only indigo spinner
 * @param {string} size - 'sm' | 'md' | 'lg'
 * @param {string} className - extra classes
 */
export default function LoadingSpinner({ size = 'md', className = '', label = '' }) {
  const sizeMap = {
    sm: { size: '16px', border: '2px' },
    md: { size: '24px', border: '3px' },
    lg: { size: '36px', border: '3.5px' },
  };

  const current = sizeMap[size] || sizeMap.md;

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
      }}
      className={className}
      role="status"
      aria-live="polite"
    >
      <div
        className="animate-spin"
        style={{
          width: current.size,
          height: current.size,
          borderRadius: '50%',
          border: `${current.border} solid #e0e7ff`,
          borderTopColor: 'var(--color-accent)',
        }}
      />
      {label && (
        <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
          {label}
        </span>
      )}
    </div>
  );
}
