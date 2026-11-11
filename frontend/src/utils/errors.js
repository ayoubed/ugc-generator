/** Turns an API or network error into a message people can act on. */
export function friendlyError(err) {
  const message = err?.message || '';
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "Couldn't reach the server. Check your connection and try again.";
  }
  return message || 'Something went wrong. Try again.';
}
