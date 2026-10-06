# thought-router

Capture a thought on the phone, pull it on the computer. Pull-based relay, no server, no tunnel.

- `docs/`: static PWA served by GitHub Pages. No secrets in this repo. The phone keeps a fine-grained GitHub token in localStorage.
- Phone writes `thoughts/<uuid>.json` to the private repo `dshak1/thought-inbox` via the GitHub contents API (create-only, idempotent).
- `bin/thought-pull`: stdlib Python. Clones or updates the inbox repo with git over HTTPS (outbound only), appends new items to `~/.local/share/thought-router/inbox.jsonl`, pushes `pulled/<uuid>` markers.
- `bin/thought-inbox`: lists items, newest first. Options: `-n N`, `--full`, `--json`.
- `tools/e2e.mjs`: headless Chrome test over a CDP pipe (no listening port).

Personal thoughts only. No work-confidential content.

## Phone setup link
`https://dshak1.github.io/thought-router/#t=<token>` stores the token and clears the fragment.
Token: fine-grained PAT, repository access only `thought-inbox`, Contents read and write.

## Routing to a herdr tab
`thought-route` stages a thought as an editable draft (no Enter) only when it starts with `@<tab>`,
for example `@rema-design add a dark mode toggle`. Unaddressed thoughts go nowhere and no model reads them.
Only idle tabs receive drafts; others stay queued. Default is a dry run; `--stage` applies it.

## Session hook
`bin/thought-hook` is wired to Claude Code `SessionStart` and `UserPromptSubmit` in `~/.claude/settings.json`
(backup: `settings.json.bak-thought-router`). It pulls (at most every 90 s), and shows each new thought once with
instructions to propose actions and wait for a yes. No daemon. Remove the two `thought-hook` entries to undo.

## Meta-window
No fixed commands. Each new thought is shown to the receiving session, which analyzes it and acts per `META.md`
(vault, Notion, herdr drafts, Telegram, questions), asking first only for outward or destructive actions.

## Scan handwritten notes
"Scan notes" on the phone page takes a video (or photos). The phone keeps one sharp frame per distinct page
(ink-overlap comparison, repeats dropped), shows each as a note page with the usual SAVED, RECEIVED, PULLED states,
and uploads image first, JSON second. `thought-pull` copies images to `~/.local/share/thought-router/attachments/`.
`thought-transcribe` reads each page with a small vision model (`claude -p --model sonnet`, Read tool only; haiku failed with "Prompt is too long" on images here) and writes
`transcripts/<id>.txt` plus `notes/<scan>.md`. Thresholds are untuned on real handwriting; override with localStorage `tr_scan`.
Test: `tools/e2e-scan.mjs` (synthetic video, real private repo, CLEAN=1 removes test pages).
