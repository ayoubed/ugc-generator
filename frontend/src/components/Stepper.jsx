import React from 'react';

const STEPS = [
  { number: 1, title: 'Idea' },
  { number: 2, title: 'Script' },
  { number: 3, title: 'Generate' },
  { number: 4, title: 'Video' },
];

/**
 * Stepper component indicating the 4-step workflow:
 * 1. Idea -> 2. Script -> 3. Generate -> 4. Video
 * @param {number} currentStep - 1 to 4
 * @param {function} onStepClick - Optional callback (stepNumber) => void
 * @param {number} maxReachableStep - Highest step the user may jump to (defaults to currentStep).
 *   Lets people go forward again after stepping back, e.g. from Script straight to their final video.
 */
export default function Stepper({ currentStep = 1, onStepClick, maxReachableStep }) {
  const reachable = Math.max(currentStep, maxReachableStep || currentStep);

  return (
    <nav className="stepper-container" aria-label="Project steps">
      <ol className="stepper-steps">
        {STEPS.map((step, idx) => {
          const isActive = step.number === currentStep;
          const isCompleted = step.number < currentStep;
          const isReachableAhead = step.number > currentStep && step.number <= reachable;
          const isClickable = Boolean(onStepClick) && !isActive && step.number <= reachable;

          let statusClass = 'upcoming';
          if (isCompleted) statusClass = 'completed';
          if (isReachableAhead) statusClass = 'reachable';
          if (isActive) statusClass = 'active';

          const content = (
            <>
              <span className="step-indicator" aria-hidden="true">
                {isCompleted ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <span>{step.number}</span>
                )}
              </span>
              <span className="step-label">{step.title}</span>
            </>
          );

          return (
            <React.Fragment key={step.number}>
              <li className={`step-item ${statusClass}`} aria-current={isActive ? 'step' : undefined}>
                {isClickable ? (
                  <button
                    type="button"
                    id={`stepper-step-${step.number}`}
                    className="step-button"
                    onClick={() => onStepClick(step.number)}
                    aria-label={`Go to step ${step.number}: ${step.title}`}
                  >
                    {content}
                  </button>
                ) : (
                  <span className="step-button is-static">{content}</span>
                )}
              </li>

              {idx < STEPS.length - 1 && (
                <li
                  aria-hidden="true"
                  className={`step-connector ${step.number < currentStep ? 'completed' : ''} ${
                    step.number >= currentStep && step.number < reachable ? 'reachable' : ''
                  }`}
                />
              )}
            </React.Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
