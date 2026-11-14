import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Layout from '../components/Layout';
import Stepper from '../components/Stepper';
import LoadingSpinner from '../components/LoadingSpinner';
import StoryboardSceneCard from '../components/StoryboardSceneCard';
import { updateProjectSettings, useProject, useScenes } from '../hooks/useProject';
import { useModels } from '../hooks/useModels';
import { useAuth } from '../hooks/useAuth';
import { addStoryboardFrame, editStoryboardFrame } from '../services/api';
import { STEP, isSceneSkipped, maxReachableStep, sceneLabels, stepPath } from '../utils/projectProgress';
import { framesInOrder, hasLookFrame, runInPool, sceneMoment, storyboardCounts, unusedFrame } from '../utils/storyboard';

// Frames drawn at the same time by "Draw the missing frames".
const DRAW_AT_ONCE = 3;

/**
 * Step 3, optional: a picture of each scene, made with the image model before any video.
 * A picture is quick to look at and remake, so the product's size and the look of each scene are
 * settled here. A scene with an accepted picture starts its video on it; a scene without one
 * starts the way it is set on the Generate step.
 */
export default function StoryboardPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { project, loading: projectLoading } = useProject(id);
  const { scenes, loading: scenesLoading } = useScenes(id);
  const [drawing, setDrawing] = useState([]);    // ids of scenes being drawn by "Draw the missing frames"
  const [pageError, setPageError] = useState('');
  const { imageModels, defaultImageModel } = useModels();

  // The project's choice if it is still offered, otherwise the default (same rule as the server).
  const savedModel = project?.settings?.imageModel;
  const imageModelId = imageModels.some((m) => m.id === savedModel) ? savedModel : defaultImageModel;
  const imageModel = imageModels.find((m) => m.id === imageModelId);

  const chooseModel = async (event) => {
    setPageError('');
    try {
      await updateProjectSettings(id, { imageModel: event.target.value });
    } catch (err) {
      console.error('Could not save the image model:', err);
      setPageError('Could not save the image model. Check your connection and try again.');
    }
  };

  const labels = sceneLabels(scenes);
  const inVideo = scenes.filter((scene) => !isSceneSkipped(scene));
  const counts = storyboardCounts(inVideo);
  const missing = inVideo.filter((scene) => framesInOrder(scene).length === 0 && sceneMoment(scene));
  const look = hasLookFrame(scenes);
  const drawingAll = drawing.length > 0;
  // Drawn but not accepted: the video does not start on these yet.
  const unused = inVideo.filter((scene) => unusedFrame(scene));
  const [accepting, setAccepting] = useState(false);

  const useAll = async () => {
    setPageError('');
    setAccepting(true);
    try {
      // One after another, so the first one accepted sets the look of the video.
      for (const scene of unused) {
        await editStoryboardFrame(id, scene.id, unusedFrame(scene).id, { accepted: true });
      }
    } catch (err) {
      setPageError(err?.message || 'Could not use the pictures. Try again.');
    } finally {
      setAccepting(false);
    }
  };

  const drawMissing = async () => {
    setPageError('');
    setDrawing(missing.map((scene) => scene.id));
    const drawOne = async (scene) => {
      try {
        await addStoryboardFrame(id, scene.id);
      } finally {
        setDrawing((ids) => ids.filter((sceneId) => sceneId !== scene.id));
      }
    };
    // With no look set yet, the first picture is drawn alone: it sets the look, and the rest are
    // then drawn to match it. Drawn together, each would invent its own setting and light.
    const [first, ...rest] = missing;
    let failures = [];
    if (look) {
      failures = await runInPool(missing, DRAW_AT_ONCE, drawOne);
    } else {
      failures = await runInPool([first], 1, drawOne);
      failures = failures.concat(await runInPool(rest, DRAW_AT_ONCE, drawOne));
    }
    setDrawing([]);
    if (failures.length) {
      const first = failures[0].error?.message || 'Try again.';
      setPageError(
        failures.length === 1
          ? `One frame could not be drawn. ${first}`
          : `${failures.length} frames could not be drawn. ${first}`,
      );
    }
  };

  let summary = 'No frames yet. Scenes without a frame start the way they are set on the Generate step.';
  if (counts.withFrame > 0) {
    summary = `${counts.accepted} of ${counts.total} ${counts.total === 1 ? 'scene starts' : 'scenes start'} on a storyboard picture.`;
  }

  return (
    <Layout>
      <div className="container page-wrap">
        <Stepper
          currentStep={STEP.STORYBOARD}
          maxReachableStep={maxReachableStep(project, scenes)}
          onStepClick={(step) => navigate(stepPath(id, step))}
        />

        <header className="page-head">
          <div className="page-head-text">
            <h1 className="page-title">Storyboard</h1>
            <p className="page-subtitle">
              Optional. See a picture of each scene before any video is made, and fix it until the product looks
              right. Each scene&apos;s video then starts on its picture, unless you switch that off.
            </p>
          </div>
        </header>

        {pageError && <p className="page-alert" role="alert">{pageError}</p>}

        {scenesLoading || projectLoading ? (
          <div className="page-loading">
            <LoadingSpinner size="lg" label="Loading scenes…" />
          </div>
        ) : scenes.length === 0 ? (
          <div className="card card-white empty-state">
            <h2 className="empty-state-title">No scenes yet</h2>
            <p className="empty-state-text">Write your script first. Each scene of the script gets a picture here.</p>
            <div className="empty-state-actions">
              <button type="button" className="btn btn-primary" onClick={() => navigate(stepPath(id, STEP.SCRIPT))}>
                Go to Script
              </button>
            </div>
          </div>
        ) : (
          <>
            <section className="card card-white board-overview" aria-label="Storyboard progress">
              <div className="board-overview-text">
                <p className="board-overview-summary" aria-live="polite">{summary}</p>
                {!look && (
                  <p className="board-overview-tip">
                    The first picture you draw sets the look of the video: the others are drawn to match it, so the
                    product, the setting and the light stay the same. Get that one right first.
                  </p>
                )}
              </div>
              <div className="board-model">
                <label className="board-label" htmlFor="board-image-model">Image model</label>
                <select
                  id="board-image-model"
                  className="input"
                  value={imageModelId}
                  onChange={chooseModel}
                  disabled={!imageModels.length || drawingAll}
                >
                  {!imageModels.length && <option value="">Loading…</option>}
                  {imageModels.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
                {imageModel?.description && <p className="board-model-note">{imageModel.description}</p>}
              </div>
              {missing.length > 0 && (
                <button type="button" className="btn btn-secondary" onClick={drawMissing} disabled={drawingAll}>
                  {drawingAll
                    ? `Drawing ${drawing.length} ${drawing.length === 1 ? 'frame' : 'frames'}…`
                    : look
                      ? `Draw the ${missing.length} missing ${missing.length === 1 ? 'frame' : 'frames'} to match`
                      : `Draw the ${missing.length} missing ${missing.length === 1 ? 'frame' : 'frames'}`}
                </button>
              )}
            </section>

            <div className="board-list">
              {scenes.map((scene, idx) => (
                <StoryboardSceneCard
                  key={scene.id}
                  projectId={id}
                  uid={user?.uid}
                  scene={scene}
                  label={labels[idx]}
                  skipped={isSceneSkipped(scene)}
                  drawing={drawing.includes(scene.id)}
                />
              ))}
            </div>

            <div className="page-actions">
              <button type="button" className="btn btn-secondary btn-lg" onClick={() => navigate(stepPath(id, STEP.SCRIPT))}>
                ← Script
              </button>
              <div className="page-actions-end">
                {unused.length > 0 && (
                  <>
                    <span className="page-actions-note">
                      {unused.length === 1
                        ? '1 picture is not used yet: its scene will not start on it.'
                        : `${unused.length} pictures are not used yet: their scenes will not start on them.`}
                    </span>
                    <button type="button" className="btn btn-secondary btn-lg" onClick={useAll} disabled={accepting || drawingAll}>
                      {accepting ? 'Saving…' : unused.length === 1 ? 'Use it' : `Use all ${unused.length}`}
                    </button>
                  </>
                )}
                <button type="button" className="btn btn-primary btn-lg" onClick={() => navigate(stepPath(id, STEP.GENERATE))}>
                  {counts.withFrame === 0 ? 'Skip to Generate' : 'Generate videos'}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}
