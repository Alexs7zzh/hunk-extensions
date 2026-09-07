# Hunk extensions

A collection of extensions for [Hunk](https://github.com/modem-dev/hunk). Hunk installs the repository directly from Git, then loads each top-level folder that declares a `hunk` manifest.

## Extensions

- [Plastic SCM](plastic/README.md) adds pending-change, revision, range, path-filter, exact-source, and watch support for Plastic workspaces.

## Install

Install the collection from GitHub:

```sh
hunk extension install Alexs7zzh/hunk-extensions
```

New Hunk sessions load every extension in the collection automatically. To follow changes on the default branch, update the managed copy after a new commit lands:

```sh
hunk extension update hunk-extensions
```

For a reproducible install, pin a release tag:

```sh
hunk extension install Alexs7zzh/hunk-extensions@v0.1.0
```

Pinned installs stay on that tag until they are removed and installed again with a different source or ref.

## Develop locally

Install the development tools and run the checks:

```sh
bun install --frozen-lockfile
bun run check
bun run test:install
```

Hunk executes extension TypeScript directly, so there is no build output. To load this checkout for one review, run Hunk inside a supported workspace:

```sh
hunk diff --extension /path/to/hunk-extensions
```

The explicit checkout takes precedence over the managed install for that session.

The optional Plastic integration suite uses a real workspace and the installed `cm` command. See the [Plastic extension documentation](plastic/README.md#integration-tests) for its environment variables.

## Releases

The collection uses one version and Git tag for all extensions. Update the versions in the root and extension manifests, commit the change, then create and push a matching `v*` tag. The release workflow checks the tag, runs the same CI suite, smoke-tests Hunk's managed installer, and creates a GitHub release with generated notes.

## License

[MIT](LICENSE)
