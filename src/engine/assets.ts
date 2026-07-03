/**
 * Decoded background images by id. Render-time asset registry: bytes are
 * session-transient like `mediaBlobs` (OPFS refs arrive in M6); the project
 * document only stores the id.
 */
export const backgroundImages = new Map<string, ImageBitmap>();
