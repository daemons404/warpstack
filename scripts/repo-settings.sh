#!/bin/sh
# The release repository's settings, as code (Phase 3). Prints what it would change; with
# --apply, changes them through the GitHub API with your `gh` login (you need admin on the repo).
#
#   sh scripts/repo-settings.sh                 # dry run against daemons404/warpstack
#   sh scripts/repo-settings.sh --apply
#   REPO=owner/name sh scripts/repo-settings.sh --apply
#
# What it sets:
# - main: changes only through PRs; green `check` and `workflows`; one approving review from a
#   code owner; stale approvals dismissed; signed commits; linear history; no force pushes or
#   deletion. Repository admins may bypass the rules on a PR (needed while there's one
#   maintainer, who can't approve their own PR). While the repository is private, admins may
#   also push to main directly: before launch its history is replaced by one commit anyway.
#   GitHub logs every bypass.
# - Actions: the token is read-only by default and can't approve PRs; only GitHub's actions and
#   the two third-party ones the workflows use may run, pinned to a full commit; outside
#   contributors' PR runs need approval (public only).
# - Security: Dependabot alerts and security updates, and private vulnerability reporting
#   (public only). Run it again after making the repository public.
# - Contributions: issues are off, and only collaborators can open pull requests, so the
#   repository stays quiet while one person maintains it. Security reports still arrive
#   privately (SECURITY.md).
set -eu

REPO=${REPO:-daemons404/warpstack}
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

run() { # method path [json body]
  if [ "$APPLY" = 1 ]; then
    if [ $# -ge 3 ]; then printf '%s' "$3" | gh api -X "$1" "repos/$REPO${2:+/$2}" --input - >/dev/null
    else gh api -X "$1" "repos/$REPO${2:+/$2}" >/dev/null; fi
    echo "  done: $1 $2"
  else
    echo "  would: $1 $2"
    [ $# -ge 3 ] && printf '%s\n' "$3" | sed 's/^/    /'
  fi
  return 0
}

# Some settings exist only for public repositories: approving outside contributors' fork PRs
# (only collaborators can fork a private one) and private vulnerability reporting.
private=$(gh api "repos/$REPO" --jq .private)
echo "Repository $REPO ($([ "$APPLY" = 1 ] && echo applying || echo dry run); $([ "$private" = true ] && echo private || echo public))"

# Status checks are the job names in .github/workflows/check.yml. The rust and swift workflows
# run only when their paths change, so they can't be required: a PR that skips them would wait
# forever. They still block a merge when they run and fail, through the PR's checks.
# Admins: direct pushes while private, PRs only once public.
bypass=$([ "$private" = true ] && echo always || echo pull_request)
RULESET='{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [ { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "'"$bypass"'" } ],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    { "type": "required_signatures" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 1,
        "require_code_owner_review": true,
        "dismiss_stale_reviews_on_push": true,
        "require_last_push_approval": true,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash", "rebase"] } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "check", "integration_id": 15368 },
          { "context": "workflows", "integration_id": 15368 } ] } }
  ]
}'

existing=$(gh api "repos/$REPO/rulesets" --jq '.[] | select(.name == "main") | .id' 2>/dev/null || true)
if [ -n "$existing" ]; then run PUT "rulesets/$existing" "$RULESET"
else run POST rulesets "$RULESET"; fi

run PATCH "" '{ "has_issues": false, "pull_request_creation_policy": "collaborators_only" }'

run PUT actions/permissions/workflow '{ "default_workflow_permissions": "read", "can_approve_pull_request_reviews": false }'
run PUT actions/permissions '{ "enabled": true, "allowed_actions": "selected", "sha_pinning_required": true }'
run PUT actions/permissions/selected-actions '{ "github_owned_allowed": true, "verified_allowed": false, "patterns_allowed": ["pnpm/action-setup@*", "EmbarkStudios/cargo-deny-action@*"] }'
[ "$private" = true ] || run PUT actions/permissions/fork-pr-contributor-approval '{ "approval_policy": "all_external_contributors" }'

[ "$private" = true ] || run PUT private-vulnerability-reporting
run PUT vulnerability-alerts
run PUT automated-security-fixes

[ "$APPLY" = 1 ] || echo "Dry run: nothing changed. Run with --apply to change these settings."
