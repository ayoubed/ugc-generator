import React, { useState, useEffect, useRef } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import Stepper from '../components/Stepper';
import ImageUpload from '../components/ImageUpload';
import ReferenceImageUploader from '../components/ReferenceImageUploader';
import TagInput from '../components/TagInput';
import LoadingSpinner from '../components/LoadingSpinner';
import AssetBibleCard from '../components/AssetBibleCard';
import { useAuth } from '../hooks/useAuth';
import { useProject, useScenes, updateProject, saveProjectWithSettings } from '../hooks/useProject';
import SaveIndicator from '../components/SaveIndicator';
import { useModels, resolveVideoModel, modelPictureLimit } from '../hooks/useModels';
import { generateScenes, resolveStorageUrl } from '../services/api';
import { storage } from '../services/firebase';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { isSceneBusy, maxReachableStep, sceneHasVideo, stepPath } from '../utils/projectProgress';
import { normalizeAssetBible, sameAssetBible } from '../utils/assetBible';

import {
  ACCENTS,
  EMPTY_GUIDELINES,
  GUIDELINE_CATEGORIES,
  GUIDELINE_PRESETS,
  GUIDELINE_SUGGESTIONS,
  SCENE_AUDIO_OPTIONS,
  projectSceneAudio,
} from '../data/guidelineTags';

const HOOK_STYLES = [
  'Auto-Select (AI chooses the best hook)',
  'The Snippet (In Media Res)',
  'The Question (Pain Point Focus)',
  'The On-Screen Text',
  'The "You-Feature" (Signature Branding)',
  'The Quick Cuts (Fast-Paced Editing)',
  'Custom Hook',
];

function CreateIdea({ projectId: id }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { project, loading: projectLoading } = useProject(id);
  const { scenes } = useScenes(id);

  // Main Form State
  const [idea, setIdea] = useState('');
  const [numScenes, setNumScenes] = useState(3);
  const [hookStyle, setHookStyle] = useState(HOOK_STYLES[0]);
  const [customHookDesc, setCustomHookDesc] = useState('');
  const [wordsPerScene, setWordsPerScene] = useState(20);
  const [wordsCustomized, setWordsCustomized] = useState(false);

  // Fixed details reused in every scene (see utils/assetBible.js)
  const [assetBible, setAssetBible] = useState(() => normalizeAssetBible(null));

  // Image Upload State
  const [selectedFile, setSelectedFile] = useState(null);
  const [startingImageRef, setStartingImageRef] = useState('');
  const [imagePreviewUrl, setImagePreviewUrl] = useState('');
  const [uploadingImage, setUploadingImage] = useState(false);

  // Settings Panel State
  const [aspectRatio, setAspectRatio] = useState('9:16');
  const [duration, setDuration] = useState(8);
  const [resolution, setResolution] = useState('720p');
  const [scriptModel, setScriptModel] = useState('');
  const [videoModel, setVideoModel] = useState('');
  const [accent, setAccent] = useState('');
  const [sceneAudio, setSceneAudio] = useState(projectSceneAudio(null));

  // Models come from the backend (GET /api/models). A saved model that's no longer offered
  // (e.g. a retired Veo model) falls back to the default, same as the backend.
  const { videoModels, scriptModels, defaultScriptModel, error: modelsError } = useModels();
  const selectedVideoModel = resolveVideoModel(videoModels, videoModel);
  const videoModelId = selectedVideoModel?.id || videoModel;
  const scriptModelId = scriptModels.some((m) => m.id === scriptModel)
    ? scriptModel
    : defaultScriptModel || scriptModel;
  const aspectRatioOptions = selectedVideoModel?.aspect_ratios || ['9:16', '16:9'];
  const durationOptions = selectedVideoModel?.durations || [5, 6, 7, 8];
  const resolutionOptions = selectedVideoModel?.resolutions || ['720p', '1080p'];
  const pictureLimit = modelPictureLimit(selectedVideoModel);

  // Guidelines Tags State (new projects start empty: nothing is applied unless the user adds it)
  const [cameraTags, setCameraTags] = useState(EMPTY_GUIDELINES.camera);
  const [lightingTags, setLightingTags] = useState(EMPTY_GUIDELINES.lighting);
  const [actionTags, setActionTags] = useState(EMPTY_GUIDELINES.action);
  const [scriptToneTags, setScriptToneTags] = useState(EMPTY_GUIDELINES.scriptTone);
  const [visualTags, setVisualTags] = useState(EMPTY_GUIDELINES.visual);
  const [audioTags, setAudioTags] = useState(EMPTY_GUIDELINES.audio);

  const guidelineState = {
    camera: [cameraTags, setCameraTags],
    lighting: [lightingTags, setLightingTags],
    action: [actionTags, setActionTags],
    scriptTone: [scriptToneTags, setScriptToneTags],
    visual: [visualTags, setVisualTags],
    audio: [audioTags, setAudioTags],
  };
  const hasAnyGuideline = Object.values(guidelineState).some(([tags]) => tags.length > 0);
  const activePresetId = GUIDELINE_PRESETS.find((preset) =>
    Object.entries(guidelineState).every(
      ([key, [tags]]) => JSON.stringify(tags) === JSON.stringify(preset.tags[key] || [])
    )
  )?.id;

  const applyPreset = (preset) => {
    Object.entries(guidelineState).forEach(([key, [, setTags]]) => setTags([...(preset.tags[key] || [])]));
  };
  const clearGuidelines = () => {
    Object.values(guidelineState).forEach(([, setTags]) => setTags([]));
  };

  // Execution state
  const [generating, setGenerating] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState('');

  // Sync initial project data when loaded
  const initializedRef = useRef(false);
  // True once the saved project has been copied into the form: nothing is autosaved before that.
  const [ready, setReady] = useState(false);
  const [saveState, setSaveState] = useState('idle'); // 'idle' | 'saving' | 'saved' | 'error'
  useEffect(() => {
    if (project && !initializedRef.current) {
      initializedRef.current = true;
      queueMicrotask(() => {
        if (project.idea) setIdea(project.idea);
        if (project.startingImageRef) {
          setStartingImageRef(project.startingImageRef);
          resolveStorageUrl(project.startingImageRef).then((url) => {
            setImagePreviewUrl(url);
          });
        }
        if (project.settings) {
          const s = project.settings;
          if (s.numScenes) setNumScenes(s.numScenes);
          if (s.hookStyle) setHookStyle(s.hookStyle);
          if (s.customHookDesc) setCustomHookDesc(s.customHookDesc);
          if (s.wordsPerScene) {
            setWordsPerScene(s.wordsPerScene);
            setWordsCustomized(true);
          }
          if (s.aspectRatio) setAspectRatio(s.aspectRatio);
          if (s.duration) setDuration(s.duration);
          if (s.resolution) setResolution(s.resolution);
          if (s.scriptModel) setScriptModel(s.scriptModel);
          if (s.videoModel) setVideoModel(s.videoModel);
          if (s.accent) setAccent(s.accent);
          setSceneAudio(projectSceneAudio(s));
          if (s.cameraTags) setCameraTags(s.cameraTags);
          if (s.lightingTags) setLightingTags(s.lightingTags);
          if (s.actionTags) setActionTags(s.actionTags);
          if (s.scriptToneTags) setScriptToneTags(s.scriptToneTags);
          if (s.visualTags) setVisualTags(s.visualTags);
          if (s.audioTags) setAudioTags(s.audioTags);
          if (s.assetBible) setAssetBible(normalizeAssetBible(s.assetBible));
        }
        setReady(true);
      });
    }
  }, [project]);

  // Recalculate words per scene when duration changes unless manually customized
  const handleDurationChange = (newDuration) => {
    setDuration(newDuration);
    if (!wordsCustomized) {
      setWordsPerScene(Math.round(newDuration * 2.5));
    }
  };

  // Keep the video settings within what the chosen model supports.
  const handleVideoModelChange = (modelId) => {
    setVideoModel(modelId);
    const model = videoModels.find((m) => m.id === modelId);
    if (!model) return;
    if (model.durations?.length && !model.durations.includes(duration)) {
      handleDurationChange(model.durations[model.durations.length - 1]);
    }
    if (model.resolutions?.length && !model.resolutions.includes(resolution)) {
      setResolution(model.resolutions[model.resolutions.length - 1]);
    }
    if (model.aspect_ratios?.length && !model.aspect_ratios.includes(aspectRatio)) {
      setAspectRatio(model.aspect_ratios[0]);
    }
  };

  const handleImageFileSelect = async (file) => {
    setSelectedFile(file);
    if (!user || !id) return;

    try {
      setUploadingImage(true);
      const ext = file.name.split('.').pop() || 'jpg';
      const storagePath = `users/${user.uid}/projects/${id}/starting_image.${ext}`;
      const fileRef = ref(storage, storagePath);

      await uploadBytes(fileRef, file, {
        contentType: file.type,
      });

      const downloadUrl = await getDownloadURL(fileRef);
      setStartingImageRef(storagePath);
      setImagePreviewUrl(downloadUrl);

      // Save startingImageRef to Firestore project
      await updateProject(id, {
        startingImageRef: storagePath,
      });
    } catch (err) {
      console.error('Failed to upload starting image:', err);
      alert('Failed to upload image. Please check your storage rules.');
    } finally {
      setUploadingImage(false);
    }
  };

  const buildSettings = () => ({
    numScenes,
    hookStyle,
    customHookDesc: hookStyle === 'Custom Hook' ? customHookDesc : '',
    wordsPerScene,
    aspectRatio,
    duration,
    resolution,
    scriptModel: scriptModelId || '',
    videoModel: videoModelId || '',
    accent,
    sceneAudio,
    cameraTags,
    lightingTags,
    actionTags,
    scriptToneTags,
    visualTags,
    audioTags,
    assetBible,
  });

  const saveCurrentSettings = async (finalImageRef = startingImageRef) => {
    const settingsData = buildSettings();
    const cleanIdea = idea.trim();

    // Each setting is written on its own: the Scenes page owns settings.videoContext and the server
    // owns settings.music, so they are never overwritten from here.
    await saveProjectWithSettings(id, {
      idea: cleanIdea,
      // An empty idea keeps the existing title rather than blanking it.
      title: cleanIdea
        ? (cleanIdea.length > 50 ? cleanIdea.slice(0, 47) + '...' : cleanIdea)
        : project?.title || 'Untitled UGC Project',
      startingImageRef: finalImageRef,
    }, settingsData);
  };

  /** Whether the form differs from what is saved on the project. */
  const hasUnsavedChanges = () => {
    if (!project) return false;
    const saved = project.settings || {};
    const current = buildSettings();
    return (
      idea.trim() !== (project.idea || '')
      || (startingImageRef || '') !== (project.startingImageRef || '')
      || Object.keys(current).some((key) => (
        key === 'assetBible'
          ? !sameAssetBible(current[key], saved[key])
          : JSON.stringify(current[key]) !== JSON.stringify(saved[key])
      ))
    );
  };

  // Autosave: a short pause after the last change saves the form, like the Script and Generate steps.
  const formSignature = JSON.stringify([idea.trim(), startingImageRef, buildSettings()]);
  const latestRef = useRef({ dirty: false, save: null });
  useEffect(() => {
    latestRef.current = { dirty: ready && !generating && hasUnsavedChanges(), save: saveCurrentSettings };
  });

  const saveNow = async () => {
    setSaveState('saving');
    try {
      await latestRef.current.save();
      setSaveState('saved');
    } catch (err) {
      console.error('Could not save the idea and settings:', err);
      setSaveState('error');
    }
  };

  useEffect(() => {
    if (!ready || generating || !latestRef.current.dirty) return undefined;
    setSaveState('saving');
    const timer = setTimeout(saveNow, 1000);
    return () => clearTimeout(timer);
    // The signature covers every field of the form.
  }, [formSignature, ready, generating]); // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving the page (navbar, back button) saves what the timer had not saved yet.
  useEffect(() => () => {
    const { dirty, save } = latestRef.current;
    if (dirty && save) save().catch((err) => console.error('Could not save before leaving:', err));
  }, []);

  // Warn before closing the tab while edits are unsaved.
  useEffect(() => {
    if (saveState !== 'saving' && saveState !== 'error') return undefined;
    const onBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [saveState]);

  // Stepper: save edits first so jumping ahead (e.g. to the final video) never drops them.
  const handleStepClick = async (step) => {
    setError('');
    if (!hasUnsavedChanges()) {
      navigate(stepPath(id, step));
      return;
    }
    setLeaving(true);
    try {
      // Firestore applies the write locally right away, so a slow connection doesn't block leaving.
      await Promise.race([saveCurrentSettings(), new Promise((resolve) => setTimeout(resolve, 4000))]);
      navigate(stepPath(id, step));
    } catch (err) {
      console.error('Failed to save before leaving:', err);
      setError('Could not save your changes. Try again.');
      setLeaving(false);
    }
  };

  const handleSaveAndContinue = async () => {
    try {
      setGenerating(true);
      await saveCurrentSettings();
      navigate(`/project/${id}/scenes`);
    } catch (err) {
      console.error('Failed to save settings:', err);
      setError('Failed to save settings before continuing.');
    } finally {
      setGenerating(false);
    }
  };

  // Writing the script again replaces every scene's text, so it asks first.
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false);
  const scenesWithVideo = scenes.filter(sceneHasVideo).length;
  const sceneBusy = scenes.some(isSceneBusy);

  const handleGenerateScenes = async (e) => {
    e.preventDefault();
    setError('');

    if (sceneBusy) {
      setError('A scene is making a take right now. Wait for it to finish or cancel it on the Generate step first.');
      return;
    }
    if (scenes.length > 0 && !confirmingRegenerate) {
      setConfirmingRegenerate(true);
      return;
    }
    setConfirmingRegenerate(false);

    if (!idea.trim()) {
      setError('Please provide a video idea.');
      return;
    }

    if (!startingImageRef && !selectedFile) {
      setError('Please upload a starting image of the person.');
      return;
    }

    setGenerating(true);

    try {
      let finalImageRef = startingImageRef;

      // If user selected a file but it hasn't uploaded yet
      if (selectedFile && !finalImageRef) {
        try {
          setUploadingImage(true);
          const ext = selectedFile.name.split('.').pop() || 'jpg';
          const storagePath = `users/${user.uid}/projects/${id}/starting_image.${ext}`;
          const fileRef = ref(storage, storagePath);
          await uploadBytes(fileRef, selectedFile, {
            contentType: selectedFile.type,
          });
          finalImageRef = storagePath;
          setStartingImageRef(finalImageRef);
        } finally {
          setUploadingImage(false);
        }
      }

      // Persist latest project settings to Firestore
      await saveCurrentSettings(finalImageRef);

      // Call Backend API to generate scenes
      // Field names must match GenerateScenesRequest in backend/app/models.py: unknown fields
      // are dropped silently, which used to swap the user's guidelines for built-in defaults.
      // The server writes the script and saves the scenes (the page gets them through its live listener).
      await generateScenes(id, {
        idea: idea.trim(),
        num_scenes: numScenes,
        target_words_per_scene: wordsPerScene,
        hook_style: hookStyle,
        custom_hook_desc: hookStyle === 'Custom Hook' ? customHookDesc : '',
        llm_model: scriptModelId,
        asset_bible: assetBible,
        guidelines: {
          camera_specifics: cameraTags,
          lighting_restraints: lightingTags,
          relatable_action: actionTags,
          script_tone: scriptToneTags,
          visual_consistency: visualTags,
          audio_consistency: audioTags,
          accent,
        },
      });

      // Navigate to Step 2: Edit Scenes
      navigate(`/project/${id}/scenes`);
    } catch (err) {
      console.error('Error generating scenes:', err);
      setError(err.message || 'Failed to generate scenes. Please try again.');
    } finally {
      setGenerating(false);
    }
  };

  if (projectLoading) {
    return (
      <Layout>
        <div style={{ padding: '80px 0', textAlign: 'center' }}>
          <LoadingSpinner size="lg" label="Loading project..." />
        </div>
      </Layout>
    );
  }

  if (!project) {
    return (
      <Layout>
        <div className="container page-wrap">
          <div className="card card-white empty-state">
            <h1 className="empty-state-title">Project not found</h1>
            <p className="empty-state-text">It may have been deleted, or it belongs to another account.</p>
            <Link to="/" className="btn btn-primary">Back to dashboard</Link>
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="container" style={{ paddingTop: '20px' }}>
        {/* Step Indicator */}
        <Stepper
          currentStep={1}
          maxReachableStep={maxReachableStep(project, scenes)}
          onStepClick={generating || uploadingImage || leaving ? undefined : handleStepClick}
        />

        <header className="page-head" style={{ marginBottom: '28px' }}>
          <div className="page-head-text">
            <h1 style={{ fontSize: '1.6rem', fontWeight: 700, marginBottom: '6px' }}>
              Step 1: Define Video Idea & Guidelines
            </h1>
            <p style={{ color: 'var(--text-secondary)' }}>
              Describe your concept, upload a creator photo, and configure cinematic constraints.
            </p>
          </div>
          <SaveIndicator state={saveState} onRetry={saveNow} />
        </header>

        {error && (
          <div
            style={{
              padding: '12px 16px',
              backgroundColor: 'var(--color-error-light)',
              color: 'var(--color-error)',
              borderRadius: 'var(--radius-btn)',
              fontSize: '0.875rem',
              marginBottom: '24px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{error}</span>
          </div>
        )}

        {/* Two-Column Grid: Form (~60%) + Settings Panel (~40%) */}
        <form onSubmit={handleGenerateScenes}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
              gap: '32px',
              alignItems: 'start',
            }}
          >
            {/* Left Column: Main Form */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
              <div className="card card-white">
                <h3 style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: '16px' }}>
                  Core Video Concept
                </h3>

                {/* Idea Textarea */}
                <div className="form-group">
                  <label className="label">What's your video idea?</label>
                  <textarea
                    className="textarea"
                    rows={4}
                    value={idea}
                    onChange={(e) => setIdea(e.target.value)}
                    placeholder="e.g. A casual college student sharing how they made extra money selling lecture summaries, showing an unfiltered selfie-camera perspective..."
                    required
                  />
                </div>

                {/* Image Upload Component */}
                <ImageUpload
                  label="Starting Image of Person"
                  description="Upload a photo of the person/creator speaking (PNG or JPG). Scene 1 will begin from this image."
                  previewUrl={imagePreviewUrl}
                  onUpload={handleImageFileSelect}
                  onRemove={() => {
                    setSelectedFile(null);
                    setStartingImageRef('');
                    setImagePreviewUrl('');
                  }}
                />
                {uploadingImage && (
                  <div style={{ marginTop: '8px', fontSize: '0.8125rem', color: 'var(--color-accent)' }}>
                    <LoadingSpinner size="sm" label="Uploading photo to secure storage..." />
                  </div>
                )}
              </div>

              <AssetBibleCard
                value={assetBible}
                onChange={setAssetBible}
                idea={idea}
                scriptModel={scriptModelId}
                disabled={generating}
              />

              <div className="card card-white">
                <h3 style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: '4px' }}>
                  Context Pictures <span style={{ fontWeight: 500, color: 'var(--text-tertiary)', fontSize: '0.875rem' }}>(optional)</span>
                </h3>
                <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', marginBottom: '16px' }}>
                  Applied to every scene. The script writer and the video model both get them.
                </p>
                <ReferenceImageUploader
                  label="Video-wide pictures"
                  hint="Products, places, outfits or other people that should appear. Say what each one is, e.g. “The product: a matte black water bottle”."
                  images={project?.globalImages || []}
                  maxImages={pictureLimit}
                  storagePrefix={user ? `users/${user.uid}/projects/${id}/context` : ''}
                  onChange={(next) => updateProject(id, { globalImages: next })}
                  budgetNote={`Each scene can use ${pictureLimit} pictures in total. Video-wide pictures count towards every scene, so leave room if you plan to add scene-specific ones. You can also change them on the Script step.`}
                />
              </div>

              <div className="card card-white">
                <h3 style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: '16px' }}>
                  Pacing & Script Configuration
                </h3>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: '16px',
                    marginBottom: '16px',
                  }}
                >
                  {/* Number of scenes */}
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="label">Number of Scenes (1-10)</label>
                    <input
                      type="number"
                      className="input"
                      min={1}
                      max={10}
                      value={numScenes}
                      onChange={(e) => setNumScenes(Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 1)))}
                    />
                  </div>

                  {/* Words per scene */}
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="label">Words per Scene</label>
                    <input
                      type="number"
                      className="input"
                      min={5}
                      max={100}
                      value={wordsPerScene}
                      onChange={(e) => {
                        setWordsCustomized(true);
                        setWordsPerScene(parseInt(e.target.value, 10) || 20);
                      }}
                    />
                    <span style={{ fontSize: '0.6875rem', color: 'var(--text-tertiary)' }}>
                      Auto-calc: ~{Math.round(duration * 2.5)} words for {duration}s duration
                    </span>
                  </div>
                </div>

                {/* Hook Style Dropdown */}
                <div className="form-group">
                  <label className="label">Hook Style</label>
                  <select
                    className="select"
                    value={hookStyle}
                    onChange={(e) => setHookStyle(e.target.value)}
                  >
                    {HOOK_STYLES.map((style) => (
                      <option key={style} value={style}>
                        {style}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Custom Hook Description if Custom Hook selected */}
                {hookStyle === 'Custom Hook' && (
                  <div className="form-group">
                    <label className="label">Custom Hook Description</label>
                    <textarea
                      className="textarea"
                      rows={2}
                      value={customHookDesc}
                      onChange={(e) => setCustomHookDesc(e.target.value)}
                      placeholder="Define your own custom hook (e.g. Start by whispering a secret directly into the phone microphone...)"
                    />
                  </div>
                )}
              </div>

              {confirmingRegenerate && (
                <div className="gen-note is-warning" role="alertdialog" aria-labelledby="regen-title" style={{ padding: '14px 16px' }}>
                  <p id="regen-title" style={{ fontWeight: 600, marginBottom: '6px' }}>Replace the current script?</p>
                  <p style={{ marginBottom: '12px' }}>
                    The text of all {scenes.length} {scenes.length === 1 ? 'scene' : 'scenes'} is rewritten, including your edits.
                    {numScenes < scenes.length
                      ? ` Scenes ${numScenes + 1} and up are deleted with their videos.`
                      : ''}
                    {scenesWithVideo > 0
                      ? ' Videos of the scenes that stay are kept, but they will no longer match the new script.'
                      : ''}
                  </p>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button type="submit" id="create-regenerate-confirm" className="btn btn-primary btn-sm" disabled={generating}>
                      Replace the script
                    </button>
                    <button
                      type="button"
                      id="create-regenerate-cancel"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setConfirmingRegenerate(false)}
                    >
                      Keep the current script
                    </button>
                  </div>
                </div>
              )}

              {/* Submit / Navigation Buttons */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '8px', gap: '12px' }}>
                {project && project.status && project.status !== 'draft' && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-lg"
                    onClick={handleSaveAndContinue}
                    disabled={generating || uploadingImage}
                  >
                    Continue to Scenes →
                  </button>
                )}
                <button
                  type="submit"
                  className="btn btn-primary btn-lg"
                  disabled={generating || uploadingImage}
                  style={{ minWidth: '200px' }}
                >
                  {generating ? (
                    <LoadingSpinner size="sm" label="Generating Scenes..." />
                  ) : (
                    <>
                      <span>{project && project.status !== 'draft' ? 'Regenerate Scenes' : 'Generate Scenes'}</span>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Right Column: Settings Panel */}
            <div
              className="card card-white"
              style={{
                position: 'sticky',
                top: '84px',
              }}
            >
              <h3 style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: '16px' }}>
                Video Parameters & AI Models
              </h3>

              {/* Aspect Ratio */}
              <div className="form-group">
                <label className="label">Aspect Ratio</label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                  {aspectRatioOptions.map((ratio) => (
                    <button
                      key={ratio}
                      type="button"
                      className={`btn ${aspectRatio === ratio ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => setAspectRatio(ratio)}
                      style={{ padding: '8px' }}
                    >
                      {ratio} {ratio === '9:16' ? '(Portrait)' : '(Landscape)'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Duration Slider (5-8s) */}
              <div className="form-group">
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <label className="label" style={{ marginBottom: 0 }}>Scene Duration</label>
                  <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--color-accent)' }}>
                    {duration} seconds
                  </span>
                </div>
                <input
                  type="range"
                  min={Math.min(...durationOptions)}
                  max={Math.max(...durationOptions)}
                  step="1"
                  value={duration}
                  onChange={(e) => handleDurationChange(parseInt(e.target.value, 10))}
                  style={{ width: '100%', cursor: 'pointer' }}
                  aria-label="Scene duration in seconds"
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                  {durationOptions.map((d) => (
                    <span key={d}>{d}s</span>
                  ))}
                </div>
              </div>

              {/* Resolution & Accent */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div className="form-group">
                  <label className="label">Resolution</label>
                  <select
                    className="select"
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value)}
                  >
                    {resolutionOptions.map((r) => (
                      <option key={r} value={r}>{r === '1080p' ? '1080p (upscaled)' : r}</option>
                    ))}
                  </select>
                  <p className="field-hint">720p is the model's own size. 1080p is upscaled from it and costs more per second.</p>
                </div>

                <div className="form-group">
                  <label className="label" htmlFor="create-accent">Speaker Accent</label>
                  <select
                    id="create-accent"
                    className="select"
                    value={accent}
                    onChange={(e) => setAccent(e.target.value)}
                  >
                    {/* Older projects may have an accent that is no longer in the list; keep it selectable. */}
                    {accent && !ACCENTS.some((a) => a.value === accent) && (
                      <option value={accent}>{accent}</option>
                    )}
                    {ACCENTS.map((acc) => (
                      <option key={acc.value || 'none'} value={acc.value}>
                        {acc.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Models (the lists come from the backend) */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="label" htmlFor="create-script-model">Script Model</label>
                  <select
                    id="create-script-model"
                    className="select"
                    value={scriptModelId}
                    onChange={(e) => setScriptModel(e.target.value)}
                    disabled={!scriptModels.length}
                  >
                    {!scriptModels.length && <option value={scriptModelId}>Loading…</option>}
                    {scriptModels.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                  {scriptModels.find((m) => m.id === scriptModelId)?.description && (
                    <p className="field-hint">{scriptModels.find((m) => m.id === scriptModelId).description}</p>
                  )}
                </div>

                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="label" htmlFor="create-video-model">Video Model</label>
                  <select
                    id="create-video-model"
                    className="select"
                    value={videoModelId}
                    onChange={(e) => handleVideoModelChange(e.target.value)}
                    disabled={!videoModels.length}
                  >
                    {!videoModels.length && <option value={videoModelId}>Loading…</option>}
                    {videoModels.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                  {selectedVideoModel?.description && (
                    <p className="field-hint">{selectedVideoModel.description}</p>
                  )}
                </div>
              </div>
              {modelsError && (
                <p className="field-hint" role="alert" style={{ color: 'var(--color-error)', marginTop: '-8px', marginBottom: '16px' }}>
                  {modelsError} The default models will be used.
                </p>
              )}

              <section className="guidelines-section" aria-labelledby="guidelines-heading">
                <div className="guidelines-head">
                  <h4 id="guidelines-heading" className="guidelines-title">Style Guidelines</h4>
                  {hasAnyGuideline && (
                    <button type="button" className="link-button" onClick={clearGuidelines}>
                      Clear all
                    </button>
                  )}
                </div>
                <p className="field-hint" style={{ marginTop: 0, marginBottom: '12px' }}>
                  Only what you add here is used. They guide the script and are added to every scene's video prompt.
                </p>

                <div className="preset-label" id="preset-label">Start from a look</div>
                <div className="preset-grid" role="group" aria-labelledby="preset-label">
                  {GUIDELINE_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className={`preset-card ${activePresetId === preset.id ? 'is-active' : ''}`}
                      aria-pressed={activePresetId === preset.id}
                      onClick={() => applyPreset(preset)}
                      title={preset.description}
                    >
                      <span className="preset-name">{preset.label}</span>
                      <span className="preset-desc">{preset.description}</span>
                    </button>
                  ))}
                </div>

                {GUIDELINE_CATEGORIES.map((category) => {
                  const [tags, setTags] = guidelineState[category.key];
                  return (
                    <div key={category.key}>
                      <TagInput
                        label={category.label}
                        hint={category.hint}
                        tags={tags}
                        suggestions={GUIDELINE_SUGGESTIONS[category.key]}
                        onChange={setTags}
                        maxTags={10}
                      />
                      {category.key === 'audio' && (
                        <div className="form-group scene-audio-group">
                          <span className="label" id="scene-audio-label">Scene audio</span>
                          <fieldset className="start-picker" aria-labelledby="scene-audio-label">
                            {SCENE_AUDIO_OPTIONS.map((option) => (
                              <label key={option.value} className="start-option" htmlFor={`scene-audio-${option.value}`}>
                                <input
                                  type="radio"
                                  id={`scene-audio-${option.value}`}
                                  name="scene-audio"
                                  value={option.value}
                                  checked={sceneAudio === option.value}
                                  onChange={() => setSceneAudio(option.value)}
                                />
                                <span className="start-option-title">{option.title}</span>
                                <span className="start-option-sub">{option.sub}</span>
                              </label>
                            ))}
                          </fieldset>
                        </div>
                      )}
                    </div>
                  );
                })}
              </section>
            </div>
          </div>
        </form>
      </div>
    </Layout>
  );
}

export default function CreatePage() {
  const { id } = useParams();
  // A fresh instance per project, so one project's form is never autosaved into another.
  return <CreateIdea key={id} projectId={id} />;
}
