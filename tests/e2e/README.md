# Live e2e: prompt-cache stability

These checks need a real pi run with model access; they are not part of `bun test`.

1. Create a scratch repo with nested instructions:

   ```sh
   mkdir -p /tmp/e2e-repo/tools/chain-solana-qa
   printf 'answers must end with [SOLANA-QA]\n' > /tmp/e2e-repo/tools/chain-solana-qa/AGENTS.md
   printf 'notes line one.\n' > /tmp/e2e-repo/tools/chain-solana-qa/notes.md
   printf 'goals line one.\n' > /tmp/e2e-repo/tools/chain-solana-qa/goals.md
   printf 'limits line one.\n' > /tmp/e2e-repo/tools/chain-solana-qa/limits.md
   ```

2. Run both scenarios (clean and stripped-injection), three processes each
   (fresh, resume, resume again):

   ```sh
   tests/e2e/run-e2e.sh /tmp/e2e-repo zai/glm-5.3-flash

   Three scenarios run: clean (no interference), stripped (a downstream
   extension removes tool-result injections), and errscan (the stripped
   process is killed mid-turn before the pending batch flushes, so the resume
   must deliver it from the session_start scan).
   ```

   `analyze.ts` fails the run if any request is not a strict prefix of the next,
   if an instruction message changes index or hash after appearing, or if the
   stripped scenario persists more than one fallback batch across resumes.

Known boundary (by design): a batch discovered mid-run — the stripped
scenario's first process — is flushed by pi at the end of that agent turn,
so it appears from the next turn (the resume phases) onward.

`custom-tool.ts` registers a `demo_read` tool for exercising non-builtin tool
surfaces: add `-e tests/e2e/custom-tool.ts -t demo_read` to a `pi` invocation.
