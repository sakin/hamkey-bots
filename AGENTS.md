## Pi Durable

Features should fit Pi Durable's documented patterns or extend them through its supported points. If a design pushes against the framework, stop and tell the user before working around it, even if the idea came from the user.

## Secrets

Never read, print, grep, diff or otherwise open `mise.local.toml`, `.env` or `.env.*`. They hold the OpenRouter key, and anything you read enters the transcript. Masking the output is not enough: it has failed before because the key's format did not match the pattern.

You never need their contents. To copy one, use `cp` or `install -m 600`. To check it exists, use `test -f` or `ls`. To check a variable is set, run `mise exec -- sh -c 'test -n "$OPENROUTER_API_KEY"'` and look only at the exit code. `mise.local.toml.example` shows the shape and is safe to read.

If a task seems to require reading one of these files, stop and ask the user.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
