/**
 * Shared size limits for uploads and for the model call.
 *
 * These are plain numbers (byte counts and character counts). Both the
 * browser and the server import them so the error messages stay in agreement.
 */

/** Reject the file before parsing when it is larger than this. 10 MB. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Refuse a lease longer than this, even after it has been split into chunks.
 * 200,000 characters is roughly a very long lease, not a book. Splitting
 * helps the model, but it does not make an unbounded document cheap or safe
 * to send.
 */
export const MAX_LEASE_CHARS = 200_000;

/**
 * How much lease text one model call should see.
 *
 * `chunkLease` cuts a longer lease into pieces of about this size, on
 * section boundaries when it can. 8,000 characters is a few pages: enough
 * to hold a whole article, and small enough that a later retrieval step can
 * embed one chunk at a time.
 */
export const MAX_CHUNK_CHARS = 8_000;

/**
 * When a single section is longer than MAX_CHUNK_CHARS, the next piece
 * repeats this many characters from the end of the previous piece.
 * The repeat keeps a sentence that straddles the cut inside at least one chunk.
 */
export const CHUNK_OVERLAP_CHARS = 400;

/**
 * How much lease text one Gemini call should see.
 *
 * This is separate from MAX_CHUNK_CHARS. The chunker default (8,000) is the
 * size a later retrieval step would store. Extraction uses this smaller
 * limit. The instructions pasted in front of the lease are about 4,100
 * characters on their own, so an 8,000-character piece was really a
 * ~12,000-character request, and a whole 10-page lease (about 25,000 to
 * 35,000 characters) was one request of roughly 30,000 to 40,000 characters.
 * Gemini answered those with HTTP 503 UNAVAILABLE and the message
 * "Deadline expired before operation could complete." after several minutes.
 * 4,000 characters is about one to two pages, which the model can finish
 * well inside a minute. A lease that fits in this limit is still one call.
 */
export const MAX_MODEL_BATCH_CHARS = 4_000;

/**
 * How many Gemini calls may be in flight at once.
 *
 * 1 means the next batch waits until the current one finishes. That is
 * slower, and it avoids the 429 Too Many Requests errors that showed up
 * when several batches were sent together. 2 is the highest this should
 * go unless the API key's quota is known to allow more.
 */
export const MODEL_BATCH_CONCURRENCY = 1;
