/**
 * Maximum number of context (reference) pictures a single scene generation can use,
 * counting video-wide pictures + the scene's own pictures.
 * Fallback only: the real limit comes from the chosen video model (GET /api/models).
 */
export const MAX_REFERENCE_IMAGES = 6;
