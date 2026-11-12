import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import LoadingSpinner from './components/LoadingSpinner';

// Pages
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import CreatePage from './pages/CreatePage';
import EditScenesPage from './pages/EditScenesPage';
import GeneratePage from './pages/GeneratePage';
import FinishPage from './pages/FinishPage';
import ExportPage from './pages/ExportPage';

/**
 * Shown to a signed-in account that may not use the app: it is not on the allowlist, or the check
 * could not be made.
 */
// Where someone without access can reach the team: the application form on the public site.
const TEAM_CONTACT_URL = 'https://eleviat.com/#apply';

function NoAccess() {
  const { user, access, signOut, retryAccessCheck } = useAuth();
  const denied = access === 'denied';
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        backgroundColor: 'var(--bg-card)',
      }}
    >
      <div className="card card-white empty-state" style={{ maxWidth: '440px' }} role="alert">
        <h1 className="empty-state-title">
          {denied ? 'This account doesn\u2019t have access' : 'Couldn\u2019t check your access'}
        </h1>
        <p className="empty-state-text">
          {denied
            ? `${user?.email || 'This account'} isn\u2019t on the access list.`
            : 'The server could not be reached. Check your connection and try again.'}
        </p>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
          {denied && (
            <a className="btn btn-primary" href={TEAM_CONTACT_URL} target="_blank" rel="noreferrer">Talk to the team</a>
          )}
          {!denied && (
            <button type="button" className="btn btn-primary" onClick={retryAccessCheck}>Try again</button>
          )}
          <button type="button" className="btn btn-secondary" onClick={() => signOut()}>
            {denied ? 'Use a different account' : 'Sign out'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Route guard requiring authenticated user
 */
function ProtectedRoute({ children }) {
  const { user, loading, access } = useAuth();

  if (loading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'var(--bg-primary)',
        }}
      >
        <LoadingSpinner size="lg" label="Loading UGC Studio..." />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (access !== 'allowed') {
    return <NoAccess />;
  }

  return children;
}

/**
 * Route guard for public-only routes (e.g. login)
 */
function PublicRoute({ children }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'var(--bg-primary)',
        }}
      >
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (user) {
    return <Navigate to="/" replace />;
  }

  return children;
}

export default function App() {
  return (
    <Routes>
      {/* Public Route */}
      <Route
        path="/login"
        element={
          <PublicRoute>
            <LoginPage />
          </PublicRoute>
        }
      />

      {/* Protected Routes */}
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/project/:id/create"
        element={
          <ProtectedRoute>
            <CreatePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/project/:id/scenes"
        element={
          <ProtectedRoute>
            <EditScenesPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/project/:id/generate"
        element={
          <ProtectedRoute>
            <GeneratePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/project/:id/finish"
        element={
          <ProtectedRoute>
            <FinishPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/project/:id/export"
        element={
          <ProtectedRoute>
            <ExportPage />
          </ProtectedRoute>
        }
      />

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
