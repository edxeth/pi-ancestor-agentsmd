# pi-ancestor-agentsmd

Pi already loads `AGENTS.md` at startup from the current working directory and its parent directories. That covers project-level guidance, but it misses a common case in larger repos: the agent starts at the root, then later reads files inside a more specific area like `frontend/` or `docs/`, where another `AGENTS.md` exists.

This package fills that gap.

It is inspired by OpenCode's instruction-file resolution model: when a file is read, instruction files closer to that file should win over broader project-level ones. OpenCode applies that idea to instruction files such as `AGENTS.md` and `CLAUDE.md`. This package brings the same general behavior to pi for `AGENTS.md`.

## What it does

When pi reads a file below the session root, this extension prepends ancestor `AGENTS.md` files to the `read` result before the file content.

If pi reads:

```text
frontend/src/components/Button.tsx
```

then the model sees content in this order:

1. `frontend/src/components/AGENTS.md` if present
2. `frontend/src/AGENTS.md` if present
3. `frontend/AGENTS.md` if present
4. `frontend/src/components/Button.tsx`

A few rules keep that behavior sane:

- deeper directories come first
- the session root `AGENTS.md` is not re-added, because pi already loaded it at startup
- each injected `AGENTS.md` is only added once per session
- `--no-context-files` disables the feature entirely

## What it looks like in pi

This package does not create a separate visible `read AGENTS.md` tool call.

In the TUI you still see a normal row such as:

```text
read frontend/package.json
```

The injected `AGENTS.md` content appears inside that read result, above the file content.

## Why it is implemented this way

This package does not override pi's `read` tool.

Instead, it patches `read` results in `tool_result`. That keeps it compatible with extensions that also customize `read`, while preserving normal `read` semantics such as `offset` and `limit`.

## Install

```bash
pi install git:github.com/edxeth/pi-ancestor-agentsmd
```

## Testing

```bash
cd ~/.pi/agent/extensions/pi-ancestor-agentsmd
bun test tests/*.test.ts
```

## Layout

- `src/index.ts` — extension entrypoint
- `src/core.ts` — helper logic
- `tests/core.test.ts` — unit tests

## Compatibility

This package was refactored to avoid owning the `read` tool, so it can coexist with extensions such as `pi-multi-modal` that also customize read behavior.

## Package-style loading

The package uses a `package.json` pi manifest:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```
