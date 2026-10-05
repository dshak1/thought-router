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
