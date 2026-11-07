# Release process

All packages use the same release version. Update package versions and the Swift-facing documentation, run the Node/Bun/Swift verification matrix, regenerate IDSS schema and commit the lockfile. Run `pnpm build && bash scripts/pack.sh /tmp/idas-packages` to produce tarballs; pnpm converts workspace dependencies to ordinary SemVer ranges.

GitHub releases can attach the resulting tarballs. A normal `v*` GitHub tag does not publish to npm. To enable npm publishing, obtain the package scope, bootstrap ownership of the packages if required, and configure npm trusted publishing for this repository and the `npm.yml` workflow. Set up the GitHub `npm` environment as appropriate. A separate `npm-v<version>` tag triggers the npm workflow, which verifies all package versions and publishes in dependency order with provenance. npm publishes are not atomic; in case of interruption, inspect published versions and resume only unpublished packages.
