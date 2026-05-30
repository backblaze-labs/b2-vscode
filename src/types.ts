/**
 * Extension-level shared types.
 *
 * B2 API data shapes come from `@backblaze-labs/b2-sdk` (e.g. `Bucket`,
 * `FileVersion`, `BucketInfo`). This module holds only types that are specific
 * to the extension's own UI state.
 *
 * @module types
 */

/** Extension-level authentication state, surfaced in the status bar and view. */
export interface B2AuthState {
  isAuthenticated: boolean;
  accountId?: string;
  apiUrl?: string;
  downloadUrl?: string;
  error?: string;
}
