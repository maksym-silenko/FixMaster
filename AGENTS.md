# Agent Guidelines

## Changelog (`CHANGELOG.md`) & Versioning Rules

1. **Always Update the Changelog**:
   - Every time changes (features, fixes, refactors, removals, etc.) are made to the repository, you **must** update `CHANGELOG.md` in the same task.

2. **Versioning & Tagging Policy**:
   - **Do NOT** bump the package version in `package.json` / `package-lock.json` or create git tags unless the user explicitly asks to increase the version or release.
   - When the user has **not** requested a version bump, place all new changelog entries at the top of `CHANGELOG.md` under a `## [Unreleased]` section (creating the section if it does not already exist, or stacking entries into the existing `## [Unreleased]` section).
   - Once the user explicitly asks to bump the version (e.g., to `X.Y.Z`), rename `## [Unreleased]` in `CHANGELOG.md` to `## [X.Y.Z] YYYY-MM-DD` (using the current date), and update the version in `package.json` and `package-lock.json`. If a git tag is requested, follow the repository's tag naming convention (`fixmaster_X_Y_Z`).

3. **Changelog Formatting Conventions**:
   - Follow the [Keep a Changelog](http://keepachangelog.com/) format and match the existing patterns in `CHANGELOG.md`:
     - Release headers: `## [X.Y.Z] YYYY-MM-DD` (or `## [Unreleased]` prior to release).
     - Category subheaders: `### Added`, `### Changed`, `### Fixed`, `### Removed`.
     - Bullet points using `- ` with nested sub-bullets indented by two spaces (`  - `) when providing additional details.
     - Wrap command names, settings keys (e.g., `` `fixmaster.fieldSeparator` ``), and literal values in backticks.
