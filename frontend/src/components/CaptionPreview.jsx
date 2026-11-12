import React from 'react';
import { useStorageUrl } from '../hooks/useStorageUrl';

/** A frame of a scene with a sample caption, so the styles can be compared before stitching. */
export default function CaptionPreview({ scene, style, text, portrait }) {
  const url = useStorageUrl(scene?.storageRef || scene?.videoUrl || '');
  const words = (text || 'This is how your captions look').split(/\s+/).filter(Boolean);
  const count = style === 'pop' ? 2 : style === 'minimal' ? 5 : 3;
  const sample = words.slice(0, count);
  return (
    <figure className={`cap-preview ${portrait ? 'is-portrait' : 'is-landscape'}`}>
      <div className="cap-preview-frame">
        {url ? <video src={`${url}#t=0.5`} muted playsInline preload="metadata" aria-hidden="true" /> : null}
        {style !== 'none' && (
          <p className={`cap-sample is-${style}`} aria-hidden="true">
            {sample.map((word, i) => (
              <span key={`${word}-${i}`} className={style === 'highlight' && i === sample.length - 1 ? 'is-active' : ''}>
                {word.replace(/[.,;:]+$/, '')}{' '}
              </span>
            ))}
          </p>
        )}
      </div>
      <figcaption className="field-hint">
        {style === 'none' ? 'No captions.' : 'Approximate preview. The final look is set when the video is stitched.'}
      </figcaption>
    </figure>
  );
}
