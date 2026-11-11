// Browser notifications for work that finishes while the tab is in the background.
// They only fire while the app is open in some tab; nothing is sent when it is closed.

function supported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/** Ask once, from a click (browsers ignore requests that don't come from a user action). */
export function askToNotify() {
  if (!supported() || Notification.permission !== 'default') return;
  try {
    Notification.requestPermission();
  } catch {
    // Older browsers throw instead of returning a promise; notifications just stay off.
  }
}

/** Shows a notification when the tab is hidden and the user allowed it. */
export function notifyDone(title, body = '') {
  if (!supported() || Notification.permission !== 'granted' || !document.hidden) return;
  try {
    const note = new Notification(title, { body, tag: title });
    note.onclick = () => {
      window.focus();
      note.close();
    };
  } catch {
    // Some mobile browsers only allow notifications from a service worker.
  }
}
