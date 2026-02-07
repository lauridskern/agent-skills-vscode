# Changelog

All notable changes to the Agent Skills extension will be documented in this file.

## [0.1.14] - 2026-02-07

### Added

- Added quick actions in the Installed tab toolbar to check for updates and update all skills
- Added update availability indicators in the Installed list
- Added progress notifications when checking and updating skills

### Changed

- Changed Browse to load from the full all-time skills feed with infinite loading
- Changed the default tab to Browse when no skills are installed
- Changed shared install labels to be clearer: `Shared (Codex, Gemini, OpenCode)`
- Changed remove behavior so deleting from a specific row removes that specific installation, while "Remove all" removes all installations of that skill

## [0.1.13] - 2026-02-06

### Fixed

- Use `npx skills add` (current CLI) instead of legacy `npx add-skill`
- Align CLI agent flags and telemetry opt-out env vars with upstream skills CLI
- Align install path handling for shared `.agents/skills` and global OpenCode/Antigravity locations
- Fix incorrect Installed tab duplication where shared `.agents/skills` entries appeared as Codex/Gemini/OpenCode
- Show shared installs under dedicated Universal groups (`Project / Universal`, `User / Universal`)

## [0.1.12] - 2026-02-06

### Fixed

- Fix Browse tab after skills.sh removed `/api/skills` endpoint
- Fetch all skills from homepage RSC payload instead of removed API
- Search still uses `/api/search` endpoint which remains available

## [0.1.11] - 2026-02-04

### Changed

- Simplify skill matching to use marketplace `id` directly instead of source + name

## [0.1.10] - 2026-02-04

### Fixed

- Fix duplicate skill names incorrectly showing as installed (now matches by source + name)
- Track installed skill sources for accurate reinstall detection

## [0.1.9] - 2026-02-04

### Fixed

- Update API types to match new skills.sh schema (added `skillId`, renamed `topSource` to `source`)

## [0.1.8] - 2026-01-31

### Added

- Add support for the actual skills.sh API now providing over 30k skills instead of just the top 200
- Refactoring of the codebase

## [0.0.1] - 2026-01-24

### Added

- Initial release
- Browse skills from skills.sh directory
- Install skills to Cursor, Claude Code, Codex, Gemini CLI, OpenCode, and Antigravity
- Project-level and global installation scopes
- Symlink and copy installation methods
- View and manage installed skills
- Search and filter skills
- Reinstall and remove functionality
- Cached browse results for faster loading
- Telemetry opt-in/opt-out during installation
