import { useEffect, useRef } from 'react';
import { notifyDone } from '../utils/notify';
import { finalVideoVersions, isSceneBusy, sceneTakes } from '../utils/projectProgress';

/**
 * Notifies (when the tab is in the background) as soon as a take, a generate-all run or a
 * final video finishes. Compares each live snapshot with the previous one, so nothing is
 * announced for work that was already done when the page opened.
 */
export function useDoneNotifications(project, scenes) {
  const previous = useRef(null);

  useEffect(() => {
    if (!project) return;
    const now = {
      projectId: project.id,
      scenes: Object.fromEntries(
        (scenes || []).map((s, i) => [s.id, { busy: isSceneBusy(s), takes: sceneTakes(s).length, failed: s.failedAttempt || null, number: i + 1 }])
      ),
      versions: finalVideoVersions(project).length,
      stitching: project.status === 'stitching',
      stitchError: project.stitchError || '',
      run: project.generateAll?.status || '',
    };
    const before = previous.current;
    previous.current = now;
    if (!before || before.projectId !== now.projectId) return;

    const name = project.title || 'Your video';
    const runWasActive = before.run === 'running' || before.run === 'stitching';

    if (now.versions > before.versions) {
      notifyDone('Final video ready', name);
    } else if (before.stitching && !now.stitching && now.stitchError) {
      notifyDone('Stitching failed', name);
    } else if (runWasActive && now.run === 'done') {
      notifyDone('All scenes are ready', name);
    } else if (runWasActive && now.run === 'failed') {
      notifyDone('Generating stopped', project.generateAll?.error || name);
    } else if (!runWasActive || now.run === 'cancelled') {
      // Single takes (during a generate-all run only the end of the run is announced).
      Object.entries(now.scenes).forEach(([id, scene]) => {
        const old = before.scenes[id];
        if (!old || !old.busy || scene.busy) return;
        if (scene.takes > old.takes) notifyDone(`Scene ${scene.number} is ready`, name);
        else if (scene.failed && scene.failed !== old.failed) notifyDone(`Scene ${scene.number} failed`, name);
      });
    }
  }, [project, scenes]);
}
