# Plastic SCM extension for Hunk

This extension lets [Hunk](https://github.com/modem-dev/hunk) review Plastic SCM workspaces. It registers a `plastic` VCS adapter and uses the installed `cm` command-line client.

It supports:

- pending workspace changes, including private files;
- added, changed, deleted, moved, and binary files;
- one Plastic revision or changeset;
- comparisons between two Plastic revisions;
- file and directory filters after `--`;
- exact old and new file contents for Hunk's context expansion;
- `--watch` through a polling signature.

The adapter only runs read commands: `cm status`, `cm diff`, `cm ls`, `cm fileinfo`, and `cm cat`. A single-revision review may also use `cm log` and `cm find` to resolve the parent tree when Plastic reports a directory change. Plastic has no staging area or Git stash, so `--staged` and `hunk stash show` are not supported.

## Requirements

- Hunk 0.21.1 or newer, with extension API v14 or newer
- Plastic SCM's `cm` executable on `PATH`

The extension has no runtime npm dependencies. Bun is only needed for development.

Files are grouped by folder and sorted alphabetically, with subfolders first. Private files appear alongside tracked changes and keep their untracked labels.

Files larger than 1 MB or 20,000 lines stay visible in the file list but are not rendered. The adapter also caps retained source data at 32 MB per review. These limits keep large asset changes from exhausting Hunk's memory and match Hunk's built-in per-file limits.

## Usage

Hunk selects Plastic automatically when it finds `.plastic`. The adapter has a higher same-root detection priority than Git because Plastic workspaces often contain a `.git` directory for other tools.

Review pending changes:

```sh
hunk diff
hunk diff --exclude-untracked
hunk diff -- Source Scripts/build.cs
```

Review one changeset against its parent:

```sh
hunk show cs:101
hunk diff cs:101
```

Compare two changesets:

```sh
hunk diff cs:100 cs:101
```

The extension guarantees `cs:` changeset specifications. Other Plastic object specifications may work for file-only diffs, but they are not supported because Plastic cannot resolve every form to the parent tree needed for directory changes.

To force this adapter in Hunk's configuration, set:

```toml
vcs = "plastic"
```

## Integration tests

The unit suite uses recorded Plastic output and injected command runners, so any contributor can run it without Plastic SCM. A separate opt-in suite calls the real `cm` executable against a workspace you provide:

```sh
PLASTIC_TEST_WORKSPACE=/path/to/workspace bun run test:integration
```

That command checks workspace detection and a pending-change read. Set `PLASTIC_TEST_REF` to test a revision, or set both `PLASTIC_TEST_FROM` and `PLASTIC_TEST_TO` to test a range:

```sh
PLASTIC_TEST_WORKSPACE=/path/to/workspace \
PLASTIC_TEST_REF=cs:101 \
PLASTIC_TEST_FROM=cs:100 \
PLASTIC_TEST_TO=cs:101 \
bun run test:integration
```

The integration suite is not part of public CI because GitHub-hosted runners do not have Plastic SCM or a Plastic server and workspace. CI runs the portable unit tests and smoke-tests installation through Hunk itself.
