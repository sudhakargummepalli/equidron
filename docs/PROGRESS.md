# Progress

## Current phase
Phase 0 · Set up, understand, automate checks, on branch `phase-0-setup`.

## Done
- Setup checked: Node 24.21 (22+ needed), npm 11.19, git 2.55; repo is sudhakargummepalli/equidron.
- `node --test`: 59 of 59 pass on PGlite with the scripted AI stand-in.
- CLAUDE.md, docs/ROADMAP.md, docs/PROGRESS.md, docs/DECISIONS.md and the PDF in docs/.
- `.github/workflows/test.yml` runs `npm ci` and `node --test` on Node 22 for every push and pull request.

## How to check
- `npm ci` then `node --test`: all tests pass.
- `node app.js`, then open http://localhost:8000/shop/, /seller/ and /ops/.
- GitHub → Actions: the "Tests" run for 8c8edbd passed (run 39212946058).

## Still open in Phase 0 (needs the owner)
- Open the pull request for `phase-0-setup` (pushed), so Netlify builds a deploy preview.
- Netlify: confirm deploy previews for pull requests are on and production deploys come from main.
- GitHub: protect `main` (pull requests only, the "Tests" check required).

## Next
Phase 1 · Real accounts, roles and an audit trail (closes roadmap gaps 3 and 5).

## Open questions
- None yet.
