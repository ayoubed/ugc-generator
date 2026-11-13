import React, { useState, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTheme } from '../hooks/useTheme';
import { THEMES } from '../utils/theme';

/**
 * Main application layout shell with navbar, user profile dropdown, and content container.
 */
export default function Layout({ children }) {
  const { user, signOut } = useAuth();
  const [theme, setTheme] = useTheme();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSignOut = async () => {
    try {
      await signOut();
      navigate('/login');
    } catch (err) {
      console.error('Failed to sign out:', err);
    }
  };

  const getInitials = (name) => {
    if (!name) return 'U';
    const parts = name.trim().split(' ');
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: 'var(--bg-page)' }}>
      {/* Top Navbar */}
      <header className="app-header">
        <div className="container app-header-content">
          <Link to="/" className="brand-logo">
            <span style={{ fontSize: '1.25rem' }}>🎬</span>
            <span>Eleviat</span>
          </Link>

          {user && (
            <div style={{ position: 'relative' }} ref={dropdownRef}>
              <button
                type="button"
                className="user-menu-trigger"
                onClick={() => setDropdownOpen((prev) => !prev)}
                aria-haspopup="true"
                aria-expanded={dropdownOpen}
              >
                {user.photoURL ? (
                  <img
                    src={user.photoURL}
                    alt={user.displayName || 'User'}
                    className="user-avatar"
                  />
                ) : (
                  <div className="user-avatar">
                    {getInitials(user.displayName || user.email)}
                  </div>
                )}
                <span
                  style={{
                    fontSize: '0.875rem',
                    fontWeight: 500,
                    color: 'var(--text-primary)',
                    maxWidth: '120px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {user.displayName || user.email?.split('@')[0] || 'User'}
                </span>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {dropdownOpen && (
                <div className="user-dropdown">
                  <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--color-border)', marginBottom: '4px' }}>
                    <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                      {user.displayName || 'User'}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', wordBreak: 'break-all' }}>
                      {user.email}
                    </div>
                  </div>
                  <div className="theme-choice">
                    <span className="theme-choice-label" id="theme-choice-label">Theme</span>
                    <div className="music-segmented" role="group" aria-labelledby="theme-choice-label">
                      {THEMES.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          className={`music-seg ${theme === option.value ? 'is-active' : ''}`}
                          aria-pressed={theme === option.value}
                          onClick={() => setTheme(option.value)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="dropdown-item"
                    onClick={handleSignOut}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                      <polyline points="16 17 21 12 16 7" />
                      <line x1="21" y1="12" x2="9" y2="12" />
                    </svg>
                    <span>Sign Out</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main style={{ flex: 1, paddingBottom: '60px' }}>
        {children}
      </main>
    </div>
  );
}
