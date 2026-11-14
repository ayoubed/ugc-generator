import React, { useRef, useState } from 'react';
import { ref, uploadBytes } from 'firebase/storage';
import LoadingSpinner from './LoadingSpinner';
import { storage } from '../services/firebase';
import { useStorageUrl } from '../hooks/useStorageUrl';
import {
  addStoryboardFrame,
  editStoryboardFrame,
  remakeStoryboardFrame,
  removeStoryboardFrame,
} from '../services/api';
import { endsOnStoryboard, frameOfRole, sceneMoment, startsOnStoryboard } from '../utils/storyboard';

const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const ROLE_TEXT = {
  start: {
    title: 'Starts on',
    empty: 'No picture yet',
    draw: 'Draw this frame',
    use: "Start this scene's video on this picture",
    inUse: 'The video starts on this picture',
    elsewhere: 'You picked another starting picture for this scene on the Generate step, so this one is not used.',
  },
  end: {
    title: 'Ends on',
    empty: 'No end picture',
    draw: 'Draw the end picture',
    use: "End this scene's video on this picture",
    inUse: 'The video ends on this picture',
    elsewhere: 'You picked another end picture for this scene on the Generate step, so this one is not used.',
  },
};

/**
 * One picture of a scene on the Storyboard step, the one its video starts on or the one it ends
 * on: draw it, change it with a short instruction, draw it again, upload one instead, remove it.
 * A picture is used by default; the checkbox switches that off.
 */
function FramePanel({ projectId, uid, scene, label, role, drawing = false }) {
  const text = ROLE_TEXT[role];
  const frame = frameOfRole(scene, role);
  const pictureUrl = useStorageUrl(frame?.imageUrl || frame?.imageRef || '');
  const [busy, setBusy] = useState('');          // '' | 'drawing' | 'saving' | 'uploading'
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(null);      // description being typed (null = not edited)
  const [changeOpen, setChangeOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const fileInput = useRef(null);

  const description = draft ?? frame?.description ?? sceneMoment(scene, role);
  const working = Boolean(busy) || drawing;
  const inUse = role === 'end' ? endsOnStoryboard(scene) : startsOnStoryboard(scene);
  const issues = frame?.issues || [];
  const fieldId = `board-${role}-${scene.id}`;

  const run = async (kind, work) => {
    setError('');
    setBusy(kind);
    try {
      await work();
    } catch (err) {
      setError(err?.message || 'That did not work. Try again.');
    } finally {
      setBusy('');
    }
  };

  const draw = () => run('drawing', async () => {
    if (frame) await remakeStoryboardFrame(projectId, scene.id, frame.id, { description });
    else await addStoryboardFrame(projectId, scene.id, role === 'end' ? { description, role } : { description });
    setDraft(null);
  });

  const change = (event) => {
    event.preventDefault();
    if (!instruction.trim()) return;
    run('drawing', async () => {
      await remakeStoryboardFrame(projectId, scene.id, frame.id, { instruction });
      setInstruction('');
      setChangeOpen(false);
    });
  };

  const accept = (accepted) => run('saving', () => editStoryboardFrame(projectId, scene.id, frame.id, { accepted }));
  const setLook = (look) => run('saving', () => editStoryboardFrame(projectId, scene.id, frame.id, { look }));
  const remove = () => run('saving', () => removeStoryboardFrame(projectId, scene.id, frame.id));

  const upload = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError('Use a PNG, JPG or WebP picture.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError('That picture is over 20 MB. Use a smaller one.');
      return;
    }
    run('uploading', async () => {
      const path = `users/${uid}/projects/${projectId}/scenes/${scene.id}/storyboard/upload_${Date.now()}.${EXTENSIONS[file.type]}`;
      await uploadBytes(ref(storage, path), file, { contentType: file.type });
      if (frame) await removeStoryboardFrame(projectId, scene.id, frame.id);
      await addStoryboardFrame(projectId, scene.id, role === 'end' ? { description, storageRef: path, role } : { description, storageRef: path });
    });
  };

  return (
    <section className={`board-frame ${working ? 'is-busy' : ''}`} aria-label={`${text.title}, scene ${label}`}>
      <div className="board-picture">
        {working && busy !== 'saving' ? (
          <div className="board-picture-empty">
            <LoadingSpinner size="md" label={busy === 'uploading' ? 'Uploading…' : 'Drawing…'} />
          </div>
        ) : frame && pictureUrl ? (
          <img src={pictureUrl} alt={`${text.title}, scene ${label}: ${frame.description || ''}`} />
        ) : (
          <div className="board-picture-empty">
            <span>{frame ? 'Loading the picture…' : text.empty}</span>
          </div>
        )}
      </div>

      <div className="board-body">
        <header className="board-head">
          <h3 className="board-frame-title">{text.title}{role === 'end' ? ' (optional)' : ''}</h3>
          {inUse && <span className="board-tag is-good">{text.inUse}</span>}
          {role === 'start' && frame?.look && frame.accepted && <span className="board-tag">Sets the look of the video</span>}
        </header>

        <label className="board-label" htmlFor={fieldId}>What the picture shows</label>
        <textarea
          id={fieldId}
          className="input board-description"
          rows={3}
          maxLength={600}
          value={description}
          disabled={working}
          onChange={(event) => setDraft(event.target.value)}
        />

        {frame && (
          <label className="board-use">
            <input
              type="checkbox"
              checked={Boolean(frame.accepted)}
              disabled={working || !frame.imageRef}
              onChange={(event) => accept(event.target.checked)}
            />
            {text.use}
          </label>
        )}

        {issues.length > 0 && (
          <div className="gen-note is-warning" role="status">
            The automatic check noticed:
            <ul className="board-issues">
              {issues.map((issue, i) => <li key={i}>{issue.detail}</li>)}
            </ul>
          </div>
        )}
        {frame && frame.accepted && !inUse && <p className="gen-note is-info">{text.elsewhere}</p>}
        {error && <p className="gen-note is-error" role="alert">{error}</p>}

        <div className="board-actions">
          {!frame && (
            <button type="button" className={`btn ${role === 'end' ? 'btn-secondary' : 'btn-primary'}`} onClick={draw} disabled={working || !description.trim()}>
              {text.draw}
            </button>
          )}
          {frame && (
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setChangeOpen((open) => !open)} disabled={working || frame.source === 'upload'}>
                Change it
              </button>
              <button type="button" className="btn btn-secondary" onClick={draw} disabled={working || !description.trim()}>
                Draw again
              </button>
            </>
          )}
          <button type="button" className="btn btn-ghost" onClick={() => fileInput.current?.click()} disabled={working}>
            Upload a picture
          </button>
          {frame && (
            <button type="button" className="btn btn-ghost" onClick={remove} disabled={working}>
              Remove
            </button>
          )}
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPTED_TYPES.join(',')}
            className="visually-hidden"
            aria-label={`Upload a picture: ${text.title.toLowerCase()}, scene ${label}`}
            onChange={upload}
          />
        </div>

        {frame && changeOpen && (
          <form className="board-change" onSubmit={change}>
            <label className="board-label" htmlFor={`${fieldId}-change`}>What should change in this picture?</label>
            <div className="board-change-row">
              <input
                id={`${fieldId}-change`}
                className="input"
                type="text"
                maxLength={400}
                placeholder="e.g. make the watch smaller, on the left wrist"
                value={instruction}
                disabled={working}
                onChange={(event) => setInstruction(event.target.value)}
              />
              <button type="submit" className="btn btn-primary" disabled={working || !instruction.trim()}>
                Change
              </button>
            </div>
          </form>
        )}

        {role === 'start' && frame && frame.accepted && (
          <label className="board-look">
            <input type="checkbox" checked={Boolean(frame.look)} disabled={working} onChange={(event) => setLook(event.target.checked)} />
            Draw the other frames to match this one
          </label>
        )}
      </div>
    </section>
  );
}

/**
 * One scene on the Storyboard step: the picture its video starts on and, optionally, the one it
 * ends on. The end picture is drawn from the start picture, so both are the same shot.
 *
 * drawing: true while the page is drawing this scene's start picture ("draw the missing frames").
 */
export default function StoryboardSceneCard({ projectId, uid, scene, label, drawing = false, skipped = false }) {
  const hasEnd = Boolean(frameOfRole(scene, 'end'));
  const [endOpen, setEndOpen] = useState(false);
  const shared = { projectId, uid, scene, label };

  return (
    <article className="card card-white board-card" aria-label={`Scene ${label}`}>
      <header className="board-head">
        <h2 className="board-title">Scene {label}</h2>
        {skipped && <span className="board-tag">Not in the video</span>}
      </header>
      {scene.script && <p className="board-script">“{scene.script}”</p>}

      <FramePanel {...shared} role="start" drawing={drawing} />

      {hasEnd || endOpen ? (
        <FramePanel {...shared} role="end" />
      ) : (
        <div className="board-end-add">
          <button type="button" className="btn btn-ghost" onClick={() => setEndOpen(true)}>
            + Add the picture this scene ends on
          </button>
        </div>
      )}
    </article>
  );
}
