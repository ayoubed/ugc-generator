import React from 'react';
import { sceneLabels } from '../utils/projectProgress';

/** Which take of each scene a final video version was stitched from, and what changed since. */
export default function TakesUsed({ video, scenes }) {
  const used = video?.scenes || [];
  if (!used.length) return null;
  const labels = sceneLabels(scenes);
  return (
    <div className="export-takes">
      <h3 className="export-subhead">Takes in this version</h3>
      <ul className="export-take-list">
        {used.map((entry, idx) => {
          const sceneIndex = scenes.findIndex((s) => s.id === entry.sceneId);
          const scene = sceneIndex >= 0 ? scenes[sceneIndex] : null;
          const usedAttempt = entry.attempt ?? null;
          const nowAttempt = scene ? scene.activeAttempt ?? null : null;
          let note = '';
          if (!scene) note = 'Scene deleted since';
          else if (nowAttempt !== usedAttempt) note = nowAttempt ? `Now uses take ${nowAttempt}` : 'Changed since';
          return (
            <li key={`${entry.sceneId}-${idx}`} className={`export-take ${note ? 'is-changed' : ''}`}>
              <span className="export-take-name">Scene {scene ? labels[sceneIndex] : idx + 1}</span>
              <span className="export-take-value">{usedAttempt ? `Take ${usedAttempt}` : 'Original take'}</span>
              {note && <span className="export-take-note">{note}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
