// Shared setup for component tests: unmount what each test rendered, and keep Firebase out.
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => cleanup());

// No test talks to Firebase. Modules that need data are mocked in the test that uses them.
vi.mock('../services/firebase', () => ({ auth: { currentUser: null }, db: {}, storage: {}, googleProvider: {} }));

// jsdom has no scrolling or media playback.
Element.prototype.scrollIntoView = () => {};
window.HTMLMediaElement.prototype.load = () => {};
window.HTMLMediaElement.prototype.pause = () => {};
window.HTMLMediaElement.prototype.play = () => Promise.resolve();

// jsdom has no pointer events; the editor's trim handles use them.
if (!window.PointerEvent) {
  window.PointerEvent = class PointerEvent extends window.MouseEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  };
}
