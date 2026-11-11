import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import StatusBadge from '../components/StatusBadge';
import LoadingSpinner from '../components/LoadingSpinner';
import { useProjects, createProject } from '../hooks/useProject';
import { useStorageUrl } from '../hooks/useStorageUrl';
import { deleteProjectEverywhere, duplicateProject } from '../services/api';
import { friendlyError } from '../utils/errors';
import { stepPath } from '../utils/projectProgress';

/** The creator photo as a small poster, so projects can be told apart at a glance. */
function ProjectThumb({ storageRef }) {
  const url = useStorageUrl(storageRef || '');
  if (!url) return <span className="project-thumb" aria-hidden="true" />;
  return <img className="project-thumb" src={url} alt="" loading="lazy" />;
}

export default function DashboardPage() {
  const { projects, loading, error } = useProjects();
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [duplicatingId, setDuplicatingId] = useState(null);
  const [actionError, setActionError] = useState('');
  const navigate = useNavigate();

  const handleCreateNew = async () => {
    try {
      setCreating(true);
      const newProjectId = await createProject();
      navigate(`/project/${newProjectId}/create`);
    } catch (err) {
      console.error('Error creating new project:', err);
      setActionError('Could not create the project. Check your connection and try again.');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (e, projectId) => {
    e.stopPropagation();
    if (!window.confirm('Delete this project with all its videos and pictures? This cannot be undone.')) return;
    setActionError('');
    try {
      setDeletingId(projectId);
      // The server also removes the files and stops takes that are still being made.
      await deleteProjectEverywhere(projectId);
    } catch (err) {
      console.error('Failed to delete project:', err);
      setActionError(friendlyError(err));
    } finally {
      setDeletingId(null);
    }
  };

  const handleDuplicate = async (e, projectId) => {
    e.stopPropagation();
    setActionError('');
    try {
      setDuplicatingId(projectId);
      const copy = await duplicateProject(projectId);
      // With a script, the copy opens on the Script step, ready to be edited.
      navigate(stepPath(copy.id, copy.hasScript ? 2 : 1));
    } catch (err) {
      console.error('Failed to duplicate project:', err);
      setActionError(friendlyError(err));
      setDuplicatingId(null);
    }
  };

  const getRouteForProject = (project) => {
    const status = (project.status || 'draft').toLowerCase();
    if (status === 'completed') return `/project/${project.id}/export`;
    if (status === 'generating') return `/project/${project.id}/generate`;
    if (status === 'scripted') return `/project/${project.id}/scenes`;
    return `/project/${project.id}/create`;
  };

  const formatDate = (timestamp) => {
    if (!timestamp) return 'Just now';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  return (
    <Layout>
      <div className="container" style={{ paddingTop: '40px' }}>
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '32px',
          }}
        >
          <div>
            <h1 style={{ fontSize: '1.75rem', fontWeight: 700, marginBottom: '6px' }}>
              Your Projects
            </h1>
            <p style={{ color: 'var(--text-secondary)' }}>
              Manage and generate AI-driven user generated content videos
            </p>
          </div>

          <button
            type="button"
            className="btn btn-primary"
            onClick={handleCreateNew}
            disabled={creating}
          >
            {creating ? (
              <LoadingSpinner size="sm" label="Creating..." />
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                <span>New Project</span>
              </>
            )}
          </button>
        </div>

        {actionError && <p className="page-alert" role="alert">{actionError}</p>}

        {/* Content */}
        {loading ? (
          <div
            style={{
              padding: '80px 0',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '16px',
            }}
          >
            <LoadingSpinner size="lg" />
            <p style={{ color: 'var(--text-secondary)' }}>Loading your projects...</p>
          </div>
        ) : error ? (
          <div
            style={{
              padding: '24px',
              backgroundColor: 'var(--color-error-light)',
              color: 'var(--color-error)',
              borderRadius: 'var(--radius-card)',
            }}
          >
            Failed to load projects: {error.message}
          </div>
        ) : projects.length === 0 ? (
          /* Empty State */
          <div
            className="card card-white"
            style={{
              padding: '64px 24px',
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              borderStyle: 'dashed',
            }}
          >
            <div
              style={{
                width: '64px',
                height: '64px',
                borderRadius: '50%',
                backgroundColor: 'var(--color-accent-light)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '2rem',
                marginBottom: '16px',
              }}
            >
              🎬
            </div>
            <h3 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '8px' }}>
              No projects yet
            </h3>
            <p
              style={{
                maxWidth: '420px',
                color: 'var(--text-secondary)',
                marginBottom: '24px',
                fontSize: '0.9375rem',
              }}
            >
              Start by creating a new UGC video project. Define your hook, generate AI script scenes, and produce high-converting authentic videos.
            </p>
            <button
              type="button"
              className="btn btn-primary btn-lg"
              onClick={handleCreateNew}
              disabled={creating}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span>Create Your First Project</span>
            </button>
          </div>
        ) : (
          /* Projects Grid */
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
              gap: '20px',
            }}
          >
            {projects.map((project) => {
              const displayTitle = project.title || project.idea || 'Untitled Project';
              const truncated =
                displayTitle.length > 55 ? displayTitle.slice(0, 52) + '...' : displayTitle;

              return (
                <div
                  key={project.id}
                  className="card card-interactive"
                  onClick={() => navigate(getRouteForProject(project))}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    minHeight: '170px',
                    position: 'relative',
                  }}
                >
                  <div className="project-card-top">
                    <ProjectThumb storageRef={project.startingImageRef} />
                    <div className="project-card-body">
                    {/* Status & Date */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginBottom: '14px',
                      }}
                    >
                      <StatusBadge status={project.status || 'draft'} />
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                        {formatDate(project.updatedAt || project.createdAt)}
                      </span>
                    </div>

                    {/* Title */}
                    <h3
                      style={{
                        fontSize: '1rem',
                        fontWeight: 600,
                        color: 'var(--text-primary)',
                        marginBottom: '8px',
                        lineHeight: 1.4,
                      }}
                    >
                      {truncated}
                    </h3>

                    {project.idea && project.idea !== displayTitle && (
                      <p
                        style={{
                          fontSize: '0.8125rem',
                          color: 'var(--text-secondary)',
                          lineHeight: 1.4,
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}
                      >
                        {project.idea}
                      </p>
                    )}
                    </div>
                  </div>

                  {/* Footer with actions */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      paddingTop: '16px',
                      marginTop: '12px',
                      borderTop: '1px solid var(--color-border)',
                    }}
                  >
                    <span
                      style={{
                        fontSize: '0.8125rem',
                        color: 'var(--color-accent)',
                        fontWeight: 500,
                      }}
                    >
                      Open Project →
                    </span>

                    <div className="project-card-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={(e) => handleDuplicate(e, project.id)}
                      disabled={duplicatingId !== null}
                      title="Copy this project with its script, pictures, style and music (videos are not copied)"
                      style={{ color: 'var(--text-secondary)', padding: '4px 8px' }}
                    >
                      {duplicatingId === project.id ? <LoadingSpinner size="sm" label="Copying…" /> : 'Duplicate'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={(e) => handleDelete(e, project.id)}
                      disabled={deletingId === project.id}
                      title="Delete project"
                      style={{
                        color: 'var(--text-tertiary)',
                        padding: '4px',
                        borderRadius: '4px',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--color-error)')}
                      onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-tertiary)')}
                    >
                      {deletingId === project.id ? (
                        <LoadingSpinner size="sm" />
                      ) : (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      )}
                    </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Layout>
  );
}
