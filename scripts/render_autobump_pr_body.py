#!/usr/bin/env python3
"""Render the spec-autobump PR body markdown.

Kept out of the workflow's inline shell so the markdown (full of backticks and
`${...}` examples) isn't fighting shell quoting — and so the body is easy to
eyeball and diff. Driven by `.github/workflows/spec-autobump.yml` (ENG-7964).

Reads the captured oasdiff breaking output from a file so the verbatim verdict
lands in the PR. Writes the rendered markdown to stdout.

`--auto-merge` carries the repo's probed `allow_auto_merge` setting rather than
assuming it: it is disabled on this repo, and a body claiming auto-merge was armed
when nothing was would be worse than saying plainly that a human must merge.

Usage:
  render_autobump_pr_body.py --new-tag vX.Y.Z --old-tag vA.B.C \
      --verdict {non-breaking|breaking} --oasdiff-file PATH \
      [--auto-merge true|false]
"""
import argparse
import sys


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--new-tag", required=True)
    ap.add_argument("--old-tag", required=True)
    ap.add_argument("--verdict", required=True, choices=["non-breaking", "breaking"])
    ap.add_argument("--oasdiff-file", required=True)
    ap.add_argument(
        "--auto-merge",
        default="false",
        help="the repo's allow_auto_merge setting, as probed by the workflow",
    )
    args = ap.parse_args()
    auto_merge = args.auto_merge.strip().lower() == "true"

    try:
        with open(args.oasdiff_file) as f:
            oasdiff_out = f.read().strip() or "(no output captured)"
    except OSError:
        oasdiff_out = "(no output captured)"

    out = []
    out.append(
        f"nexus-exchange-api released **{args.new_tag}** "
        f"(was pinned at **{args.old_tag}**). Opened automatically by "
        f"`spec-autobump` (ENG-7964).\n"
    )

    out.append(f"### oasdiff verdict: **{args.verdict}**\n")
    out.append(
        f"Classified `{args.old_tag} -> {args.new_tag}` with "
        f"`oasdiff breaking --fail-on ERR` (the same gate the api repo runs as "
        f'"Classify API changes"). ERR-level changes are breaking; WARN/INFO are '
        f"not.\n"
    )
    out.append("<details><summary>oasdiff breaking output</summary>\n")
    out.append(f"```\n{oasdiff_out}\n```\n")
    out.append("</details>\n")

    out.append("### Applied\n")
    out.append(f"- Bumped `.api-version` to `{args.new_tag}`.")
    out.append('- Updated the bot-managed "currently targets" line in the README.')
    out.append(
        "- Nothing else. No tool was touched and `endpoints.txt` was not "
        "regenerated: if this spec drops an operation a tool implements, the "
        "`spec-drift` check on this PR goes red and a human pushes the tool "
        "changes onto this branch. Green drift is the merge signal."
    )
    out.append(
        "- The README SDK<->spec compatibility table is deliberately untouched: it "
        "records what *released* versions shipped against, so a bare spec release "
        "changes nothing in it. A row is appended when a release goes out.\n"
    )

    out.append("### What verifies this\n")
    out.append(
        "- **`spec-drift`** — the three invariants in "
        "`scripts/check_spec_drift.py`: every operation in `endpoints.txt` exists "
        "in the newly pinned spec, the manifest still matches the per-tool `ops` "
        "declarations, and those declarations still match what each handler "
        "requests. An additive spec change needs no tool edits, so it stays green; "
        "it fails if an implemented operation was removed or renamed (which "
        "oasdiff would have classified as breaking)."
    )
    out.append(
        "- **`drift`** (in CI) — the *lag* check: it requires the pin to equal the "
        "api repo's latest release. It is currently failing on every open PR in "
        "this repo and merging this one is what fixes that."
    )
    out.append(
        "- **CI** — format, lint, typecheck, test on Node 20 and 22.\n"
    )
    out.append(
        "> `spec-drift` is not yet a *required* status check on this repo, so it "
        "does not block a merge on its own. Read it before merging — it is the "
        "check that actually answers whether this pin advance needs code "
        "changes.\n"
    )

    if args.verdict == "non-breaking":
        out.append("### Merge gating (non-breaking)\n")
        if auto_merge:
            out.append(
                "GitHub auto-merge has been **armed** (squash). Arming is not "
                "merging — the PR can only land once the required checks pass and "
                "the **ENG-4149** ruleset bypass for this bot is configured to "
                "satisfy the review rule for pin-bump PRs. Until then it sits "
                "green awaiting the bypass."
            )
        else:
            out.append(
                "**A human must merge this.** `allow_auto_merge` is disabled on "
                "this repo, so auto-merge was not armed — the workflow probed the "
                "setting rather than calling `gh pr merge --auto` and reporting "
                "success over a no-op (ENG-7688 is that failure shape in the "
                "monorepo). Enabling the repo setting is a prerequisite for "
                "unattended landing here, and **ENG-4149** gates it fleet-wide "
                "regardless."
            )
    else:
        out.append("### Merge gating (breaking)\n")
        out.append(
            f"oasdiff flagged an ERR-level (breaking) change, so auto-merge was "
            f"**NOT** armed and would not have been even if the repo allowed it. "
            f"A human owns this: review what `{args.new_tag}` changes, make the "
            f"tool changes it implies (and re-run `npm run spec:drift:write` if "
            f"the operation set moved), plan the package version bump, then merge. "
            f"Labeled `breaking · needs-SDK-update`."
        )

    sys.stdout.write("\n".join(out) + "\n")


if __name__ == "__main__":
    main()
