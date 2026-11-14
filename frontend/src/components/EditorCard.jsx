import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { deleteField } from 'firebase/firestore';
import LoadingSpinner from './LoadingSpinner';
import { updateProjectSettings } from '../hooks/useProject';
import { useVoices } from '../hooks/useVoices';
import { exportPackage, makeSound, previewVoice } from '../services/api';
import { friendlyError } from '../utils/errors';
import {
  MAX_SCENE_VOLUME, changeEdit, editSummary, keptRange, musicVolumePercent, previewGain, previewMusicGain, sceneEdit,
} from '../utils/edits';
import { END_CARD_SECONDS, hasOwnCaptionText, projectCaptionStyle, projectEndCard, projectMusic, projectVoice, sceneCaptionText, toMillis } from '../utils/projectProgress';
import {
  MAX_SOUNDS, SOUND_DEFAULT_VOLUME, SOUND_IDEAS, previewSoundGain, projectSounds, soundPlace, soundTime,
} from '../utils/sounds';
import { revoicedUrl, voicePreviewState } from '../utils/voicePreview';
import { autoCut, buildTimeline, clock, fitScale, locate, rulerMarks, timelineTime, zoomScale } from '../utils/timeline';

const SAVE_DELAY_MS = 500;

/**
 * Video step: the editor. A timeline with one track each for the picture, the scenes' voices,
 * the captions, the sound effects and the music, a playhead, and a preview that plays the cut as
 * edited (with the music and the sound effects) without stitching.
 *
 * "Add sound" makes a sound effect from a description and puts it at the playhead; it is then
 * moved by dragging it along its track, and its volume is set in the panel.
 *
 * A clip on the picture track is trimmed by dragging its edges, or with the Start and End fields
 * of the panel that opens when it is selected (the same thing, for the keyboard). The panel also
 * holds the scene's voice volume and mute; selecting the music bar shows its volume.
 *
 * A caption block opens that scene's caption text, and the end card block its length; a second
 * line and length. The chosen voice is applied by the stitch, so the preview has each scene's own
 * voice. "Export for another editor" builds a package other editors can open.
 *
 * @param {object}  project
 * @param {Array}   scenes   [{ scene, label }] in video order, skipped scenes left out
 * @param {number}  fallbackSeconds  scene length to assume until a clip's real length is known
 * @param {boolean} disabled
 * @param {object}  captions  optional: { textOf(scene), isOwn(scene), change(id, text), commit(id), reset(id) }
 *                            when the page keeps the caption texts itself; otherwise they are saved here
 * Sound effects are offered when the voice service is set up (the same service makes them).
 */
const STALE_PACKAGE_MS = 10 * 60 * 1000; // same limit the API uses
const VOICE_DRIFT_SECONDS = 0.25;         // more than this between lips and voice is noticeable
const RESYNC_PAUSE_MS = 2000;
const PLAYHEAD_REDRAW_MS = 80;
const SOUND_LENGTHS = [1, 2, 3, 5];       // seconds offered for a new sound, besides "automatic"
const MIN_SOUND_WIDTH = 30;               // pixels: a very short sound can still be grabbed

export default function EditorCard({ project, scenes, fallbackSeconds = 8, disabled = false, captions = null }) {
  const baseId = useId();
  // One player per scene, all loaded up front and stacked; only the current one is shown. Loading
  // a scene's file when its turn came left the preview blank between scenes.
  const videos = useRef({});
  // The scenes' speech in the voice chosen for the whole video, when it has been prepared: played
  // in place of the scene's own sound, so the choice is heard before stitching.
  const dubs = useRef({});
  const askedVoice = useRef('');
  const lastResync = useRef(0);
  const lastDraw = useRef(0);
  const askedExport = useRef(false);
  const audio = useRef(null);
  const scroller = useRef(null);
  const drag = useRef(null);
  const timers = useRef({});
  const pending = useRef({});
  const [durations, setDurations] = useState({});
  const [drafts, setDrafts] = useState({});      // edits changed here and not yet back from the server
  const [musicDraft, setMusicDraft] = useState(null);
  const [captionDrafts, setCaptionDrafts] = useState({});
  const [cardDraft, setCardDraft] = useState({});
  const [exporting, setExporting] = useState(false);
  // Sound effects: one player each, which of them already started in this run of the preview,
  // and the ones changed here and not yet back from the server (null = removed).
  const soundPlayers = useRef({});
  const started = useRef(new Set());
  const soundDrag = useRef(null);
  const [soundDrafts, setSoundDrafts] = useState({});
  const [soundPrompt, setSoundPrompt] = useState('');
  const [soundSeconds, setSoundSeconds] = useState(0);   // 0 = the service picks the length
  const [makingSound, setMakingSound] = useState(false);
  const { available: soundsOffered } = useVoices();
  const scrubbing = useRef(false);
  const canvas = useRef(null);
  const [selected, setSelected] = useState(null); // { type: 'clip' | 'caption', id } | { type: 'music' | 'card' } | null
  const [time, setTime] = useState(0);            // the playhead, in seconds of the timeline
  const [playing, setPlaying] = useState(false);
  const [scale, setScale] = useState(null);       // pixels per second chosen with the zoom; null = fit the width
  const [viewWidth, setViewWidth] = useState(0);  // width of the visible part of the timeline
  const [error, setError] = useState('');

  const ready = useMemo(() => scenes.filter(({ scene }) => scene.videoUrl), [scenes]);
  const music = projectMusic(project);
  const endCard = projectEndCard(project);
  const captionStyle = projectCaptionStyle(project);
  const musicPercent = musicDraft ?? musicVolumePercent(music?.volume);

  const editOf = (scene) => (scene.id in drafts ? drafts[scene.id] : sceneEdit(project, scene));
  const lengthOf = (scene) => durations[scene.id] || fallbackSeconds;
  const rangeOf = (scene) => keptRange(editOf(scene), lengthOf(scene), autoCut(project, scene));

  const timeline = buildTimeline(
    ready.map(({ scene, label }) => ({ id: scene.id, scene, label, ...rangeOf(scene) })),
    endCard.enabled && endCard.imageRef ? endCard.seconds : 0,
  );
  const pps = scale || fitScale(viewWidth, timeline.total);
  const place = locate(timeline, time);
  const current = place ? timeline.clips[place.index] : null;

  // The sounds as they are now, each with where it starts on the timeline (null = not heard).
  const savedSounds = projectSounds(project);
  const sounds = [
    ...savedSounds.filter((sound) => !(sound.id in soundDrafts)),
    ...Object.values(soundDrafts).filter(Boolean),
  ].sort((a, b) => a.id.localeCompare(b.id)).map((sound) => ({ ...sound, time: soundTime(timeline, sound) }));
  const heardSounds = sounds.filter((sound) => sound.time !== null);
  const lostSounds = sounds.filter((sound) => sound.time === null);

  // The timeline fits the card's width until the zoom is used, also after the window is resized.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return undefined;
    const measure = () => setViewWidth(element.clientWidth || 0);
    measure();
    if (!window.ResizeObserver) return undefined;
    const observer = new window.ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ready.length]);

  // ── Saving ──────────────────────────────────────────────────────────────────────────────────
  // Fields saved in the same write as a pending key (a caption text goes with the script it replaces).
  const alongside = useRef({});
  const flush = (key) => {
    clearTimeout(timers.current[key]);
    if (!(key in pending.current)) return;
    const value = pending.current[key];
    delete pending.current[key];
    const more = alongside.current[key];
    delete alongside.current[key];
    updateProjectSettings(project.id, { [key]: value, ...more }).catch((err) => {
      console.error('Could not save the edit:', err);
      setError(friendlyError(err));
    });
  };
  const saveSoon = (key, value) => {
    setError('');
    pending.current[key] = value;
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(() => flush(key), SAVE_DELAY_MS);
  };
  // Leaving the page saves what the timers had not saved yet.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => Object.keys(pending.current).forEach(flush), []);

  const change = (scene, field, value) => {
    const next = changeEdit(editOf(scene), field, value, lengthOf(scene), scene.activeAttempt, autoCut(project, scene));
    setDrafts((prev) => ({ ...prev, [scene.id]: next }));
    saveSoon(`edits.${scene.id}`, next);
  };
  const reset = (scene) => {
    setDrafts((prev) => ({ ...prev, [scene.id]: null }));
    pending.current[`edits.${scene.id}`] = null;
    flush(`edits.${scene.id}`);
  };
  const changeMusicVolume = (percent) => {
    setMusicDraft(percent);
    saveSoon('music.volume', percent);
  };

  // ── Sound effects ───────────────────────────────────────────────────────────────────────────
  const stored = ({ time: _time, ...sound }) => sound;
  const changeSound = (sound, changes, { later = true } = {}) => {
    const next = { ...stored(sound), ...changes };
    setSoundDrafts((prev) => ({ ...prev, [sound.id]: next }));
    if (later) saveSoon(`sounds.${sound.id}`, next);
    else {
      pending.current[`sounds.${sound.id}`] = next;
      flush(`sounds.${sound.id}`);
    }
  };
  const moveSound = (sound, seconds, options) => {
    const spot = soundPlace(timeline, seconds);
    if (spot) changeSound(sound, spot, options);
  };
  const removeSound = (sound) => {
    soundPlayers.current[sound.id]?.pause?.();
    setSoundDrafts((prev) => ({ ...prev, [sound.id]: null }));
    pending.current[`sounds.${sound.id}`] = deleteField();
    flush(`sounds.${sound.id}`);
    setSelected(null);
  };
  const hearSound = (sound) => {
    const element = soundPlayers.current[sound.id];
    if (!element) return;
    element.volume = previewSoundGain(sound.volume);
    element.currentTime = 0;
    element.play?.()?.catch?.(() => {});
  };
  const handleMakeSound = async () => {
    const prompt = soundPrompt.trim();
    if (prompt.length < 2 || makingSound) return;
    setError('');
    setMakingSound(true);
    try {
      const made = await makeSound(project.id, { prompt, seconds: soundSeconds || null });
      const spot = soundPlace(timeline, time);
      if (!spot) return;
      changeSound({ ...made, volume: SOUND_DEFAULT_VOLUME }, spot, { later: false });
      setSelected({ type: 'sound', id: made.id });
      setSoundPrompt('');
    } catch (err) {
      console.error('Could not make the sound:', err);
      setError(friendlyError(err));
    } finally {
      setMakingSound(false);
    }
  };
  // Dragging a sound along its track moves it; it is saved when the pointer is let go.
  const startSoundDrag = (event, sound) => {
    if (disabled) return;
    soundDrag.current = { id: sound.id, x: event.clientX, time: sound.time, moved: false };
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // without capture the drag still works while the pointer is over the sound
    }
    setSelected({ type: 'sound', id: sound.id });
  };
  const moveSoundDrag = (event, sound) => {
    const held = soundDrag.current;
    if (!held || held.id !== sound.id || !Number.isFinite(event.clientX)) return;
    const shift = (event.clientX - held.x) / pps;
    if (!held.moved && Math.abs(event.clientX - held.x) < 3) return;   // a click, not a drag
    held.moved = true;
    const spot = soundPlace(timeline, held.time + shift);
    if (spot) setSoundDrafts((prev) => ({ ...prev, [sound.id]: { ...stored(sound), ...spot } }));
  };
  const endSoundDrag = (sound) => {
    const held = soundDrag.current;
    soundDrag.current = null;
    if (held?.moved && held.id === sound.id) {
      pending.current[`sounds.${sound.id}`] = stored(sound);
      flush(`sounds.${sound.id}`);
    }
  };

  // Caption texts: kept by the page when it passes `captions`, otherwise saved from here.
  const captionOf = (scene) => (captions ? captions.textOf(scene) : captionDrafts[scene.id] ?? sceneCaptionText(project, scene));
  const captionIsOwn = (scene) => (captions ? captions.isOwn(scene) : scene.id in captionDrafts || hasOwnCaptionText(project, scene));
  const changeCaption = (scene, text) => {
    if (captions) return captions.change(scene.id, text);
    setCaptionDrafts((prev) => ({ ...prev, [scene.id]: text }));
    // Kept with the script it replaces, so a later script change brings the caption back to the script.
    alongside.current[`captions.texts.${scene.id}`] = { [`captions.textFor.${scene.id}`]: scene.script || '' };
    return saveSoon(`captions.texts.${scene.id}`, text);
  };
  const resetCaption = (scene) => {
    if (captions) return captions.reset(scene.id);
    setCaptionDrafts((prev) => {
      const next = { ...prev };
      delete next[scene.id];
      return next;
    });
    pending.current[`captions.texts.${scene.id}`] = deleteField();
    alongside.current[`captions.texts.${scene.id}`] = { [`captions.textFor.${scene.id}`]: deleteField() };
    return flush(`captions.texts.${scene.id}`);
  };

  const cardValue = (field) => cardDraft[field] ?? endCard[field];
  const changeCard = (field, value) => {
    setCardDraft((prev) => ({ ...prev, [field]: value }));
    saveSoon(`endCard.${field}`, value);
  };

  // The package for another editor is built on the server; the project says when it is ready.
  const packageBuilding = project?.packageStatus === 'building'
    && Date.now() - (toMillis(project?.packageStartedAt) || Date.now()) < STALE_PACKAGE_MS;
  const handleExport = async () => {
    setError('');
    setExporting(true);
    try {
      // Edits still waiting for their timer go first, so the package has them.
      Object.keys(pending.current).forEach(flush);
      await exportPackage(project.id);
      askedExport.current = true;
    } catch (err) {
      console.error('Could not start the export:', err);
      setError(friendlyError(err));
    } finally {
      setExporting(false);
    }
  };

  // ── Playback ────────────────────────────────────────────────────────────────────────────────
  // The preview shows one scene's file at a time. `seek` says where the player should be; it is
  // applied when the file is ready (a scene change loads another file).
  const seek = useRef({ clipTime: 0, token: 0 });
  const player = () => (current ? videos.current[current.id] || null : null);
  const dub = () => (current && revoicedUrl(project, current.scene) ? dubs.current[current.id] || null : null);
  // How loud the scene on screen is: its own sound, or the chosen voice in its place.
  const applySound = () => {
    const element = player();
    if (!element || !current) return;
    const edit = editOf(current.scene);
    const level = previewGain(edit?.volume); // 100% plays below full, so a boost is heard too
    const voiceOver = dub();
    element.muted = Boolean(edit?.muted) || Boolean(voiceOver);
    element.volume = level;
    if (voiceOver) {
      voiceOver.muted = Boolean(edit?.muted);
      voiceOver.volume = level;
    }
  };
  const applySeek = () => {
    const element = player();
    if (!element || !current) return;
    applySound();
    element.currentTime = seek.current.clipTime;
    if (playing) element.play?.()?.catch?.(() => {});
    const voiceOver = dub();
    if (voiceOver) {
      voiceOver.currentTime = seek.current.clipTime;
      if (playing) voiceOver.play?.()?.catch?.(() => {});
    }
  };
  const quietSounds = () => {
    started.current = new Set();
    Object.values(soundPlayers.current).forEach((element) => element?.pause?.());
  };
  const goTo = (seconds) => {
    const target = Math.max(0, Math.min(seconds, timeline.clipsEnd));
    const spot = locate(timeline, target);
    if (!spot) return;
    quietSounds();
    seek.current = { clipTime: spot.clipTime, token: seek.current.token + 1 };
    setTime(target);
    if (spot.index === place?.index) applySeek();
    const track = audio.current;
    if (track && Number.isFinite(track.duration) && track.duration > 0) track.currentTime = target % track.duration;
  };
  const stop = () => {
    setPlaying(false);
    Object.values(videos.current).forEach((element) => element?.pause?.());
    Object.values(dubs.current).forEach((element) => element?.pause?.());
    audio.current?.pause?.();
    quietSounds();
  };
  const play = () => {
    if (!current) return;
    if (time >= timeline.clipsEnd - 0.05) goTo(0);
    setPlaying(true);
  };
  // Starts or stops the players when "playing" flips, and keeps the music volume current.
  useEffect(() => {
    const track = audio.current;
    if (track) track.volume = previewMusicGain(musicPercent);
    if (!playing) return;
    player()?.play?.()?.catch?.(() => {});
    dub()?.play?.()?.catch?.(() => {});
    track?.play?.()?.catch?.(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, musicPercent]);

  // The scene on screen changed: the others stop, and the new one starts from where the playhead is.
  const currentId = current?.id;
  useEffect(() => {
    Object.entries(videos.current).forEach(([id, element]) => { if (id !== currentId) element?.pause?.(); });
    Object.entries(dubs.current).forEach(([id, element]) => { if (id !== currentId) element?.pause?.(); });
    const element = currentId ? videos.current[currentId] : null;
    if (element && element.readyState >= 1) applySeek();   // not loaded yet: its loadedmetadata does it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  // A volume or mute change is heard at once, also while playing, and so is a voice that just got ready.
  const currentEdit = current ? editOf(current.scene) : null;
  const currentDubUrl = current ? revoicedUrl(project, current.scene) : '';
  useEffect(() => {
    applySound();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, currentEdit?.volume, currentEdit?.muted, currentDubUrl]);

  // The voice chosen for the whole video, prepared so it can be heard here.
  const voice = projectVoice(project);
  const voiceState = voicePreviewState(project, ready.map(({ scene }) => scene));
  const voiceReadyCount = ready.filter(({ scene }) => revoicedUrl(project, scene)).length;
  const voiceLoading = voiceState === 'building' || voiceState === 'missing';
  const askForVoice = async () => {
    setError('');
    try {
      await previewVoice(project.id);
    } catch (err) {
      console.error('Could not prepare the voice:', err);
      setError(friendlyError(err));
    }
  };
  // Asked for once per voice when it is missing (a voice picked earlier, or a new take since).
  useEffect(() => {
    if (voiceState !== 'missing' || !voice || disabled || askedVoice.current === voice.id) return;
    askedVoice.current = voice.id;
    askForVoice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceState, voice?.id, disabled]);

  // The package asked for here downloads by itself once the server has built it.
  const packageReady = project?.packageStatus === 'ready' && project?.packageUrl;
  useEffect(() => {
    if (!askedExport.current || !packageReady) return;
    askedExport.current = false;
    const link = document.createElement('a');
    link.href = project.packageUrl;
    link.download = project.packageName || 'project.zip';
    document.body.appendChild(link);
    link.click();
    link.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packageReady, project?.packageUrl]);

  // Called as the player advances: moves the playhead, and steps to the next scene at the out-point.
  // The scene on screen is over: on to the next one, or stop after the last.
  const stepOver = () => {
    if (!current) return;
    const next = timeline.clips[place.index + 1];
    if (!next) {
      stop();
      setTime(timeline.clipsEnd);
      return;
    }
    seek.current = { clipTime: next.start, token: seek.current.token + 1 };
    setTime(next.at);
  };
  const advance = () => {
    const element = player();
    if (!element || !current) return;
    if (element.currentTime >= current.end - 0.03) {
      stepOver();
      return;
    }
    // The picture and the chosen voice are two players: pull the voice back when it drifts. Every
    // such jump is a small break in the sound, so only for a drift that shows on the lips, and not
    // again until the player has had time to settle (phones need a moment after a seek).
    const voiceOver = dub();
    const nowMs = Date.now();
    if (
      voiceOver && nowMs - lastResync.current > RESYNC_PAUSE_MS
      && Math.abs(voiceOver.currentTime - element.currentTime) > VOICE_DRIFT_SECONDS
    ) {
      lastResync.current = nowMs;
      voiceOver.currentTime = element.currentTime;
    }
    // A sound effect starts when the playhead reaches it (or part-way in, when playing from its middle).
    const now = timelineTime(timeline, place.index, element.currentTime);
    heardSounds.forEach((sound) => {
      if (started.current.has(sound.id) || now < sound.time || now >= sound.time + sound.seconds - 0.05) return;
      started.current.add(sound.id);
      const effect = soundPlayers.current[sound.id];
      if (!effect) return;
      effect.volume = previewSoundGain(sound.volume);
      effect.currentTime = now - sound.time > 0.1 ? now - sound.time : 0;
      effect.play?.()?.catch?.(() => {});
    });
    // The playhead is redrawn about 12 times a second: redrawing the whole editor on every frame
    // made the sound stutter on phones.
    if (nowMs - lastDraw.current < PLAYHEAD_REDRAW_MS) return;
    lastDraw.current = nowMs;
    setTime(now);
  };
  // A smooth playhead while playing (the player itself reports only a few times a second).
  useEffect(() => {
    if (!playing || !window.requestAnimationFrame) return undefined;
    let frame = window.requestAnimationFrame(function loop() {
      advance();
      frame = window.requestAnimationFrame(loop);
    });
    return () => window.cancelAnimationFrame(frame);
  });

  // ── Trimming by dragging a clip's edge ─────────────────────────────────────────────────────────
  const startDrag = (event, clip, side) => {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    drag.current = { id: clip.id, side, x: event.clientX, value: side === 'start' ? clip.start : clip.end };
    try {
      // Keeps the drag going when the pointer leaves the thin handle.
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // No capture (e.g. a pointer the browser no longer tracks): the drag still works over the handle.
    }
    setSelected({ type: 'clip', id: clip.id });
    stop();
    // Fitting the width again while a clip gets shorter would slide its edge away from the pointer,
    // so the zoom stays where it is from the first drag on ("Fit" puts it back).
    if (!scale) setScale(pps);
  };
  const moveDrag = (event, clip) => {
    const held = drag.current;
    if (!held || held.id !== clip.id || !Number.isFinite(event.clientX)) return;
    change(clip.scene, held.side, held.value + (event.clientX - held.x) / pps);
  };
  const endDrag = () => {
    drag.current = null;
  };

  if (!ready.length) return null;

  const width = Math.max(1, timeline.total * pps);
  const chosen = selected?.type === 'clip' ? timeline.clips.find((clip) => clip.id === selected.id) : null;
  const chosenEdit = chosen ? editOf(chosen.scene) : null;
  const chosenAuto = chosen ? autoCut(project, chosen.scene) : null;
  const select = (clip) => {
    setSelected({ type: 'clip', id: clip.id });
    // Also while playing: the scene being adjusted is the one that is heard.
    if (clip.id !== current?.id || !playing) goTo(clip.at);
  };
  // Moving the playhead: press on the ruler (or on the playhead's knob) and drag.
  const scrubTo = (event) => {
    const box = canvas.current?.getBoundingClientRect();
    if (box && Number.isFinite(event.clientX)) goTo((event.clientX - box.left) / pps);
  };
  const startScrub = (event) => {
    event.preventDefault();
    scrubbing.current = true;
    stop();
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // without capture the playhead still follows while the pointer is over the ruler
    }
    scrubTo(event);
  };
  const scrubHandlers = {
    onPointerDown: startScrub,
    onPointerMove: (event) => { if (scrubbing.current) scrubTo(event); },
    onPointerUp: () => { scrubbing.current = false; },
    onPointerCancel: () => { scrubbing.current = false; },
  };
  const captionScene = selected?.type === 'caption' ? ready.find(({ scene }) => scene.id === selected.id) : null;
  const cardOn = endCard.enabled && Boolean(endCard.imageRef);
  const chosenSound = selected?.type === 'sound' ? sounds.find((sound) => sound.id === selected.id) : null;
  const addingSound = selected?.type === 'newSound' && soundsOffered;
  const showSounds = soundsOffered || sounds.length > 0;

  return (
    <section className="card card-white editor-card" aria-labelledby={`${baseId}-title`}>
      <div className="editor-head">
        <h2 className="music-title" id={`${baseId}-title`}>Editor</h2>
        <div className="editor-transport">
          <button type="button" id="editor-play" className="btn btn-primary btn-sm" onClick={playing ? stop : play} disabled={disabled}>
            {playing ? 'Pause' : 'Play'}
          </button>
          <span className="editor-clock" aria-live="off">
            {clock(time, true)} / {clock(timeline.total, true)}
          </span>
          <button type="button" id="editor-export" className="btn btn-secondary btn-sm" onClick={handleExport} disabled={disabled || exporting || packageBuilding}>
            {exporting || packageBuilding ? <LoadingSpinner size="sm" label="Preparing…" /> : 'Export for another editor'}
          </button>
          {soundsOffered && (
            <button
              type="button" id="editor-add-sound" className="btn btn-secondary btn-sm" disabled={disabled}
              aria-pressed={addingSound} onClick={() => setSelected({ type: 'newSound' })}
            >
              Add sound
            </button>
          )}
          <div className="editor-zoom" role="group" aria-label="Zoom">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setScale(zoomScale(pps, -1))} aria-label="Zoom out">−</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setScale(null)}>Fit</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setScale(zoomScale(pps, 1))} aria-label="Zoom in">+</button>
          </div>
        </div>
      </div>

      {(packageBuilding || project?.packageStatus === 'ready' || project?.packageStatus === 'failed') && (
        <p className={`gen-note ${project.packageStatus === 'failed' ? 'is-error' : ''}`} role="status">
          {packageBuilding && 'Preparing the package: the clips, the music, a timeline file and the captions. It downloads by itself when it is ready.'}
          {!packageBuilding && project.packageStatus === 'ready' && project.packageUrl && (
            <>
              The package is ready. If it did not download by itself: <a href={project.packageUrl} download={project.packageName || 'project.zip'}>download {project.packageName || 'the package'}</a>.
              {' '}It opens in Premiere Pro and DaVinci Resolve (see the README inside). Export again after you change the cut.
            </>
          )}
          {!packageBuilding && project.packageStatus === 'failed' && `The package could not be made: ${project.packageError || 'try again.'}`}
        </p>
      )}

      {(voiceState === 'building' || voiceState === 'missing') && (
        <p className="editor-loading" role="status">
          <LoadingSpinner size="sm" />
          <span>
            Loading the voice {voice.name || 'you chose'}: {voiceReadyCount} of {ready.length} {ready.length === 1 ? 'scene' : 'scenes'} ready.
            {' '}A scene plays its own voice until its new one is ready.
          </span>
        </p>
      )}

      <div className="editor-stage">
        <div className="editor-preview">
          {timeline.clips.map((clip) => {
            const isCurrent = clip.id === current?.id;
            return (
              <video
                key={clip.id}
                ref={(element) => { videos.current[clip.id] = element; }}
                className={isCurrent ? 'is-current' : ''}
                src={clip.scene.videoUrl}
                playsInline
                preload="auto"
                aria-label={isCurrent ? `Preview: scene ${clip.label}` : undefined}
                aria-hidden={isCurrent ? undefined : 'true'}
                onLoadedMetadata={(event) => {
                  // A scene waiting for its turn rests on its first kept frame, ready to show.
                  if (isCurrent) applySeek();
                  else event.currentTarget.currentTime = clip.start;
                }}
                onTimeUpdate={isCurrent && playing ? advance : undefined}
                onEnded={isCurrent ? stepOver : undefined}
              />
            );
          })}
          {music?.url && <audio ref={audio} src={music.url} loop preload="auto" aria-hidden="true" />}
          {sounds.map((sound) => (sound.url ? (
            <audio
              key={sound.id} ref={(element) => { soundPlayers.current[sound.id] = element; }} src={sound.url} preload="auto"
              aria-hidden="true" data-testid={`sound-${sound.id}`}
            />
          ) : null))}
          {timeline.clips.map((clip) => {
            const url = revoicedUrl(project, clip.scene);
            return url ? (
              <audio
                key={clip.id} ref={(element) => { dubs.current[clip.id] = element; }} src={url} preload="auto" aria-hidden="true"
                data-testid={`dub-${clip.id}`}
              />
            ) : null;
          })}
        </div>

        <div className="editor-inspector" aria-live="polite">
          {chosen && (
            <>
              <div className="editor-inspector-head">
                <h3 className="editor-inspector-title">Scene {chosen.label}</h3>
                {chosenEdit && (
                  <button type="button" className="link-button" onClick={() => reset(chosen.scene)} disabled={disabled}>Reset</button>
                )}
              </div>
              <p className="field-hint">
                {editSummary(chosenEdit, lengthOf(chosen.scene), chosenAuto)
                  || (chosenAuto ? 'Automatic cut: the pauses before and after the words are removed.' : `The whole clip, ${lengthOf(chosen.scene).toFixed(1)}s. Pauses are cut automatically when you stitch.`)}
              </p>
              <div className="editor-fields">
                <label htmlFor={`${baseId}-start`}>Start</label>
                <input
                  id={`${baseId}-start`} className="input" type="number" min={0} max={lengthOf(chosen.scene)} step={0.1}
                  value={Number(chosen.start.toFixed(1))} disabled={disabled}
                  onChange={(e) => change(chosen.scene, 'start', Number(e.target.value))}
                />
                <label htmlFor={`${baseId}-end`}>End</label>
                <input
                  id={`${baseId}-end`} className="input" type="number" min={0} max={lengthOf(chosen.scene)} step={0.1}
                  value={Number(chosen.end.toFixed(1))} disabled={disabled}
                  onChange={(e) => change(chosen.scene, 'end', Number(e.target.value))}
                />
              </div>
              <label className="editor-range" htmlFor={`${baseId}-voice`}>
                <span>Voice volume</span>
                <input
                  id={`${baseId}-voice`} type="range" min={0} max={MAX_SCENE_VOLUME * 100} step={5}
                  value={chosenEdit?.muted ? 0 : Math.round((chosenEdit?.volume ?? 1) * 100)}
                  disabled={disabled || Boolean(chosenEdit?.muted)}
                  onChange={(e) => change(chosen.scene, 'volume', Number(e.target.value) / 100)}
                />
                <output>{chosenEdit?.muted ? 'Muted' : `${Math.round((chosenEdit?.volume ?? 1) * 100)}%`}</output>
              </label>
              <label className="gen-run-option" htmlFor={`${baseId}-mute`}>
                <input
                  type="checkbox" id={`${baseId}-mute`} checked={Boolean(chosenEdit?.muted)} disabled={disabled}
                  onChange={(e) => change(chosen.scene, 'muted', e.target.checked)}
                />
                Mute this scene&apos;s own sound
              </label>
            </>
          )}
          {selected?.type === 'music' && music && (
            <>
              <h3 className="editor-inspector-title">Music</h3>
              <p className="field-hint">{music.name || 'Music track'}. It runs under the whole video and dips while someone talks.</p>
              <label className="editor-range" htmlFor={`${baseId}-music`}>
                <span>Music volume</span>
                <input
                  id={`${baseId}-music`} type="range" min={0} max={100} step={1} value={musicPercent} disabled={disabled}
                  onChange={(e) => changeMusicVolume(Number(e.target.value))}
                />
                <output>{musicPercent}%</output>
              </label>
            </>
          )}
          {captionScene && (
            <>
              <div className="editor-inspector-head">
                <h3 className="editor-inspector-title">Caption of scene {captionScene.label}</h3>
                {captionIsOwn(captionScene.scene) && (
                  <button type="button" className="link-button" onClick={() => resetCaption(captionScene.scene)} disabled={disabled}>
                    Use the script again
                  </button>
                )}
              </div>
              <label className="visually-hidden" htmlFor={`${baseId}-caption`}>Caption text</label>
              <textarea
                id={`${baseId}-caption`} className="textarea" rows={2} value={captionOf(captionScene.scene)} disabled={disabled}
                placeholder="No caption on this scene"
                onChange={(e) => changeCaption(captionScene.scene, e.target.value)}
                onBlur={() => (captions ? captions.commit(captionScene.scene.id) : flush(`captions.texts.${captionScene.scene.id}`))}
              />
              <p className="field-hint">Shown word by word while the scene plays. Leave it empty for no caption on this scene.</p>
            </>
          )}
          {selected?.type === 'card' && cardOn && (
            <>
              <h3 className="editor-inspector-title">End card</h3>
              <div className="editor-card-fields">
                <label htmlFor={`${baseId}-card-seconds`}>Length</label>
                <select
                  id={`${baseId}-card-seconds`} className="select" value={cardValue('seconds')} disabled={disabled}
                  onChange={(e) => changeCard('seconds', Number(e.target.value))}
                >
                  {END_CARD_SECONDS.map((seconds) => <option key={seconds} value={seconds}>{seconds} seconds</option>)}
                </select>
              </div>
              <p className="field-hint">Change its picture, or switch it off, under “End card” on this page.</p>
            </>
          )}
          {addingSound && (
            <>
              <h3 className="editor-inspector-title">New sound effect</h3>
              <label className="visually-hidden" htmlFor={`${baseId}-sound-prompt`}>Describe the sound</label>
              <input
                id={`${baseId}-sound-prompt`} className="input" type="text" maxLength={300} value={soundPrompt}
                placeholder="Describe the sound, e.g. soft whoosh" disabled={disabled || makingSound}
                onChange={(e) => setSoundPrompt(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleMakeSound(); }}
              />
              <div className="editor-sound-ideas" role="group" aria-label="Ideas">
                {SOUND_IDEAS.map((idea) => (
                  <button
                    key={idea.label} type="button" className="btn btn-ghost btn-sm" disabled={disabled || makingSound}
                    onClick={() => setSoundPrompt(idea.prompt)}
                  >
                    {idea.label}
                  </button>
                ))}
              </div>
              <div className="editor-sound-make">
                <label htmlFor={`${baseId}-sound-seconds`}>Length</label>
                <select
                  id={`${baseId}-sound-seconds`} className="select" value={soundSeconds} disabled={disabled || makingSound}
                  onChange={(e) => setSoundSeconds(Number(e.target.value))}
                >
                  <option value={0}>Automatic</option>
                  {SOUND_LENGTHS.map((seconds) => <option key={seconds} value={seconds}>{seconds} {seconds === 1 ? 'second' : 'seconds'}</option>)}
                </select>
                <button
                  type="button" className="btn btn-primary btn-sm" onClick={handleMakeSound}
                  disabled={disabled || makingSound || soundPrompt.trim().length < 2 || sounds.length >= MAX_SOUNDS}
                >
                  {makingSound ? <LoadingSpinner size="sm" label="Making the sound…" /> : 'Make it and place it'}
                </button>
              </div>
              <p className="field-hint">
                {sounds.length >= MAX_SOUNDS
                  ? `This video already has ${MAX_SOUNDS} sound effects. Remove one to add another.`
                  : `It is placed at the playhead (${clock(time, true)}). Drag it along the Sounds track to move it.`}
              </p>
            </>
          )}
          {chosenSound && (
            <>
              <div className="editor-inspector-head">
                <h3 className="editor-inspector-title">Sound: {chosenSound.name}</h3>
                <button type="button" className="link-button" onClick={() => removeSound(chosenSound)} disabled={disabled}>Remove</button>
              </div>
              {chosenSound.time === null ? (
                <p className="field-hint">Not heard: it sits on a part of the video that is cut away or left out. Remove it, or bring that part back.</p>
              ) : (
                <div className="editor-sound-make">
                  <label htmlFor={`${baseId}-sound-at`}>Starts at</label>
                  <input
                    id={`${baseId}-sound-at`} className="input" type="number" min={0} max={Number(timeline.total.toFixed(1))} step={0.1}
                    value={Number(chosenSound.time.toFixed(1))} disabled={disabled}
                    onChange={(e) => moveSound(chosenSound, Number(e.target.value))}
                  />
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => hearSound(chosenSound)}>Listen</button>
                </div>
              )}
              <label className="editor-range" htmlFor={`${baseId}-sound-volume`}>
                <span>Volume</span>
                <input
                  id={`${baseId}-sound-volume`} type="range" min={0} max={100} step={5} value={chosenSound.volume} disabled={disabled}
                  onChange={(e) => changeSound(chosenSound, { volume: Number(e.target.value) })}
                />
                <output>{chosenSound.volume}%</output>
              </label>
              <p className="field-hint">
                {chosenSound.seconds.toFixed(1)}s long. It stays on the same moment of its scene when you trim other scenes.
              </p>
            </>
          )}
          {!chosen && !captionScene && !addingSound && !chosenSound && !(selected?.type === 'music' && music) && !(selected?.type === 'card' && cardOn) && (
            <p className="field-hint">
              Select a clip to trim it or change its volume, a caption to change its text, or the music for its volume.
              Drag a clip&apos;s edges to cut its start or end, and drag on the ruler to move the playhead.
              {soundsOffered && ' “Add sound” puts a sound effect at the playhead.'}
            </p>
          )}
        </div>
      </div>

      <div className="tl">
        <div className="tl-labels" aria-hidden="true">
          <span className="tl-label is-ruler" />
          <span className="tl-label is-video">Video</span>
          <span className="tl-label">Voice</span>
          {captionStyle !== 'none' && <span className="tl-label">Captions</span>}
          {showSounds && <span className="tl-label">Sounds</span>}
          <span className="tl-label">Music</span>
        </div>

        <div className="tl-scroll" ref={scroller}>
          <div className="tl-canvas" ref={canvas} style={{ width: `${width}px` }}>
            {/* The ruler has no keyboard role: the playhead also follows the selected clip. */}
            <div className="tl-ruler" data-testid="editor-ruler" {...scrubHandlers}>
              {rulerMarks(timeline.total, pps).map((mark) => (
                <span key={mark.time} className="tl-mark" style={{ left: `${mark.time * pps}px` }}>{mark.label}</span>
              ))}
              {/* Where the video ends, so a trim is seen on the ruler too. */}
              <span className="tl-end" data-testid="editor-end" style={{ left: `${timeline.total * pps}px` }}>
                {clock(timeline.total, true)}
              </span>
            </div>

            <div className="tl-track is-video" role="group" aria-label="Video track">
              {timeline.clips.map((clip) => (
                <div
                  key={clip.id}
                  className={`tl-clip ${chosen?.id === clip.id ? 'is-selected' : ''}`}
                  style={{ left: `${clip.at * pps}px`, width: `${clip.length * pps}px` }}
                >
                  <button
                    type="button"
                    className="tl-clip-body"
                    aria-pressed={chosen?.id === clip.id}
                    aria-label={`Scene ${clip.label}, ${clip.length.toFixed(1)} seconds`}
                    onClick={() => select(clip)}
                  >
                    <video
                      className="tl-thumb" src={clip.scene.videoUrl} muted playsInline preload="metadata" aria-hidden="true" tabIndex={-1}
                      onLoadedMetadata={(event) => {
                        const seconds = event.currentTarget.duration;
                        if (Number.isFinite(seconds) && seconds > 0) setDurations((prev) => ({ ...prev, [clip.id]: seconds }));
                      }}
                    />
                    <span className="tl-clip-name">Scene {clip.label}</span>
                    <span className="tl-clip-time">{clip.length.toFixed(1)}s</span>
                  </button>
                  {['start', 'end'].map((side) => (
                    <span
                      key={side}
                      className={`tl-handle is-${side}`}
                      data-testid={`handle-${side}-${clip.id}`}
                      title={side === 'start' ? 'Drag to cut the start' : 'Drag to cut the end'}
                      onPointerDown={(event) => startDrag(event, clip, side)}
                      onPointerMove={(event) => moveDrag(event, clip)}
                      onPointerUp={endDrag}
                      onPointerCancel={endDrag}
                    />
                  ))}
                </div>
              ))}
              {timeline.total > timeline.clipsEnd && (
                <button
                  type="button"
                  className={`tl-block is-card ${selected?.type === 'card' ? 'is-selected' : ''}`}
                  style={{ left: `${timeline.clipsEnd * pps}px`, width: `${(timeline.total - timeline.clipsEnd) * pps}px` }}
                  aria-pressed={selected?.type === 'card'}
                  aria-label={`End card, ${endCard.seconds} seconds`}
                  onClick={() => setSelected({ type: 'card' })}
                >
                  <span className="tl-block-text">End card</span>
                </button>
              )}
            </div>

            <div className="tl-track" role="group" aria-label="Voice track">
              {timeline.clips.map((clip) => {
                const edit = editOf(clip.scene);
                const level = edit?.muted ? 0 : Math.min(MAX_SCENE_VOLUME, edit?.volume ?? 1) / MAX_SCENE_VOLUME;
                return (
                  <button
                    key={clip.id} type="button" tabIndex={-1}
                    className={`tl-block is-voice ${edit?.muted ? 'is-muted' : ''} ${chosen?.id === clip.id ? 'is-selected' : ''}`}
                    style={{ left: `${clip.at * pps}px`, width: `${clip.length * pps}px` }}
                    aria-label={`Voice of scene ${clip.label}: ${edit?.muted ? 'muted' : `${Math.round((edit?.volume ?? 1) * 100)}%`}`}
                    onClick={() => select(clip)}
                  >
                    <span className="tl-level" style={{ height: `${Math.round(level * 100)}%` }} />
                    <span className="tl-block-text">
                      {edit?.muted ? 'Muted' : `${Math.round((edit?.volume ?? 1) * 100)}%`}
                      {voice && revoicedUrl(project, clip.scene) && ` · ${voice.name || 'chosen voice'}`}
                      {voice && !revoicedUrl(project, clip.scene) && voiceLoading && ' · loading voice…'}
                    </span>
                  </button>
                );
              })}
            </div>

            {captionStyle !== 'none' && (
              <div className="tl-track" role="group" aria-label="Captions track">
                {timeline.clips.map((clip) => {
                  const text = captionOf(clip.scene).trim();
                  const isSelected = selected?.type === 'caption' && selected.id === clip.id;
                  return (
                    <button
                      key={clip.id} type="button"
                      className={`tl-block is-caption ${text ? '' : 'is-empty'} ${isSelected ? 'is-selected' : ''}`}
                      title={text || 'No caption on this scene'}
                      style={{ left: `${clip.at * pps}px`, width: `${clip.length * pps}px` }}
                      aria-pressed={isSelected}
                      aria-label={`Caption of scene ${clip.label}: ${text || 'none'}`}
                      onClick={() => setSelected({ type: 'caption', id: clip.id })}
                    >
                      <span className="tl-block-text">{text || 'No caption'}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {showSounds && (
              <div className="tl-track" role="group" aria-label="Sounds track">
                {heardSounds.map((sound) => {
                  const isSelected = chosenSound?.id === sound.id;
                  return (
                    <button
                      key={sound.id} type="button"
                      className={`tl-block is-sound ${isSelected ? 'is-selected' : ''}`}
                      style={{ left: `${sound.time * pps}px`, width: `${Math.max(MIN_SOUND_WIDTH, sound.seconds * pps)}px` }}
                      title={`${sound.name}. Drag to move it.`}
                      aria-pressed={isSelected}
                      aria-label={`Sound: ${sound.name}, at ${clock(sound.time, true)}, volume ${sound.volume}%`}
                      onClick={() => setSelected({ type: 'sound', id: sound.id })}
                      onPointerDown={(event) => startSoundDrag(event, sound)}
                      onPointerMove={(event) => moveSoundDrag(event, sound)}
                      onPointerUp={() => endSoundDrag(sound)}
                      onPointerCancel={() => endSoundDrag(sound)}
                    >
                      <span className="tl-block-text">{sound.name}</span>
                    </button>
                  );
                })}
                {!heardSounds.length && (
                  <div className="tl-block is-empty" style={{ left: 0, width: `${width}px` }}>
                    <span className="tl-block-text">No sound effects. “Add sound” puts one at the playhead.</span>
                  </div>
                )}
              </div>
            )}

            <div className="tl-track" role="group" aria-label="Music track">
              {music ? (
                <button
                  type="button"
                  className={`tl-block is-music ${selected?.type === 'music' ? 'is-selected' : ''}`}
                  style={{ left: 0, width: `${width}px` }}
                  aria-pressed={selected?.type === 'music'}
                  aria-label={`Music: ${music.name || 'track'}, volume ${musicPercent}%`}
                  onClick={() => setSelected({ type: 'music' })}
                >
                  <span className="tl-block-text">♪ {music.name || 'Music track'} · {musicPercent}%</span>
                </button>
              ) : (
                <div className="tl-block is-empty" style={{ left: 0, width: `${width}px` }}>
                  <span className="tl-block-text">No music. Add a track under “Background music”.</span>
                </div>
              )}
            </div>

            <div className="tl-playhead" style={{ left: `${Math.min(time, timeline.total) * pps}px` }} aria-hidden="true">
              <span className="tl-playhead-knob" data-testid="editor-playhead" title="Drag to move the playhead" {...scrubHandlers} />
            </div>
          </div>
        </div>
      </div>

      {lostSounds.length > 0 && (
        <p className="field-hint editor-foot">
          {lostSounds.length === 1 ? 'One sound effect is' : `${lostSounds.length} sound effects are`} not heard,
          because {lostSounds.length === 1 ? 'its' : 'their'} part of the video is cut away or left out:{' '}
          {lostSounds.map((sound, index) => (
            <React.Fragment key={sound.id}>
              {index > 0 && ', '}
              <button type="button" className="link-button" onClick={() => setSelected({ type: 'sound', id: sound.id })}>{sound.name}</button>
            </React.Fragment>
          ))}.
        </p>
      )}

      <p className="field-hint editor-foot" role="status">
        {voiceState === 'off' && 'The preview plays each scene’s own voice with the music and the sound effects.'}
        {voiceState === 'ready' && `The preview plays the voice you chose (${voice.name || 'one voice'}) with the music.`}
        {voiceLoading && `The voice you chose (${voice.name || 'one voice'}) is still loading: each scene switches to it as soon as it is ready.`}
        {voiceState === 'failed' && (
          <>
            The voice you chose could not be prepared: {project.voicePreview?.error || 'try again.'}{' '}
            <button type="button" className="link-button" onClick={askForVoice} disabled={disabled}>Try again</button>
          </>
        )}
        {' '}Captions are burned in when you stitch.
      </p>

      <div aria-live="polite">
        {error && <p className="gen-note is-error" role="alert">{error}</p>}
      </div>
    </section>
  );
}
