# Task 1 Report: Character Catalog and Defensive Resolver

## Scope

Implemented the Task 1 catalog and resolver boundary in `client.js`, plus the VM loader tests in `test/moony-series.test.mjs`. Existing DSH loading, injection, slot, backend, index, lib, and Cordis contracts were left unchanged.

## Implementation

- Added frozen `MOONY_STATUS` with `idle`, `running`, `waiting`, `failed`, and `review` signal definitions.
- Added frozen seven-character `MOONY_CATALOG` in the required order: `classic`, `pulse`, `echo`, `drift`, `spark`, `chorus`, `hush`.
- Added frozen ID lookup and `getMoony(id)`, with invalid IDs falling back to Classic.
- Added `resolveMoonyState(input)` with defensive object/status/media normalization:
  - unknown or malformed status -> `idle`
  - blank/non-string media URL -> `null` and `blank`
  - non-blank media URL -> trimmed URL and `media`
  - unknown character ID -> Classic
- Exported `MOONY_CATALOG`, `MOONY_STATUS`, `getMoony`, and `resolveMoonyState` through the existing module exports.

## TDD Evidence

1. Added the prescribed VM loader and three behavior tests before production changes.
2. Ran `node --test test/moony-series.test.mjs`; it failed because the new exports were absent.
3. Added the minimal catalog/resolver implementation.
4. Ran focused tests and the existing slot loader tests:
   `node --test test/moony-series.test.mjs test/client-slots-injection.test.mjs`
   Result: 6 passed, 0 failed.
5. Ran syntax and diff checks:
   `git diff --check && npm run check`
   Result: exit 0.

## Review Notes

The only unrelated worktree item is the pre-existing untracked `package-lock.json`; it was not staged or modified. No service process or runtime backend was touched.
