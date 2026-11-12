import React, { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import LoadingSpinner from '../components/LoadingSpinner';

export default function LoginPage() {
  const { user, loading, signInWithGoogle } = useAuth();
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  if (loading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'var(--bg-card)',
        }}
      >
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (user) {
    return <Navigate to="/" replace />;
  }

  const handleSignIn = async () => {
    setError('');
    setSigningIn(true);
    try {
      await signInWithGoogle();
      navigate('/');
    } catch (err) {
      console.error('Sign-in failed:', err);
      setError(err.message || 'Failed to sign in with Google');
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: 'var(--bg-card)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
    >
      <div
        className="card card-white"
        style={{
          width: '100%',
          maxWidth: '420px',
          padding: '40px 32px',
          textAlign: 'center',
          boxShadow: 'var(--shadow-md)',
          borderRadius: 'var(--radius-card)',
        }}
      >
        {/* Logo */}
        <div style={{ fontSize: '2.5rem', marginBottom: '8px' }}>🎬</div>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '8px' }}>
          Eleviat
        </h1>
        <p style={{ fontSize: '0.9375rem', color: 'var(--text-secondary)', marginBottom: '32px' }}>
          Turn a product photo and an idea into a ready-to-post video ad.
        </p>

        {error && (
          <div
            style={{
              padding: '10px 14px',
              backgroundColor: 'var(--color-error-light)',
              color: 'var(--color-error)',
              borderRadius: 'var(--radius-btn)',
              fontSize: '0.8125rem',
              marginBottom: '20px',
              textAlign: 'left',
            }}
          >
            {error}
          </div>
        )}

        {/* Google Sign-in Button */}
        <button
          type="button"
          onClick={handleSignIn}
          disabled={signingIn}
          className="btn btn-secondary"
          style={{
            width: '100%',
            padding: '12px 20px',
            fontSize: '0.9375rem',
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
            backgroundColor: '#ffffff',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-btn)',
            boxShadow: 'var(--shadow-sm)',
            cursor: signingIn ? 'not-allowed' : 'pointer',
          }}
        >
          {signingIn ? (
            <LoadingSpinner size="sm" label="Connecting..." />
          ) : (
            <>
              <svg width="18" height="18" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.66-5.17 3.66-9.17z"
                />
                <path
                  fill="#34A853"
                  d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.15C3.26 21.36 7.33 24 12 24z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.25C.45 8.16 0 9.97 0 12s.45 3.84 1.25 5.42l4.03-3.15z"
                />
                <path
                  fill="#EA4335"
                  d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.33 0 3.26 2.64 1.25 6.58l4.03 3.15c.95-2.83 3.6-4.98 6.72-4.98z"
                />
              </svg>
              <span>Continue with Google</span>
            </>
          )}
        </button>

        <div style={{ marginTop: '32px', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
          Access is by invitation.{' '}
          <a href="https://eleviat.com/#apply" target="_blank" rel="noreferrer">Apply at eleviat.com</a>
        </div>
      </div>
    </div>
  );
}
