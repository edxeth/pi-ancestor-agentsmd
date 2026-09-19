# tests/e2e/AGENTS.md

- When spawning a live child `pi` from inside a running pi session: strip the inherited environment (`env -i HOME="$HOME" PATH="$PATH" pi ...`). Inherited session env vars abort every tool call in the child.
