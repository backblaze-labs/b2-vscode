# Transfer Helper Architecture

`src/services/fileTransfers.ts` intentionally remains the public facade for
download, upload, and stale transfer cleanup entry points used by commands,
tools, activation, and tests.

The module keeps these flows together because their safety rules are coupled:
destination cleanup has to understand the temporary names created by download
publishing, upload failure cleanup has to share the same timeout policy used by
transfer orchestration, and callers should not need to know which internal
helper owns a particular temp-file convention. The stable API is:

- `downloadStreamToFile`
- `uploadFileFromDisk`
- `cleanupStaleTransferTempFiles`
- `cleanupStaleDestinationTempFiles`
- `cleanupWorkspaceDestinationTempFiles`
- transfer constants and timeout re-exports consumed by tools and tests

Supporting concerns that can be reused safely live outside the facade:

- `pathSafety.ts` owns contained path and real-directory checks.
- `sourceFileIdentity.ts` owns upload source identity construction.
- `transferTimeout.ts` owns stall and fixed-deadline timeout primitives.
- `tempFileManager.ts` owns editor cache lifecycle and startup cache sweeping.

Future refactors should keep the exported facade stable and move only a full
policy boundary at a time, such as destination publishing or unfinished-upload
cleanup, with the corresponding tests moved alongside it.
