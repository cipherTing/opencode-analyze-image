# Contributing to opencode-analyze-image

This document defines the repository rules for source changes, versioning, packaging, and releases. It applies to the entire repository.

## Project Rules

- Keep the plugin compatible with the supported OpenCode version declared in `package.json`.
- Prefer the existing TypeScript, OpenCode plugin APIs, and npm scripts over new build systems or runtime dependencies.
- Keep changes focused. Do not mix unrelated refactors, formatting churn, or generated files into a feature or release change.
- Do not change session history, user message data, or OpenCode configuration outside this project unless the task explicitly requires it.
- Do not add secrets, API keys, `.env` files, local configuration, credentials, `node_modules`, or machine-specific files to Git.
- Preserve ASCII source files unless a user-facing string or an existing file format requires another character set.

## Versioning

- Use Semantic Versioning with the package version in `package.json` as the source of truth.
- Keep `package-lock.json` synchronized with `package.json`.
- A patch release (`0.1.x`) is for backwards-compatible bug fixes, prompt corrections, compatibility fixes, tests, and documentation updates.
- A minor release (`0.x.0`) may add backwards-compatible user-facing capabilities or configuration fields.
- A major release is required for breaking configuration, installation, runtime, or public API changes.
- Never reuse a published npm version or Git tag.
- The npm version, Git tag, GitHub Release title, and release notes must identify the same version.

## Required Validation

Run these checks before committing a release candidate:

```bash
npm run check
npm pack --dry-run
npm publish --dry-run --access public
```

`npm run check` must pass completely. It covers type checking, bundling, and tests.

For changes that affect installation or packaging, also verify that the package contains the built plugin, configuration example, documentation, and license, and does not contain source-only or machine-specific files.

## Distribution Rules

This project supports two user-facing distribution paths:

1. The npm package, for package-based installation and future ecosystem integration.
2. The prebuilt JavaScript asset attached to the matching GitHub Release, for users who want to install the plugin file without cloning the repository.

Both paths must be built from the same committed source and must provide equivalent server-plugin behavior.

Do not publish a GitHub Release that points to a different npm version. Release assets must be reproducible from the repository and must not contain credentials.

A pushed Git tag is not a GitHub Release. A release task is incomplete until `gh release view <tag>` succeeds and confirms the matching published Release exists. The Release must contain the prebuilt `analyze_image.js` asset. Never leave README or documentation download links pointing to a Release that has not been created.

GitHub Packages is optional and must not be used as a second public distribution channel unless there is a specific requirement. The public npm package is the primary registry distribution.

## Documentation Rules

- Update `README.md` when installation, configuration, supported providers, or user-visible behavior changes.
- Update `docs/README_CN.md` when the same user-facing information changes in the Chinese documentation.
- Document both supported installation paths when they are available: the npm/package path and the prebuilt JavaScript file path.
- Keep documentation focused on what users need to install, configure, and use the plugin. Do not turn the README into an internal implementation guide.
- Configuration examples must use placeholders and must never contain real credentials.

## Release Checklist

Before publishing a version:

- [ ] Confirm the version change is appropriate under the versioning rules.
- [ ] Confirm `package.json` and `package-lock.json` agree.
- [ ] Update user-facing documentation and configuration examples.
- [ ] Run `npm run check`.
- [ ] Inspect `npm pack --dry-run` and `npm publish --dry-run --access public`.
- [ ] Review `git diff` and confirm no secrets or unrelated files are included.
- [ ] Commit the release with a Conventional Commit message, for example `chore: release 0.1.1`.
- [ ] Create the matching annotated tag, for example `v0.1.1`.
- [ ] Push the commit and tag to GitHub.
- [ ] Publish the exact version to npm.
- [ ] Create the matching GitHub Release and attach the prebuilt JavaScript asset.
- [ ] Verify `npm view <package> version` reports the intended version.
- [ ] Verify `gh release view <tag>` succeeds, the Release is published, and it contains `analyze_image.js`.
- [ ] In the final release report, verify npm, the Git tag, the GitHub Release, and the Release asset as separate items.

If npm requires an OTP or passkey, stop at that step and wait for the authorized verification. Do not bypass registry security controls or publish a different version as a workaround.

## Git and Review Discipline

- Use Conventional Commit prefixes such as `feat:`, `fix:`, `docs:`, `test:`, and `chore:`.
- Keep release commits small and auditable.
- Review the staged diff before every commit.
- Do not rewrite or discard unrelated user changes.
- If a release fails after the Git commit or tag has been created, record the exact failure and recover without deleting or reusing the published version.
