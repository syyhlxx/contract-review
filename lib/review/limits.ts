/**
 * Shared size limits for uploads and for the model call.
 *
 * These are plain numbers (byte counts and character counts). Both the
 * browser and the server import them so the error messages stay in agreement.
 */

/** Reject the file before parsing when it is larger than this. 10 MB. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Reject extracted text longer than this instead of sending it to the model.
 * A chunker for long leases would split the text before this limit matters.
 * 200,000 characters is roughly a long residential lease, not a book.
 */
export const MAX_LEASE_CHARS = 200_000;
