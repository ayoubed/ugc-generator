import React, { useState, useEffect, useRef } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import Stepper from '../components/Stepper';
import ImageUpload from '../components/ImageUpload';
import ReferenceImageUploader from '../components/ReferenceImageUploader';
import TagInput from '../components/TagInput';
import LoadingSpinner from '../components/LoadingSpinner';
import AssetBibleCard from '../components/AssetBibleCard';
import ReferenceVideoCard from '../components/ReferenceVideoCard';
import { useAuth } from '../hooks/useAuth';
import { useProject, useScenes, updateProject, saveProjectWithSettings } from '../hooks/useProject';
import SaveIndicator from '../components/SaveIndicator';
import { useModels, resolveVideoModel, modelPictureLimit } from '../hooks/useModels';
import { extractAssets, generateScenes, resolveStorageUrl } from '../services/api';
import { storage } from '../services/firebase';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { isSceneBusy, maxReachableStep, sceneHasVideo, stepPath } from '../utils/projectProgress';
import {
  assetBibleFilledCount,
  detailsSource,
  normalizeAssetBible,
  sameAssetBible,
  shouldWriteDetails,
} from '../utils/assetBible';
import {
  MAX_STRUCTURE_SCENES,
  breakdownParts,
  formSettingsFromBreakdown,
  structureForScript,
} from '../utils/referenceVideo';

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

// Same width as the two-column layout in index.css (.idea-columns).
const DESKTOP_QUERY = '(min-width: 1100px)';

function CreateIdea({ projectId: id }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { project, loading: projectLoading } = useProject(id);
  const { scenes } = useScenes(id);

  // Main Form State
  const [idea, setIdea] = useState('');
  // The product's real name: without it the script may not name the product at all.
  const [productName, setProductName] = useState('');
  const [numScenes, setNumScenes] = useState(3);
  const [hookStyle, setHookStyle] = useState(HOOK_STYLES[0]);
  const [customHookDesc, setCustomHookDesc] = useState('');
  const [wordsPerScene, setWordsPerScene] = useState(20);
  const [wordsCustomized, setWordsCustomized] = useState(false);

  // Fixed details reused in every scene (see utils/assetBible.js)
  const [assetBible, setAssetBible] = useState(() => normalizeAssetBible(null));
  // What the app wrote the details from (see detailsSource), or '' once the user edited them.
  const [detailsFrom, setDetailsFrom] = useState('');

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

  // Reference video (see ReferenceVideoCard). The card reports every edit of the breakdown here, so
  // the script is written from the latest text even before it is saved.
  const editedBreakdownRef = useRef(undefined);
  const savedReference = project?.settings?.reference || null;
  const currentBreakdown = () => (
    editedBreakdownRef.current !== undefined ? editedBreakdownRef.current : savedReference?.breakdown
  ) || null;
  const followsReference = Boolean(savedReference?.use && breakdownParts(savedReference?.breakdown).length);

  const handleBreakdownChange = (breakdown) => {
    // null = the video was removed or replaced: go back to what is saved.
    editedBreakdownRef.current = breakdown || undefined;
    if (followsReference && breakdownParts(breakdown).length) {
      setNumScenes(Math.min(MAX_STRUCTURE_SCENES, breakdownParts(breakdown).length));
    }
  };

  /** Fills in the form from the reference video's breakdown. */
  const applyReference = () => {
    const filled = formSettingsFromBreakdown(currentBreakdown(), { durationOptions, currentDuration: duration });
    if (!filled) return;
    setNumScenes(filled.numScenes);
    if (filled.hook) {
      setHookStyle('Custom Hook');
      setCustomHookDesc(filled.hook);
    }
    setDuration(filled.duration);
    setWordsPerScene(filled.wordsPerScene);
    setWordsCustomized(true);
    Object.entries(filled.tags).forEach(([key, tags]) => guidelineState[key][1](tags));
  };

  // Execution state
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState('');
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
          if (s.productName) setProductName(s.productName);
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
          if (typeof s.assetBibleFrom === 'string') setDetailsFrom(s.assetBibleFrom);
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
      setError('The photo could not be uploaded. Check your connection and try again.');
    } finally {
      setUploadingImage(false);
    }
  };

  const buildSettings = (overrides = {}) => ({
    productName: productName.trim(),
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
    assetBibleFrom: detailsFrom,
    ...overrides,
  });

  const saveCurrentSettings = async (finalImageRef = startingImageRef, overrides = {}) => {
    const settingsData = buildSettings(overrides);
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
      setError('Write your video idea first.');
      return;
    }

    if (!startingImageRef && !selectedFile) {
      setError('Add a photo of the person who speaks.');
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
          // Saved now: the consistent details below are written from this photo.
          await updateProject(id, { startingImageRef: finalImageRef });
        } finally {
          setUploadingImage(false);
        }
      }

      // Consistent details left empty are written from the idea first, so every scene describes
      // the person and product the same way. They can be edited on the Script step.
      let details = assetBible;
      let writtenFrom = detailsFrom;
      const source = detailsSource({ idea, productName, startingImageRef: finalImageRef, globalImages: project?.globalImages });
      if (shouldWriteDetails(assetBible, detailsFrom, source)) {
        setProgress('Writing the consistent details…');
        try {
          details = normalizeAssetBible(await extractAssets(idea.trim(), scriptModelId, id, productName));
          setAssetBible(details);
          writtenFrom = source;
          setDetailsFrom(source);
        } catch (err) {
          console.warn('Could not write the consistent details; continuing without them:', err);
        }
      }

      // Persist latest project settings to Firestore
      await saveCurrentSettings(finalImageRef, { assetBible: details, assetBibleFrom: writtenFrom });
      setProgress('Writing the script…');

      // Call Backend API to generate scenes
      // Field names must match GenerateScenesRequest in backend/app/models.py: unknown fields
      // are dropped silently, which used to swap the user's guidelines for built-in defaults.
      // The server writes the script and saves the scenes (the page gets them through its live listener).
      await generateScenes(id, {
        idea: idea.trim(),
        product_name: productName.trim() || null,
        num_scenes: numScenes,
        target_words_per_scene: wordsPerScene,
        hook_style: hookStyle,
        custom_hook_desc: hookStyle === 'Custom Hook' ? customHookDesc : '',
        llm_model: scriptModelId,
        asset_bible: details,
        guidelines: {
          camera_specifics: cameraTags,
          lighting_restraints: lightingTags,
          relatable_action: actionTags,
          script_tone: scriptToneTags,
          visual_consistency: visualTags,
          audio_consistency: audioTags,
          accent,
        },
        structure: followsReference ? structureForScript(currentBreakdown()) : null,
      });

      // Navigate to Step 2: Edit Scenes
      navigate(`/project/${id}/scenes`);
    } catch (err) {
      console.error('Error generating scenes:', err);
      setError(err.message || 'Failed to generate scenes. Please try again.');
    } finally {
      setGenerating(false);
      setProgress('');
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

  const totalSeconds = numScenes * duration;
  const hookSummary = hookStyle.startsWith('Auto') ? 'Hook chosen for you' : hookStyle === 'Custom Hook' ? 'Your own hook' : hookStyle.replace(/\s*\(.*\)$/, '');
  const guidelineCount = Object.values(guidelineState).reduce((sum, [tags]) => sum + tags.length, 0);
  const detailsFilled = assetBibleFilledCount(assetBible);
  const hasScript = Boolean(project && project.status && project.status !== 'draft');
  // What the form holds from the reference video, shown on its card (the options may be folded).
  const filledFromReference = [
    `${numScenes} ${numScenes === 1 ? 'scene' : 'scenes'}`,
    `${duration} seconds each`,
    `${wordsPerScene} words per scene`,
    hookStyle === 'Custom Hook' && customHookDesc.trim() ? 'Its kind of hook' : '',
    guidelineCount ? `${guidelineCount} style ${guidelineCount === 1 ? 'detail' : 'details'}` : '',
  ].filter(Boolean);
  const busy = generating || uploadingImage;

  return (
    <Layout>
      <div className="container idea-page">
        <Stepper
          currentStep={1}
          maxReachableStep={maxReachableStep(project, scenes)}
          onStepClick={busy || leaving ? undefined : handleStepClick}
        />

        <header className="page-head">
          <div className="page-head-text">
            <h1 className="page-title">What&apos;s the video?</h1>
            <p className="page-subtitle" style={{ color: 'var(--text-secondary)' }}>
              Describe it and add the person and the product. Everything else has a sensible default you can change below.
            </p>
          </div>
          <SaveIndicator state={saveState} onRetry={saveNow} />
        </header>

        {error && <p className="page-alert" role="alert">{error}</p>}

        <form className="idea-form" onSubmit={handleGenerateScenes}>
          <ReferenceVideoCard
            project={project}
            storagePrefix={user ? `users/${user.uid}/projects/${id}` : ''}
            onApply={applyReference}
            onBreakdownChange={handleBreakdownChange}
            filled={followsReference ? filledFromReference : []}
            disabled={generating}
          />

          <div className="idea-columns">
          <div className="idea-main">
          <section className="card card-white" aria-labelledby="idea-heading">
            <div className="form-group">
              <label className="label idea-label" id="idea-heading" htmlFor="idea-text">Your idea</label>
              <textarea
                id="idea-text"
                className="textarea"
                rows={4}
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                placeholder="e.g. A student shows the app she uses to buy lecture notes from people who already took the class, filmed selfie-style in her room."
                required
              />
              {followsReference && savedReference?.breakdown?.summary && (
                <p className="field-hint">
                  The reference: {savedReference.breakdown.summary} Describe your own product the same way.
                </p>
              )}
            </div>

            <div className="form-group">
              <label className="label" htmlFor="idea-product-name">Product or brand name</label>
              <input
                id="idea-product-name"
                type="text"
                className="input"
                maxLength={120}
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                placeholder="e.g. Luma One"
                autoComplete="off"
              />
              <p className="field-hint">
                Said exactly as you write it. Left empty, the script never names the product, so no name is made up.
              </p>
            </div>

            <div className="idea-pictures">
              <div>
                <ImageUpload
                  label="The person"
                  description="A photo of whoever speaks. The first scene starts from it."
                  previewUrl={imagePreviewUrl}
                  onUpload={handleImageFileSelect}
                  onRemove={() => {
                    setSelectedFile(null);
                    setStartingImageRef('');
                    setImagePreviewUrl('');
                  }}
                />
                {uploadingImage && <LoadingSpinner size="sm" label="Uploading the photo…" />}
              </div>
              <ReferenceImageUploader
                label="The product and anything else to show"
                hint="Optional. Say what each picture is, e.g. “The product: a matte black water bottle”."
                images={project?.globalImages || []}
                maxImages={pictureLimit}
                storagePrefix={user ? `users/${user.uid}/projects/${id}/context` : ''}
                onChange={(next) => updateProject(id, { globalImages: next })}
                budgetNote={`Used in every scene. Each scene can use ${pictureLimit} pictures in total, so leave room if you plan to add scene-specific ones on the Script step.`}
              />
            </div>
          </section>

          <section className="card card-white" aria-labelledby="format-heading">
            <h2 className="idea-heading" id="format-heading">Format and look</h2>
            <div className="idea-format">
              <div className="form-group">
                <span className="label" id="aspect-label">Shape</span>
                <div className="music-segmented" role="group" aria-labelledby="aspect-label">
                  {aspectRatioOptions.map((ratio) => (
                    <button
                      key={ratio}
                      type="button"
                      className={`music-seg ${aspectRatio === ratio ? 'is-active' : ''}`}
                      aria-pressed={aspectRatio === ratio}
                      onClick={() => setAspectRatio(ratio)}
                    >
                      {ratio === '9:16' ? 'Vertical' : ratio === '16:9' ? 'Wide' : ratio}
                    </button>
                  ))}
                </div>
              </div>

              <div className="form-group">
                <label className="label" htmlFor="idea-scenes">Scenes</label>
                <input
                  id="idea-scenes"
                  type="number"
                  className="input"
                  min={1}
                  max={10}
                  value={numScenes}
                  disabled={followsReference}
                  onChange={(e) => setNumScenes(Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 1)))}
                />
              </div>

              <div className="form-group">
                <span className="label" id="duration-label">Seconds per scene</span>
                <div className="music-segmented" role="group" aria-labelledby="duration-label">
                  {durationOptions.map((d) => (
                    <button
                      key={d}
                      type="button"
                      className={`music-seg ${duration === d ? 'is-active' : ''}`}
                      aria-pressed={duration === d}
                      onClick={() => handleDurationChange(d)}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <p className="field-hint">
              About {totalSeconds} seconds in total.
              {followsReference ? ' One scene per part of the reference video.' : ''}
            </p>

            <div className="guidelines-head" style={{ marginTop: '18px' }}>
              <span className="label" id="preset-label" style={{ marginBottom: 0 }}>Look</span>
              {hasAnyGuideline && (
                <button type="button" className="link-button" onClick={clearGuidelines}>Clear</button>
              )}
            </div>
            <div className="preset-grid is-wide" role="group" aria-labelledby="preset-label">
              {GUIDELINE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`preset-card ${activePresetId === preset.id ? 'is-active' : ''}`}
                  aria-pressed={activePresetId === preset.id}
                  onClick={() => applyPreset(preset)}
                >
                  <span className="preset-name">{preset.label}</span>
                  <span className="preset-desc">{preset.description}</span>
                </button>
              ))}
            </div>
            <p className="field-hint">
              {activePresetId
                ? 'Fine-tune it under “Style details” below.'
                : hasAnyGuideline
                  ? 'Using your own style details (see below).'
                  : 'Optional. Without one, the look comes from your idea and pictures alone.'}
            </p>
          </section>

          </div>

          <aside className="idea-side" aria-label="Options">
          <Disclosure
            title="Consistent details"
            note={!detailsFilled ? 'Written for you with the script' : detailsFrom ? 'Written from your pictures' : `${detailsFilled} of 4 filled in`}
          >
            <AssetBibleCard
              embedded
              value={assetBible}
              onChange={(next, info) => {
                setAssetBible(next);
                // Typed details are the user's from then on; ones the app just wrote can be refreshed.
                setDetailsFrom(info?.written
                  ? detailsSource({ idea, productName, startingImageRef, globalImages: project?.globalImages })
                  : '');
              }}
              idea={idea}
              projectId={id}
              productName={productName}
              scriptModel={scriptModelId}
              disabled={generating}
            />
          </Disclosure>

          <Disclosure openOnDesktop title="Script options" note={`${hookSummary} · ${wordsPerScene} words per scene`}>
            <div className="field-grid">
              <div className="form-group">
                <label className="label" htmlFor="idea-hook">Hook</label>
                <select id="idea-hook" className="select" value={hookStyle} onChange={(e) => setHookStyle(e.target.value)}>
                  {HOOK_STYLES.map((style) => (
                    <option key={style} value={style}>{style}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label className="label" htmlFor="idea-words">Words per scene</label>
                <input
                  id="idea-words"
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
                <p className="field-hint">About {Math.round(duration * 2.5)} words fit in {duration} seconds.</p>
              </div>
            </div>
            {hookStyle === 'Custom Hook' && (
              <div className="form-group">
                <label className="label" htmlFor="idea-custom-hook">Your hook</label>
                <textarea
                  id="idea-custom-hook"
                  className="textarea"
                  rows={2}
                  value={customHookDesc}
                  onChange={(e) => setCustomHookDesc(e.target.value)}
                  placeholder="e.g. Start by whispering a secret straight into the phone microphone."
                />
              </div>
            )}
            <div className="form-group">
              <label className="label" htmlFor="create-accent">Speaker accent</label>
              <select id="create-accent" className="select" value={accent} onChange={(e) => setAccent(e.target.value)}>
                {/* Older projects may have an accent that is no longer in the list; keep it selectable. */}
                {accent && !ACCENTS.some((a) => a.value === accent) && <option value={accent}>{accent}</option>}
                {ACCENTS.map((acc) => (
                  <option key={acc.value || 'none'} value={acc.value}>{acc.label}</option>
                ))}
              </select>
            </div>
          </Disclosure>

          <Disclosure
            title="Style details"
            note={guidelineCount ? `${guidelineCount} ${guidelineCount === 1 ? 'guideline' : 'guidelines'}` : 'None'}
          >
            <p className="field-hint" style={{ marginTop: 0, marginBottom: '12px' }}>
              Only what you add here is used. They guide the script and are added to every scene&apos;s video prompt.
            </p>
            {GUIDELINE_CATEGORIES.map((category) => {
              const [tags, setTags] = guidelineState[category.key];
              return (
                <TagInput
                  key={category.key}
                  label={category.label}
                  hint={category.hint}
                  tags={tags}
                  suggestions={GUIDELINE_SUGGESTIONS[category.key]}
                  onChange={setTags}
                  maxTags={10}
                />
              );
            })}
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
          </Disclosure>

          <Disclosure title="Models and quality" note={`${resolution} · ${selectedVideoModel?.label || 'Default model'}`}>
            <div className="field-grid">
              <div className="form-group">
                <label className="label" htmlFor="idea-resolution">Resolution</label>
                <select id="idea-resolution" className="select" value={resolution} onChange={(e) => setResolution(e.target.value)}>
                  {resolutionOptions.map((r) => (
                    <option key={r} value={r}>{r === '1080p' ? '1080p (upscaled)' : r}</option>
                  ))}
                </select>
                <p className="field-hint">720p is the model&apos;s own size. 1080p is upscaled from it and costs more per second.</p>
              </div>
              <div className="form-group">
                <label className="label" htmlFor="create-video-model">Video model</label>
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
                {selectedVideoModel?.description && <p className="field-hint">{selectedVideoModel.description}</p>}
              </div>
              <div className="form-group">
                <label className="label" htmlFor="create-script-model">Script model</label>
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
            </div>
            {modelsError && (
              <p className="field-hint" role="alert" style={{ color: 'var(--color-error)' }}>
                {modelsError} The default models will be used.
              </p>
            )}
          </Disclosure>
          </aside>
          </div>

          {confirmingRegenerate && (
            <div className="gen-note is-warning" role="alertdialog" aria-labelledby="regen-title" style={{ padding: '14px 16px' }}>
              <p id="regen-title" style={{ fontWeight: 600, marginBottom: '6px' }}>Replace the current script?</p>
              <p style={{ marginBottom: '12px' }}>
                The text of all {scenes.length} {scenes.length === 1 ? 'scene' : 'scenes'} is rewritten, including your edits.
                {numScenes < scenes.length ? ` Scenes ${numScenes + 1} and up are deleted with their videos.` : ''}
                {scenesWithVideo > 0 ? ' Videos of the scenes that stay are kept, but they will no longer match the new script.' : ''}
              </p>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button type="submit" id="create-regenerate-confirm" className="btn btn-primary btn-sm" disabled={generating}>
                  Replace the script
                </button>
                <button type="button" id="create-regenerate-cancel" className="btn btn-ghost btn-sm" onClick={() => setConfirmingRegenerate(false)}>
                  Keep the current script
                </button>
              </div>
            </div>
          )}

          <div className="gen-footer" role="region" aria-label="Write the script">
            {hasScript ? (
              <button type="button" className="btn btn-secondary" onClick={handleSaveAndContinue} disabled={busy}>
                Keep the script →
              </button>
            ) : <span />}
            <div className="gen-footer-end">
              <div className="gen-footer-status">
                <span className="gen-footer-count">{numScenes} {numScenes === 1 ? 'scene' : 'scenes'} · about {totalSeconds}s</span>
                <p className="gen-footer-note">{generating ? progress || 'Working…' : 'Writing takes up to a minute. No video is made yet.'}</p>
              </div>
              <button type="submit" id="create-write-script" className="btn btn-primary" disabled={busy}>
                {generating ? <LoadingSpinner size="sm" label="Writing…" /> : hasScript ? 'Write a new script' : 'Write the script →'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </Layout>
  );
}

/** A section that stays folded until asked for, with a one-line summary of what is inside. */
function Disclosure({ title, note, openOnDesktop = false, children }) {
  // Read once: resizing the window afterwards never folds a section someone is working in.
  const [startsOpen] = useState(() => openOnDesktop && Boolean(window.matchMedia?.(DESKTOP_QUERY).matches));
  return (
    <details className="card card-white disclosure" open={startsOpen || undefined}>
      <summary>
        <span className="disclosure-title">{title}</span>
        {note && <span className="disclosure-note">{note}</span>}
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

export default function CreatePage() {
  const { id } = useParams();
  // A fresh instance per project, so one project's form is never autosaved into another.
  return <CreateIdea key={id} projectId={id} />;
}
