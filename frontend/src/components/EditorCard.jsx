import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { updateProjectSettings } from '../hooks/useProject';
import { friendlyError } from '../utils/errors';
import { MAX_SCENE_VOLUME, changeEdit, editSummary, keptRange, musicVolumePercent, sceneEdit } from '../utils/edits';
import { projectCaptionStyle, projectEndCard, projectMusic, sceneCaptionText } from '../utils/projectProgress';
import { autoCut, buildTimeline, clock, fitScale, locate, rulerMarks, timelineTime, zoomScale } from '../utils/timeline';

const SAVE_DELAY_MS = 500;

/**
 * Video step: the editor. A timeline with one track each for the picture, the scenes' voices,
 * the captions and the music, a playhead, and a preview that plays the cut as edited (with the
 * music) without stitching.
 *
 * A clip on the picture track is trimmed by dragging its edges, or with the Start and End fields
 * of the panel that opens when it is selected (the same thing, for the keyboard). The panel also
 * holds the scene's voice volume and mute; selecting the music bar shows its volume.
 *
 * Captions are shown for orientation only (they are edited under "Captions and cuts"), and the
 * chosen voice is applied by the stitch, so the preview has each scene's own voice.
 *
 * @param {object}  project
 * @param {Array}   scenes   [{ scene, label }] in video order, skipped scenes left out
 * @param {number}  fallbackSeconds  scene length to assume until a clip's real length is known
 * @param {boolean} disabled
 */
export default function EditorCard({ project, scenes, fallbackSeconds = 8, disabled = false }) {
  const baseId = useId();
  const video = useRef(null);
  const audio = useRef(null);
  const scroller = useRef(null);
  const drag = useRef(null);
  const timers = useRef({});
  const pending = useRef({});
  const [durations, setDurations] = useState({});
  const [drafts, setDrafts] = useState({});      // edits changed here and not yet back from the server
  const [musicDraft, setMusicDraft] = useState(null);
  const [selected, setSelected] = useState(null); // { type: 'clip', id } | { type: 'music' } | null
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

  // ── Playback ────────────────────────────────────────────────────────────────────────────────
  // The preview shows one scene's file at a time. `seek` says where the player should be; it is
  // applied when the file is ready (a scene change loads another file).
  const seek = useRef({ clipTime: 0, token: 0 });
  const applySeek = () => {
    const element = video.current;
    if (!element || !current) return;
    const edit = editOf(current.scene);
    element.muted = Boolean(edit?.muted);
    element.volume = Math.min(1, Math.max(0, edit?.volume ?? 1)); // a browser cannot play louder than 100%
    element.currentTime = seek.current.clipTime;
    if (playing) element.play?.()?.catch?.(() => {});
  };
  const goTo = (seconds) => {
    const target = Math.max(0, Math.min(seconds, timeline.clipsEnd));
    const spot = locate(timeline, target);
    if (!spot) return;
    seek.current = { clipTime: spot.clipTime, token: seek.current.token + 1 };
    setTime(target);
    if (spot.index === place?.index) applySeek();
    const track = audio.current;
    if (track && Number.isFinite(track.duration) && track.duration > 0) track.currentTime = target % track.duration;
  };
  const stop = () => {
    setPlaying(false);
    video.current?.pause?.();
    audio.current?.pause?.();
  };
  const play = () => {
    if (!current) return;
    if (time >= timeline.clipsEnd - 0.05) goTo(0);
    setPlaying(true);
  };
  // Starts or stops the players when "playing" flips, and keeps the music volume current.
  useEffect(() => {
    const track = audio.current;
    if (track) track.volume = Math.min(1, musicPercent / 100);
    if (!playing) return;
    video.current?.play?.()?.catch?.(() => {});
    track?.play?.()?.catch?.(() => {});
  }, [playing, musicPercent]);

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
    const element = video.current;
    if (!element || !current) return;
    if (element.currentTime >= current.end - 0.03) stepOver();
    else setTime(timelineTime(timeline, place.index, element.currentTime));
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
    if (!playing) goTo(clip.at);
  };
  const seekFromRuler = (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    goTo((event.clientX - box.left) / pps);
  };

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
          <div className="editor-zoom" role="group" aria-label="Zoom">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setScale(zoomScale(pps, -1))} aria-label="Zoom out">−</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setScale(null)}>Fit</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setScale(zoomScale(pps, 1))} aria-label="Zoom in">+</button>
          </div>
        </div>
      </div>

      <div className="editor-stage">
        <div className="editor-preview">
          {current && (
            <video
              // Keyed by scene: each scene's file loads fresh and starts where the playhead is.
              key={current.id}
              ref={video}
              src={current.scene.videoUrl}
              playsInline
              preload="auto"
              aria-label={`Preview: scene ${current.label}`}
              onLoadedMetadata={applySeek}
              onTimeUpdate={playing ? advance : undefined}
              onEnded={stepOver}
            />
          )}
          {music?.url && <audio ref={audio} src={music.url} loop preload="auto" aria-hidden="true" />}
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
          {!chosen && !(selected?.type === 'music' && music) && (
            <p className="field-hint">
              Select a clip to trim it or change its volume. Drag a clip&apos;s edges to cut its start or end.
              Click the ruler to move the playhead.
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
          <span className="tl-label">Music</span>
        </div>

        <div className="tl-scroll" ref={scroller}>
          <div className="tl-canvas" style={{ width: `${width}px` }}>
            {/* The ruler has no keyboard role: the playhead also follows the selected clip. */}
            {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
            <div className="tl-ruler" data-testid="editor-ruler" onClick={seekFromRuler}>
              {rulerMarks(timeline.total, pps).map((mark) => (
                <span key={mark.time} className="tl-mark" style={{ left: `${mark.time * pps}px` }}>{mark.label}</span>
              ))}
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
                <div className="tl-block is-card" style={{ left: `${timeline.clipsEnd * pps}px`, width: `${(timeline.total - timeline.clipsEnd) * pps}px` }}>
                  End card
                </div>
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
                    <span className="tl-block-text">{edit?.muted ? 'Muted' : `${Math.round((edit?.volume ?? 1) * 100)}%`}</span>
                  </button>
                );
              })}
            </div>

            {captionStyle !== 'none' && (
              <div className="tl-track" role="group" aria-label="Captions track">
                {timeline.clips.map((clip) => {
                  const text = sceneCaptionText(project, clip.scene).trim();
                  return (
                    <div
                      key={clip.id} className={`tl-block is-caption ${text ? '' : 'is-empty'}`} title={text || 'No caption on this scene'}
                      style={{ left: `${clip.at * pps}px`, width: `${clip.length * pps}px` }}
                    >
                      <span className="tl-block-text">{text || 'No caption'}</span>
                    </div>
                  );
                })}
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

            <div className="tl-playhead" style={{ left: `${Math.min(time, timeline.total) * pps}px` }} aria-hidden="true" />
          </div>
        </div>
      </div>

      <p className="field-hint editor-foot">
        The preview plays each scene&apos;s own voice with the music. Captions and the voice chosen under “Voice” are added when you stitch.
      </p>

      <div aria-live="polite">
        {error && <p className="gen-note is-error" role="alert">{error}</p>}
      </div>
    </section>
  );
}
