# pi-ancestor-agentsmd

Pi already loads `AGENTS.md` at startup from the current working directory and its parent directories. That covers project-level guidance, but it misses a common case in larger repos: the agent starts at the root, then later reads files inside a more specific area like `frontend/` or `docs/`, where another `AGENTS.md` exists.

This package fills that gap.

It is inspired by OpenCode's instruction-file resolution model: when a file is read, instruction files closer to that file should win over broader project-level ones. OpenCode applies that idea to instruction files such as `AGENTS.md` and `CLAUDE.md`. This package brings the same general behavior to pi for `AGENTS.md`.

Beyond AGENTS.md, the package also supports [DESIGN.md](https://designmd.ai/what-is-design-md) — the Google Stitch open-source design system format. Two opt-in environment variables enable injecting DESIGN.md into the agent's context, either at startup (root file) or dynamically via ancestor walking.

## What it does

### AGENTS.md

When pi reads a file below the session root, this extension prepends ancestor `AGENTS.md` files to the `read` result before the file content.

If pi reads:

```text
frontend/src/components/Button.tsx
```

then the model sees injected context before the file content, ordered from closest nested file to broadest nested file:

1. `frontend/src/components/AGENTS.md` if present
2. `frontend/src/AGENTS.md` if present
3. `frontend/AGENTS.md` if present
4. `frontend/src/components/Button.tsx`

A few rules keep that behavior sane:

- closer directories come first, matching OpenCode's nearby-instruction order
- the session root `AGENTS.md` is not re-added, because pi already loaded it at startup
- each injected file is only added once per session, then becomes eligible again after compaction/restart
- symlink escapes outside the session root are rejected
- large context files are truncated safely
- `--no-context-files` disables the entire extension

### DESIGN.md (opt-in via env vars)

Root injection — appends `cwd/DESIGN.md` content to the system prompt before the first LLM call.
Ancestor injection — walks ancestor directories for `DESIGN.md` files (same hierarchy rules as AGENTS.md).

Both are disabled by default. Enable via:

```bash
# Inject root cwd/DESIGN.md into system prompt at session start
PI_ROOT_DESIGN_MD=1

# Walk ancestor dirs for DESIGN.md on file reads
PI_ANCESTOR_DESIGN_MD=1

# Both work independently and can be combined
PI_ROOT_DESIGN_MD=1 PI_ANCESTOR_DESIGN_MD=1
```

Root DESIGN.md is injected via the `before_agent_start` event — no file read is needed. The model sees it from the very first turn. Ancestor DESIGN.md follows the same walk-up rules as AGENTS.md (closest first, skip root, dedup'd per session).

## What it looks like in pi

This package does not create a separate visible `read AGENTS.md` or `read DESIGN.md` tool call.

In the TUI you still see a normal row such as:

```text
read frontend/package.json
```

The injected content appears inside that read result, above the file content. Root DESIGN.md content appears in the system prompt — no TUI-visible tool call at all.

## Why it is implemented this way

This package does not override pi's `read` tool.

Instead, it patches `read` results in `tool_result`. That keeps it compatible with extensions that also customize `read`, while preserving normal `read` semantics such as `offset` and `limit`.

For root DESIGN.md injection, it hooks `before_agent_start` and appends to the system prompt — no file read, no visible tool call, no token waste.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_ROOT_DESIGN_MD` | `0` | Inject `cwd/DESIGN.md` into system prompt at startup |
| `PI_ANCESTOR_DESIGN_MD` | `0` | Inject ancestor `DESIGN.md` files on file reads |
| `PI_ANCESTOR_AGENTS_MD` | `1` | Inject ancestor `AGENTS.md` files on file reads (set to `0` to disable) |

## CLI flags

| Flag | Effect |
|------|--------|
| `--no-context-files`, `-nc` | Disables the entire extension (AGENTS.md + DESIGN.md both) |

## Slash commands

| Command | Effect |
|---------|--------|
| `/nested-context-files` | Writes a debug session entry listing injected `AGENTS.md` and `DESIGN.md` files |

## Install

```bash
pi install git:github.com/edxeth/pi-ancestor-agentsmd
```

## Testing

```bash
cd ~/.pi/agent/extensions/pi-ancestor-agentsmd
bun test tests/*.test.ts
```

## License

MIT

