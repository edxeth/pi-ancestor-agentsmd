# pi-ancestor-agentsmd

## 🌐 **Join the Community**

> [!NOTE]
> **Building with AI doesn’t have to be a solo grind.**  
> Join our Discord community to meet other people exploring the latest models, tools, workflows, and ideas: **https://discord.gg/whhrDtCrSS**
>
> We talk about what’s new, what’s useful, and what’s actually worth paying attention to in AI.  
> *And if you want more than conversation,* members also get access to **heavily discounted AI products and services** — including deals on tools like **ChatGPT Plus** and more for just a few dollars.

Automatically load project instructions from `AGENTS.md` and design guidance from `DESIGN.md`.

## AGENTS.md

Pi loads `AGENTS.md` from the directory where you start it and its parent directories. Those files provide general project rules. This extension adds more specific rules from subfolders, such as `frontend/` or `docs/`, when the agent works there.

The extension finds file paths in tool requests, including shell commands. It loads `AGENTS.md` files between the requested file and the starting directory, with the closest directory first. It does not add the starting directory's `AGENTS.md` again because Pi already loads it.

For example, when the agent reads `frontend/src/components/Button.tsx`, it receives the following, in order:

1. `frontend/src/components/AGENTS.md`, if present.
2. `frontend/src/AGENTS.md`, if present.
3. `frontend/AGENTS.md`, if present.
4. The contents of `frontend/src/components/Button.tsx`.

Each instruction file applies to its own directory and the subfolders below it. Rules in the file can narrow that scope further. More specific instructions take precedence over conflicting project-wide rules, following OpenCode's nearby-file approach.

Repeated tool calls do not keep adding the same instruction files. The extension can load them again after Pi shortens the conversation or restarts. It loads only the exact filename `AGENTS.md` from subfolders, not `AGENTS.override.md`, `AGENTS.MD`, `CLAUDE.md`, or `CLAUDE.MD`. Pi's startup rules for those names are unchanged.

This feature is on by default. Set `PI_ANCESTOR_AGENTS_MD=0` to disable it.

## DESIGN.md

[DESIGN.md](https://designmd.ai/what-is-design-md) is the Google Stitch format for project design guidance. This extension supports a file in the starting directory and files in subfolders. The two options work independently, and both are off by default.

### Design guidance for the whole session

With `PI_ROOT_DESIGN_MD=1`, the agent receives `DESIGN.md` from the directory where you start Pi. The session saves one copy at startup and keeps it unchanged. Resuming the session or returning to an earlier point in the conversation keeps the same copy.

A fork, a separate session copied from this conversation, also keeps that copy. If Pi shortens a long conversation, the saved guidance stays available. Start a new session to use file edits or changes to `PI_ROOT_DESIGN_MD`.

If this option is off at startup, enabling it later does not change the session. An absent, empty, or unreadable file leaves the session without this design guidance. An unreadable file also produces a warning.

If a fork cannot recover its saved guidance, Pi warns and continues without it. It does not substitute the current file, which can contain different rules.

### Design guidance for subfolders

With `PI_ANCESTOR_DESIGN_MD=1`, the extension loads `DESIGN.md` files as tools use files in subfolders. It follows the same directory order and repeat-loading rules as `AGENTS.md`. More specific design rules take precedence for interface work in that part of the project.

This option skips the starting directory's `DESIGN.md`. Enable `PI_ROOT_DESIGN_MD` separately to use that file as well. Only the exact filename `DESIGN.md` is recognized.

## What you see in Pi

The extension does not create a separate visible `read AGENTS.md` or `read DESIGN.md` tool call. You still see the tool call that the agent requested, such as:

```text
read frontend/package.json
```

The nearby instructions appear above the requested file content in the tool result. Design guidance from the starting directory is available without a visible file read. For troubleshooting, run `/nested-context-files` to record the files that the extension tracks in the session log.

These limits apply:

- Instruction files load in full, even when the agent reads only part of the requested file. Large instruction files use more of the model's available input space.
- Links cannot make the extension load files outside the starting directory.
- Instructions from subfolders arrive after a tool runs. The agent can therefore change a file before it sees those instructions.

## Install and configuration

This extension requires pi 0.99.2 or newer. Install it with:

```bash
pi install git:github.com/edxeth/pi-ancestor-agentsmd
```

Set these environment variables before starting Pi:

| Variable | Default | Effect |
|----------|---------|--------|
| `PI_ANCESTOR_AGENTS_MD` | `1` | Load `AGENTS.md` files from subfolders. |
| `PI_ROOT_DESIGN_MD` | `0` | Use `DESIGN.md` from the starting directory for the whole session. |
| `PI_ANCESTOR_DESIGN_MD` | `0` | Load `DESIGN.md` files from subfolders. |

Use `1` to enable a feature and `0` to disable it. To enable both `DESIGN.md` options, start Pi with:

```bash
PI_ROOT_DESIGN_MD=1 PI_ANCESTOR_DESIGN_MD=1 pi
```

To disable the entire extension, pass `--no-context-files` or `-nc` when you start Pi.

---

Run the tests from the project directory:

```bash
bun test tests/*.test.ts
```

License: MIT.
