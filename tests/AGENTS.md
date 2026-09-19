# tests/AGENTS.md

- When asserting with bun:test: `expect(obj).toMatchObject({ k: expect.stringContaining(...) })` replaces `obj.k` with the asymmetric matcher object. Capture values from `obj` before such assertions, never after.
