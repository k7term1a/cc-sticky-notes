# cc-sticky-notes

A Claude Code mod: curiosity questions go to a side pane (`/sticky-note`) instead of the main conversation, and are kept as a tree shared by every session of the project. Plan: [PLAN.md](PLAN.md). What the Mods API really does: [PROBE.md](PROBE.md).

**Pinned to Claude Code 2.1.289** (the Mods API is early access; re-run validate and tests after every upgrade).

## Develop

```bash
claude --plugin-dir .
```

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

```bash
npx -p typescript@5.6 tsc -p .
```

`tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which the engine writes when it loads the mod (git-ignored).

Keys: `TYPESAFE_API_KEY` (Jev routing) and `OPENAI_API_KEY` (optional summary provider). First found wins: the process environment, then `~/.claude/sticky-notes/.env`, then this folder's `.env` (git-ignored). A project's own `.env` is never read. `/sticky-note doctor` shows where each key came from, never its value. Without them the mod still loads: no Jev means everything goes to the main line.

## Layout

- `hooks/register.tsx`: every hook, and `portsOf($)`. Only this file touches `$` (PROBE.md P1).
- `hooks/tree.ts`, `route.ts`, `jev.ts`, `redact.ts`, `digest.ts`, `answer.ts`: logic modules. Pure, or they take `Ports`.
- `hooks/notes.ts`: the flow (route → note → background answer → routing sample).
- `hooks/feedback.ts`: routing samples, `/sticky-note feedback`, `calibrate`.
- `hooks/secrets.ts`: where the keys come from.
- `hooks/pane.tsx`: the pane and the status line under the prompt (`cc-sticky-note <question>`). `/sn` (or `/sticky-note`) opens and closes the pane.
- `probes/m0/`: the M0 probe mod (`cc-sticky-probe`), kept separate.
