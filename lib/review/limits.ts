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
