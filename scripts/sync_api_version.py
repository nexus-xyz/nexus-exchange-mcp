#!/usr/bin/env python3
"""Advance the SDK's pinned spec version when nexus-exchange-api releases a newer
spec.

The SDK targets a specific released spec version, pinned in `.api-version`, and
states it in a bot-managed line in README.md. Nothing previously advanced that
pin when the api repo cut a new release, so the SDK silently fell behind. This
script (driven by `.github/workflows/api-version-sync.yml`) is the forward
counterpart to the drift check:

  * the drift check       — does the SDK still match the *pinned* spec? (drift)
  * sync_api_version.py   — has a *newer* spec released than we pin? (lag)

What it does NOT do: edit the historical SDK<->spec compatibility table in the
README. That table records which *shipped* SDK versions targeted which spec, and
a bare spec release doesn't change history — the next SDK release does. So the
bot only bumps `.api-version` and the managed "currently targets" line; the PR it
opens asks a human to review the code impact and append a table row when they cut
the SDK release that ships the bump.

Modes:
  --check            Report whether a newer spec has released. Exit 0 if the pin
                     is current, 3 if it is behind, 1 on error. No files touched.
  --write            If behind, rewrite `.api-version` and the README managed
                     line in place. Idempotent: a no-op when already current.

The latest released tag is read from the public GitHub releases API unless
--latest is given (used by tests and for offline/dry runs). A GITHUB_TOKEN /
GH_TOKEN in the environment is sent as a bearer token to lift the unauthenticated
rate limit; it is optional.

Usage:
  sync_api_version.py --check [--latest vX.Y.Z]
  sync_api_version.py --write [--latest vX.Y.Z]
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
API_VERSION_FILE = os.path.join(REPO, ".api-version")
README = os.path.join(REPO, "README.md")

# The spec repo whose releases drive the pin.
SPEC_REPO = "nexus-xyz/nexus-exchange-api"
LATEST_RELEASE_URL = f"https://api.github.com/repos/{SPEC_REPO}/releases/latest"

# A version tag is `vX`, `vX.Y`, or `vX.Y.Z` (numeric components only). Validated
# strictly before the value is ever used in a URL, a file write, or a branch
# name — a tag coming off the network or out of `.api-version` is untrusted data.
TAG_RE = re.compile(r"^v[0-9]+(\.[0-9]+){0,2}$")

# The README line the bot owns. Everything between the markers is regenerated, so
# the surrounding prose and the historical compatibility table stay human-owned.
MARK_START = "<!-- api-version-sync:start -->"
MARK_END = "<!-- api-version-sync:end -->"
MANAGED_BLOCK_RE = re.compile(
    re.escape(MARK_START) + r".*?" + re.escape(MARK_END), re.DOTALL
)


def fail(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def parse_tag(tag):
    """Return the comparable integer tuple for a validated `vX.Y.Z` tag."""
    if not TAG_RE.match(tag):
        fail(f"not a valid version tag (want vX.Y.Z): {tag!r}")
    return tuple(int(n) for n in tag[1:].split("."))


def version_key(tag):
    # Pad to 3 components so (0, 4) and (0, 4, 0) compare equal.
    parts = parse_tag(tag)
    return parts + (0,) * (3 - len(parts))


def read_pinned():
    try:
        with open(API_VERSION_FILE) as f:
            tag = f.read().strip()
    except OSError as e:
        fail(f"cannot read {API_VERSION_FILE}: {e}")
    if not TAG_RE.match(tag):
        fail(f".api-version must look like vX.Y.Z (got: {tag!r})")
    return tag


def fetch_latest_tag():
    req = urllib.request.Request(LATEST_RELEASE_URL)
    req.add_header("Accept", "application/vnd.github+json")
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        fail(f"GitHub API returned {e.code} for {LATEST_RELEASE_URL}: {e.reason}")
    except urllib.error.URLError as e:
        fail(f"could not reach {LATEST_RELEASE_URL}: {e.reason}")
    tag = data.get("tag_name")
    if not tag:
        fail(f"no tag_name in the latest release of {SPEC_REPO}")
    if not TAG_RE.match(tag):
        fail(f"latest release tag from {SPEC_REPO} is not vX.Y.Z: {tag!r}")
    return tag


def update_readme(new_tag):
    """Rewrite the managed line to point at new_tag. Returns True if README
    changed. Fails loudly if the markers are missing — they are added in the PR
    that introduces this workflow, so their absence is a setup error, not a
    silent no-op."""
    try:
        with open(README) as f:
            text = f.read()
    except OSError as e:
        fail(f"cannot read {README}: {e}")
    if MARK_START not in text or MARK_END not in text:
        fail(
            f"{README} is missing the {MARK_START} / {MARK_END} markers; add the "
            f"managed block under '## API version' so the bot has a line to own."
        )
    block = (
        f"{MARK_START}\n"
        f"This MCP server currently targets Exchange API spec **`{new_tag}`**.\n"
        f"{MARK_END}"
    )
    new_text = MANAGED_BLOCK_RE.sub(lambda _: block, text, count=1)
    if new_text == text:
        return False
    with open(README, "w") as f:
        f.write(new_text)
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="report only; no writes")
    mode.add_argument("--write", action="store_true", help="apply the bump if behind")
    ap.add_argument(
        "--latest",
        metavar="vX.Y.Z",
        help="override the latest tag (default: query the GitHub releases API)",
    )
    args = ap.parse_args()

    pinned = read_pinned()
    latest = args.latest if args.latest else fetch_latest_tag()
    if args.latest and not TAG_RE.match(latest):
        fail(f"--latest is not a valid version tag: {latest!r}")

    behind = version_key(latest) > version_key(pinned)
    ahead = version_key(latest) < version_key(pinned)

    print(f"pinned .api-version: {pinned}")
    print(f"latest {SPEC_REPO} release: {latest}")

    if ahead:
        # The pin is newer than the latest release (e.g. a pre-release bump). Not
        # an error, but surface it — there is nothing to sync forward.
        print("Pin is AHEAD of the latest release; nothing to sync.")
        return

    if not behind:
        print("Pin is up to date.")
        if args.check:
            return
        return

    print(f"Pin is BEHIND: {pinned} -> {latest}")

    if args.check:
        # Distinct exit code so the workflow / a local check can branch on "behind"
        # vs "error" (1) vs "current" (0).
        sys.exit(3)

    with open(API_VERSION_FILE, "w") as f:
        f.write(latest + "\n")
    readme_changed = update_readme(latest)
    print(f"Wrote .api-version = {latest}")
    print(f"README managed line updated: {readme_changed}")


if __name__ == "__main__":
    main()
