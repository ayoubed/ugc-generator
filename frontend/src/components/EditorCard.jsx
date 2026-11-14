import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { deleteField } from 'firebase/firestore';
import LoadingSpinner from './LoadingSpinner';
import { updateProjectSettings } from '../hooks/useProject';
import { useVoices } from '../hooks/useVoices';
import { exportPackage, makeNarration, makeSound, previewVoice, removeNarration } from '../services/api';
import { friendlyError } from '../utils/errors';
import {
  MAX_SCENE_VOLUME, changeEdit, editSummary, keptRange, musicVolumePercent, previewGain, previewMusicGain, sceneEdit,
} from '../utils/edits';
import { END_CARD_SECONDS, projectEndCard, projectMusic, projectVoice, toMillis } from '../utils/projectProgress';
import {
  MAX_SOUNDS, SOUND_DEFAULT_VOLUME, SOUND_IDEAS, previewSoundGain, projectSounds, soundPlace, soundTime,
} from '../utils/sounds';
import {
  PAUSE_HINT, changeNarration, narrationClock, narrationLost, narrationOverflow, narrationSpan, narrationTailClock, sceneNarration,
} from '../utils/narration';
import { revoicedUrl, voicePreviewState } from '../utils/voicePreview';
import { autoCut, buildTimeline, clock, fitScale, locate, rulerMarks, timelineTime, zoomScale } from '../utils/timeline';

const SAVE_DELAY_MS = 500;

/**
 * Video step: the editor. A timeline with one track each for the picture, the scenes' voices,
 * the sound effects and the music, a playhead, and a preview that plays the cut as
 * edited (with the music and the sound effects) without stitching.
 *
 * "Add sound" makes a sound effect from a description and puts it at the playhead; it is then
 * moved by dragging it along its track, and its volume is set in the panel.
 *
 * A clip on the picture track is trimmed by dragging its edges, or with the Start and End fields
 * of the panel that opens when it is selected (the same thing, for the keyboard). The panel also
 * holds the scene's voice volume and mute; selecting the music bar shows its volume.
 *
 * A scene can get a narration: a voice made from its own text (which may differ from the script
 * and can hold [pause] marks) that replaces the sound of the take. It is a block
 * on the Voice track: dragged to slide it against the picture, and trimmed in its panel.
 *
 * Captions are not edited here: they follow the script, or the narration of a narrated scene,
 * and are timed on the voice when the video is stitched. The end card block opens its length,
 * and shows the card in the preview. The chosen voice is applied by the stitch, so the preview has each scene's own
 * voice. "Export for another editor" builds a package other editors can open.
 *
 * @param {object}  project
 * @param {Array}   scenes   [{ scene, label }] in video order, skipped scenes left out
 * @param {number}  fallbackSeconds  scene length to assume until a clip's real length is known
 * @param {boolean} disabled
 * Sound effects are offered when the voice service is set up (the same service makes them).
 */
const STALE_PACKAGE_MS = 10 * 60 * 1000; // same limit the API uses
const VOICE_DRIFT_SECONDS = 0.25;         // more than this between lips and voice is noticeable
const RESYNC_PAUSE_MS = 2000;
const PLAYHEAD_REDRAW_MS = 80;
const SOUND_LENGTHS = [1, 2, 3, 5];       // seconds offered for a new sound, besides "automatic"
const MIN_SOUND_WIDTH = 30;               // pixels: a very short sound can still be grabbed

export default function EditorCard({ project, scenes, fallbackSeconds = 8, disabled = false }) {
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
  // Narrations: one player each, the placements changed here and not yet back from the server,
  // the texts being typed, and which scene's voice is being made.
  const narrators = useRef({});
  const narrationDrag = useRef(null);
  const [narrationDrafts, setNarrationDrafts] = useState({});
  const [narrationTexts, setNarrationTexts] = useState({});
  const [makingVoice, setMakingVoice] = useState('');
  const scrubbing = useRef(false);
  const canvas = useRef(null);
  const [selected, setSelected] = useState(null); // { type: 'clip' | 'voice' | 'sound', id } | { type: 'music' | 'card' | 'newSound' } | null
  const [time, setTime] = useState(0);            // the playhead, in seconds of the timeline
  // The end card on screen: how far into it the playhead is (null = a scene is on screen). It has
  // no player of its own, so while it plays the time comes from the clock.
  const [cardAt, setCardAt] = useState(null);
  const cardClock = useRef({ base: 0, since: 0 });
  const [playing, setPlaying] = useState(false);
  const [scale, setScale] = useState(null);       // pixels per second chosen with the zoom; null = fit the width
  const [viewWidth, setViewWidth] = useState(0);  // width of the visible part of the timeline
  const [error, setError] = useState('');

  const ready = useMemo(() => scenes.filter(({ scene }) => scene.videoUrl), [scenes]);
  const music = projectMusic(project);
  const endCard = projectEndCard(project);
  const musicPercent = musicDraft ?? musicVolumePercent(music?.volume);

  const editOf = (scene) => (scene.id in drafts ? drafts[scene.id] : sceneEdit(project, scene));
  const lengthOf = (scene) => durations[scene.id] || fallbackSeconds;
  // A voice placed by hand must stay where it was put: a narrated scene, and the scene after it
  // (which may carry its end), are not tightened around their words when stitched (same rule as
  // the server), so the automatic cut of an earlier version does not apply to them.
  const isTold = (scene) => {
    const narration = sceneNarration(project, scene, scene.id in narrationDrafts ? narrationDrafts[scene.id] : undefined);
    return Boolean(narration?.on && narration.url);
  };
  const cutOf = (scene) => {
    const index = ready.findIndex((item) => item.scene.id === scene.id);
    const keepsWhole = isTold(scene) || (index > 0 && isTold(ready[index - 1].scene));
    return keepsWhole ? null : autoCut(project, scene);
  };
  const rangeOf = (scene) => keptRange(editOf(scene), lengthOf(scene), cutOf(scene));
  const cardSeconds = endCard.enabled && endCard.imageRef ? endCard.seconds : 0;

  const timeline = buildTimeline(
    ready.map(({ scene, label }) => ({ id: scene.id, scene, label, ...rangeOf(scene) })),
    cardSeconds,
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
  const flush = (key) => {
    clearTimeout(timers.current[key]);
    if (!(key in pending.current)) return;
    const value = pending.current[key];
    delete pending.current[key];
    updateProjectSettings(project.id, { [key]: value }).catch((err) => {
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
    const next = changeEdit(editOf(scene), field, value, lengthOf(scene), scene.activeAttempt, cutOf(scene));
    setDrafts((prev) => ({ ...prev, [scene.id]: next }));
    saveSoon(`edits.${scene.id}`, next);
  };
  const reset = (scene) => {
    setDrafts((prev) => ({ ...prev, [scene.id]: null }));
    pending.current[`edits.${scene.id}`] = null;
    flush(`edits.${scene.id}`);
  };
  // ── Narration ───────────────────────────────────────────────────────────────────────────────
  const narrationOf = (scene) => sceneNarration(project, scene, scene.id in narrationDrafts ? narrationDrafts[scene.id] : undefined);
  const activeNarration = (scene) => {
    const narration = narrationOf(scene);
    return narration?.on && narration.url ? narration : null;
  };
  const placeNarration = (scene, field, value, { later = true } = {}) => {
    const narration = narrationOf(scene);
    if (!narration) return;
    const next = changeNarration(narration, field, value, lengthOf(scene));
    setNarrationDrafts((prev) => ({ ...prev, [scene.id]: next }));
    if (later) saveSoon(`narration.${scene.id}`, next);
    else {
      pending.current[`narration.${scene.id}`] = next;
      flush(`narration.${scene.id}`);
    }
  };
  const narrationTextOf = (scene) => narrationTexts[scene.id] ?? scene.narration?.text ?? scene.script ?? '';
  const handleMakeVoice = async (scene) => {
    const text = narrationTextOf(scene).trim();
    if (!text || makingVoice) return;
    setError('');
    setMakingVoice(scene.id);
    try {
      await makeNarration(project.id, scene.id, text);
      // A new voice starts whole: the old trims were for the old recording.
      const place = { at: narrationOf(scene)?.at || 0, trimStart: 0, trimEnd: 0, on: true };
      setNarrationDrafts((prev) => ({ ...prev, [scene.id]: place }));
      pending.current[`narration.${scene.id}`] = place;
      flush(`narration.${scene.id}`);
    } catch (err) {
      console.error('Could not make the voice:', err);
      setError(friendlyError(err));
    } finally {
      setMakingVoice('');
    }
  };
  const handleRemoveVoice = async (scene) => {
    setError('');
    narrators.current[scene.id]?.pause?.();
    try {
      await removeNarration(project.id, scene.id);
      setNarrationTexts((prev) => ({ ...prev, [scene.id]: undefined }));
      setSelected({ type: 'clip', id: scene.id });
    } catch (err) {
      console.error('Could not remove the narration:', err);
      setError(friendlyError(err));
    }
  };
  const hearNarration = (scene) => {
    const narration = narrationOf(scene);
    const element = narrators.current[scene.id];
    if (!narration || !element) return;
    element.muted = false;
    element.currentTime = narration.trimStart;
    element.play?.()?.catch?.(() => {});
  };
  // Dragging the narration along the Voice track slides it against the picture; saved when let go.
  const startNarrationDrag = (event, clip) => {
    if (disabled) return;
    const narration = narrationOf(clip.scene);
    if (!narration) return;
    narrationDrag.current = { id: clip.id, x: event.clientX, at: narration.at, moved: false };
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // without capture the drag still works while the pointer is over the block
    }
    setSelected({ type: 'voice', id: clip.id });
  };
  const moveNarrationDrag = (event, clip) => {
    const held = narrationDrag.current;
    if (!held || held.id !== clip.id || !Number.isFinite(event.clientX)) return;
    if (!held.moved && Math.abs(event.clientX - held.x) < 3) return;   // a click, not a drag
    held.moved = true;
    const narration = narrationOf(clip.scene);
    const next = changeNarration(narration, 'at', held.at + (event.clientX - held.x) / pps, lengthOf(clip.scene));
    held.next = next;   // what is saved when the pointer is let go, whatever has been redrawn by then
    setNarrationDrafts((prev) => ({ ...prev, [clip.id]: next }));
  };
  const endNarrationDrag = (clip) => {
    const held = narrationDrag.current;
    narrationDrag.current = null;
    if (held?.moved && held.id === clip.id && held.next) {
      setNarrationDrafts((prev) => ({ ...prev, [clip.id]: held.next }));
      pending.current[`narration.${clip.id}`] = held.next;
      flush(`narration.${clip.id}`);
    }
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
  // The scene on screen plays its narration, when it has one, in place of every other voice.
  const narrated = () => (current ? activeNarration(current.scene) : null);
  const narrator = () => (narrated() ? narrators.current[current.id] || null : null);
  const dub = () => (current && !narrated() && revoicedUrl(project, current.scene) ? dubs.current[current.id] || null : null);
  // The seconds of the next scene a narration may carry on over (0 for the last scene).
  const roomAfter = (clip) => {
    const next = timeline.clips[timeline.clips.findIndex((item) => item.id === clip.id) + 1];
    return next ? next.length : cardSeconds;   // the last scene's voice may run on over the end card
  };
  const keepAt = (element, spot, jump) => {
    if (spot === null) {
      if (!element.paused) element.pause?.();
      return;
    }
    if (jump || element.paused || Math.abs(element.currentTime - spot) > VOICE_DRIFT_SECONDS) element.currentTime = spot;
    if (playing && element.paused !== false) element.play?.()?.catch?.(() => {});
  };
  // Keeps the narrations' players where the picture is: the scene's own (silent before it starts
  // and after its kept part), and the end of the one before it when that runs on into this scene.
  const syncNarration = (clipTime, { jump = false } = {}) => {
    const narration = narrated();
    const element = narrator();
    if (narration && element) keepAt(element, narrationClock(narration, clipTime), jump);
    const before = place ? timeline.clips[place.index - 1] : null;
    const told = before ? activeNarration(before.scene) : null;
    const tail = told ? narrators.current[before.id] : null;
    if (!tail) return;
    const edit = editOf(before.scene);
    tail.muted = Boolean(edit?.muted);
    tail.volume = previewGain(edit?.volume);
    keepAt(tail, narrationTailClock(told, before, current, clipTime), jump);
  };
  // How loud the scene on screen is: its own sound, or the chosen voice in its place.
  const applySound = () => {
    const element = player();
    if (!element || !current) return;
    const edit = editOf(current.scene);
    const level = previewGain(edit?.volume); // 100% plays below full, so a boost is heard too
    const voiceOver = dub();
    const told = narrator();
    element.muted = Boolean(edit?.muted) || Boolean(voiceOver) || Boolean(narrated());
    element.volume = level;
    if (told) {
      told.muted = Boolean(edit?.muted);
      told.volume = level;
    }
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
    syncNarration(seek.current.clipTime, { jump: true });
  };
  // The end card on screen, `seconds` into it: the scenes' players rest, and what is left of the
  // last scene's narration carries on.
  const lastClip = timeline.clips[timeline.clips.length - 1] || null;
  const syncCard = (seconds, { jump = false } = {}) => {
    const told = lastClip ? activeNarration(lastClip.scene) : null;
    const tail = told ? narrators.current[lastClip.id] : null;
    if (!tail) return;
    const edit = editOf(lastClip.scene);
    tail.muted = Boolean(edit?.muted);
    tail.volume = previewGain(edit?.volume);
    keepAt(tail, narrationTailClock(told, lastClip, { start: 0 }, seconds), jump);
  };
  const enterCard = (seconds) => {
    Object.values(videos.current).forEach((element) => element?.pause?.());
    Object.values(dubs.current).forEach((element) => element?.pause?.());
    Object.entries(narrators.current).forEach(([id, element]) => { if (id !== lastClip?.id) element?.pause?.(); });
    cardClock.current = { base: seconds, since: Date.now() };
    setCardAt(seconds);
    setTime(timeline.clipsEnd + seconds);
    syncCard(seconds, { jump: true });
  };
  const quietSounds = () => {
    started.current = new Set();
    Object.values(soundPlayers.current).forEach((element) => element?.pause?.());
  };
  const goTo = (seconds) => {
    const target = Math.max(0, Math.min(seconds, cardSeconds > 0 ? timeline.total : timeline.clipsEnd));
    const spot = locate(timeline, target);
    if (!spot) return;
    quietSounds();
    if (cardSeconds > 0 && target > timeline.clipsEnd + 0.001) {
      enterCard(target - timeline.clipsEnd);
      const music = audio.current;
      if (music && Number.isFinite(music.duration) && music.duration > 0) music.currentTime = target % music.duration;
      return;
    }
    setCardAt(null);
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
    Object.values(narrators.current).forEach((element) => element?.pause?.());
    audio.current?.pause?.();
    quietSounds();
  };
  const play = () => {
    if (!current) return;
    if (cardAt !== null && cardAt < cardSeconds - 0.05) {
      cardClock.current = { base: cardAt, since: Date.now() };   // carries on from where the card was paused
    } else if (cardAt !== null || time >= timeline.clipsEnd - 0.05) goTo(0);
    setPlaying(true);
  };
  // Starts or stops the players when "playing" flips, and keeps the music volume current.
  useEffect(() => {
    const track = audio.current;
    if (track) track.volume = previewMusicGain(musicPercent);
    if (!playing) return;
    if (cardAt === null) {
      player()?.play?.()?.catch?.(() => {});
      dub()?.play?.()?.catch?.(() => {});
      if (player()) syncNarration(player().currentTime);
    } else syncCard(cardAt);
    track?.play?.()?.catch?.(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, musicPercent]);

  // The scene on screen changed: the others stop, and the new one starts from where the playhead is.
  const currentId = current?.id;
  useEffect(() => {
    Object.entries(videos.current).forEach(([id, element]) => { if (id !== currentId) element?.pause?.(); });
    Object.entries(dubs.current).forEach(([id, element]) => { if (id !== currentId) element?.pause?.(); });
    // The narration of the scene before may still be talking: the seek below keeps or stops it.
    const beforeId = place ? timeline.clips[place.index - 1]?.id : null;
    Object.entries(narrators.current).forEach(([id, element]) => { if (id !== currentId && id !== beforeId) element?.pause?.(); });
    const element = currentId ? videos.current[currentId] : null;
    if (element && element.readyState >= 1) applySeek();   // not loaded yet: its loadedmetadata does it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  // A volume or mute change is heard at once, also while playing, and so is a voice that just got ready.
  const currentEdit = current ? editOf(current.scene) : null;
  const currentDubUrl = current ? revoicedUrl(project, current.scene) : '';
  const currentNarration = current ? activeNarration(current.scene) : null;
  useEffect(() => {
    applySound();
    // A narration switched off or removed while it sounds goes quiet at once.
    if (!currentNarration && currentId) narrators.current[currentId]?.pause?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, currentEdit?.volume, currentEdit?.muted, currentDubUrl, currentNarration?.url]);

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
      if (cardSeconds > 0 && playing) {
        enterCard(0);   // the end card comes on, and the music and the narration carry on
        return;
      }
      stop();
      setTime(timeline.clipsEnd);
      return;
    }
    seek.current = { clipTime: next.start, token: seek.current.token + 1 };
    setTime(next.at);
  };
  // A sound effect starts when the playhead reaches it (or part-way in, when playing from its middle).
  const startSounds = (now) => {
    heardSounds.forEach((sound) => {
      if (started.current.has(sound.id) || now < sound.time || now >= sound.time + sound.seconds - 0.05) return;
      started.current.add(sound.id);
      const effect = soundPlayers.current[sound.id];
      if (!effect) return;
      effect.volume = previewSoundGain(sound.volume);
      effect.currentTime = now - sound.time > 0.1 ? now - sound.time : 0;
      effect.play?.()?.catch?.(() => {});
    });
  };
  // While the end card is on screen the clock moves the playhead; at its end the preview stops.
  const advanceCard = () => {
    const seconds = cardClock.current.base + (Date.now() - cardClock.current.since) / 1000;
    if (seconds >= cardSeconds) {
      stop();
      setCardAt(cardSeconds);
      setTime(timeline.total);
      return;
    }
    syncCard(seconds);
    startSounds(timeline.clipsEnd + seconds);
    setCardAt(seconds);
    setTime(timeline.clipsEnd + seconds);
  };
  useEffect(() => {
    if (!playing || cardAt === null) return undefined;
    const timer = setInterval(advanceCard, PLAYHEAD_REDRAW_MS);
    return () => clearInterval(timer);
  });
  const advance = () => {
    if (cardAt !== null) return;
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
    syncNarration(element.currentTime);
    const now = timelineTime(timeline, place.index, element.currentTime);
    startSounds(now);
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
  const chosenAuto = chosen ? cutOf(chosen.scene) : null;
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
  const cardOn = endCard.enabled && Boolean(endCard.imageRef);
  const chosenSound = selected?.type === 'sound' ? sounds.find((sound) => sound.id === selected.id) : null;
  const voiceClip = selected?.type === 'voice' ? timeline.clips.find((clip) => clip.id === selected.id) : null;
  const voiceNarration = voiceClip ? narrationOf(voiceClip.scene) : null;
  const voiceOverflow = voiceClip && voiceNarration ? narrationOverflow(voiceClip, voiceNarration) : 0;
  const voiceLost = voiceClip && voiceNarration ? narrationLost(voiceClip, voiceNarration, roomAfter(voiceClip)) : 0;
  const voiceNext = voiceClip ? timeline.clips[timeline.clips.findIndex((clip) => clip.id === voiceClip.id) + 1] : null;
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
            const isCurrent = cardAt === null && clip.id === current?.id;
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
          {cardAt !== null && endCard.imageUrl && (
            <img className="editor-card-picture" src={endCard.imageUrl} alt="Preview: end card" />
          )}
          {music?.url && <audio ref={audio} src={music.url} loop preload="auto" aria-hidden="true" />}
          {sounds.map((sound) => (sound.url ? (
            <audio
              key={sound.id} ref={(element) => { soundPlayers.current[sound.id] = element; }} src={sound.url} preload="auto"
              aria-hidden="true" data-testid={`sound-${sound.id}`}
            />
          ) : null))}
          {timeline.clips.map((clip) => {
            const narration = narrationOf(clip.scene);
            return narration?.url ? (
              <audio
                key={clip.id} ref={(element) => { narrators.current[clip.id] = element; }} src={narration.url} preload="auto"
                aria-hidden="true" data-testid={`narration-${clip.id}`}
              />
            ) : null;
          })}
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
                {narrationOf(chosen.scene)?.on ? 'Mute this scene' : "Mute this scene's own sound"}
              </label>
              {soundsOffered && (
                <button type="button" className="link-button" onClick={() => setSelected({ type: 'voice', id: chosen.id })} disabled={disabled}>
                  {narrationOf(chosen.scene) ? "Open this scene's narration" : 'Make a voice for this scene from text'}
                </button>
              )}
            </>
          )}
          {voiceClip && (
            <>
              <div className="editor-inspector-head">
                <h3 className="editor-inspector-title">Narration: scene {voiceClip.label}</h3>
                {voiceNarration && (
                  <button type="button" className="link-button" onClick={() => handleRemoveVoice(voiceClip.scene)} disabled={disabled}>Remove</button>
                )}
              </div>
              <label className="visually-hidden" htmlFor={`${baseId}-narration-text`}>What the voice says</label>
              <textarea
                id={`${baseId}-narration-text`} className="textarea" rows={3} maxLength={1200}
                value={narrationTextOf(voiceClip.scene)} disabled={disabled || makingVoice === voiceClip.id}
                placeholder="What the voice says"
                onChange={(e) => setNarrationTexts((prev) => ({ ...prev, [voiceClip.id]: e.target.value }))}
              />
              <p className="field-hint">
                {PAUSE_HINT} This text is the voice&apos;s own: the script stays as it is. The captions of this scene follow this text.
              </p>
              <div className="editor-sound-make">
                <button
                  type="button" className="btn btn-primary btn-sm" onClick={() => handleMakeVoice(voiceClip.scene)}
                  disabled={disabled || Boolean(makingVoice) || !voice || !narrationTextOf(voiceClip.scene).trim()}
                >
                  {makingVoice === voiceClip.id
                    ? <LoadingSpinner size="sm" label="Making the voice…" />
                    : voiceNarration ? 'Make the voice again' : 'Make the voice'}
                </button>
                {voiceNarration && (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => hearNarration(voiceClip.scene)}>Listen</button>
                )}
              </div>
              {!voice && <p className="field-hint">Choose a voice in the Voice card first: the narration is read in it.</p>}
              {voiceNarration && (
                <>
                  <div className="editor-fields">
                    <label htmlFor={`${baseId}-narration-at`}>Starts at</label>
                    <input
                      id={`${baseId}-narration-at`} className="input" type="number" min={0} max={lengthOf(voiceClip.scene)} step={0.1}
                      value={voiceNarration.at} disabled={disabled}
                      onChange={(e) => placeNarration(voiceClip.scene, 'at', Number(e.target.value))}
                    />
                    <label htmlFor={`${baseId}-narration-trim-start`}>Cut from its start</label>
                    <input
                      id={`${baseId}-narration-trim-start`} className="input" type="number" min={0} max={voiceNarration.seconds} step={0.1}
                      value={voiceNarration.trimStart} disabled={disabled}
                      onChange={(e) => placeNarration(voiceClip.scene, 'trimStart', Number(e.target.value))}
                    />
                    <label htmlFor={`${baseId}-narration-trim-end`}>Cut from its end</label>
                    <input
                      id={`${baseId}-narration-trim-end`} className="input" type="number" min={0} max={voiceNarration.seconds} step={0.1}
                      value={voiceNarration.trimEnd} disabled={disabled}
                      onChange={(e) => placeNarration(voiceClip.scene, 'trimEnd', Number(e.target.value))}
                    />
                  </div>
                  <label className="gen-run-option" htmlFor={`${baseId}-narration-on`}>
                    <input
                      type="checkbox" id={`${baseId}-narration-on`} checked={voiceNarration.on} disabled={disabled}
                      onChange={(e) => placeNarration(voiceClip.scene, 'on', e.target.checked, { later: false })}
                    />
                    Use this voice in place of the scene&apos;s own sound
                  </label>
                  <p className={`field-hint ${voiceLost > 0 ? 'is-warning' : ''}`} role="status">
                    {voiceOverflow <= 0 && `The voice is ${voiceNarration.length.toFixed(1)}s and fits the scene (${voiceClip.length.toFixed(1)}s). Drag it on the Voice track to slide it against the picture.`}
                    {voiceOverflow > 0 && voiceLost <= 0 && `The voice is ${voiceNarration.length.toFixed(1)}s: it carries on for ${voiceOverflow.toFixed(1)}s over ${voiceNext ? `scene ${voiceNext.label}` : 'the end card'}.`}
                    {voiceLost > 0 && (voiceNext
                      ? `The voice is ${voiceNarration.length.toFixed(1)}s: it carries on over scene ${voiceNext.label}, but its last ${voiceLost.toFixed(1)}s run past the end of that scene and are not heard. Start it earlier, cut it, or shorten the text.`
                      : `The voice is ${voiceNarration.length.toFixed(1)}s and runs ${voiceLost.toFixed(1)}s past the end of the video: that part is not heard. Start it earlier, cut it, or shorten the text.`)}
                    {voiceNarration.voiceName && ` Read by ${voiceNarration.voiceName}.`}
                  </p>
                </>
              )}
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
          {!chosen && !voiceClip && !addingSound && !chosenSound && !(selected?.type === 'music' && music) && !(selected?.type === 'card' && cardOn) && (
            <p className="field-hint">
              Select a clip to trim it or change its volume, or the music for its volume.
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
                  onClick={() => {
                    setSelected({ type: 'card' });
                    if (!playing) goTo(timeline.clipsEnd + 0.01);   // shows the card in the preview
                  }}
                >
                  <span className="tl-block-text">End card</span>
                </button>
              )}
            </div>

            <div className="tl-track" role="group" aria-label="Voice track">
              {timeline.clips.map((clip) => {
                const edit = editOf(clip.scene);
                const level = edit?.muted ? 0 : Math.min(MAX_SCENE_VOLUME, edit?.volume ?? 1) / MAX_SCENE_VOLUME;
                const narration = activeNarration(clip.scene);
                if (narration) {
                  // The narration in place of the take's voice: where it is heard, and draggable.
                  // Drawn as far as it is heard, also over the next scene when it runs on.
                  const span = narrationSpan(clip, narration, roomAfter(clip));
                  const isSelected = voiceClip?.id === clip.id;
                  return (
                    <button
                      key={clip.id} type="button"
                      className={`tl-block is-voice is-narration ${edit?.muted ? 'is-muted' : ''} ${isSelected ? 'is-selected' : ''}`}
                      style={{
                        left: `${(span ? span.time : clip.at) * pps}px`,
                        width: `${Math.max(MIN_SOUND_WIDTH, (span ? span.length : 0) * pps)}px`,
                      }}
                      title="Narration. Drag to slide it against the picture."
                      aria-pressed={isSelected}
                      aria-label={`Narration of scene ${clip.label}: ${span ? `at ${clock(span.time, true)}, ${span.length.toFixed(1)} seconds` : 'not heard'}`}
                      onClick={() => setSelected({ type: 'voice', id: clip.id })}
                      onPointerDown={(event) => startNarrationDrag(event, clip)}
                      onPointerMove={(event) => moveNarrationDrag(event, clip)}
                      onPointerUp={() => endNarrationDrag(clip)}
                      onPointerCancel={() => endNarrationDrag(clip)}
                    >
                      <span className="tl-block-text">
                        {span ? `Narration${narration.voiceName ? ` · ${narration.voiceName}` : ''}` : 'Narration (not heard)'}
                      </span>
                    </button>
                  );
                }
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
