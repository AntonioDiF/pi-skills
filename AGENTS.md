# AGENTS.md

pi-skills: self-contained pi extensions/skills. Each folder under
`extensions/` ships as `index.ts` + `README.md`, no package.json, no
build, no tests. TypeScript is loaded directly by pi; install by
symlinking the folder into `~/.pi/agent/`.

## Commits
- One-line, imperative. No body, no bullet points.
- Identity: Antonio Diaz Flores <wisky.brandy@hotmail.com>

## PR review workflow
- For each review comment: inspect the code first and report
  applicability, validity and change size before implementing.
  The user decides.
- Confirm the commit message and the thread reply with the user
  before committing/posting.
- Verify findings empirically when feasible (local server, node -e).
- After posting, resolve the thread and confirm isResolved.

## GitHub
- gh CLI is authed as AntonioDiF.
- Thread replies: GraphQL mutation addPullRequestReviewThreadReply
  (REST 404s; pass only pullRequestReviewThreadId, a review ID
  makes it silently no-op).

## Style
- Short and concise. No em-dashes, no AI-sounding filler.
