// Asserts the live prompt-cache invariants captured by probe.ts:
//  1. within and across phases, each provider request extends the previous
//     one as a strict prefix (append-only stream; no moved or rebuilt messages)
//  2. instruction-bearing messages keep a fixed index and hash once present
//  3. per scenario, the persisted fallback batch count matches the expectation
// Usage: bun tests/e2e/analyze.ts <log-dir> <sessions-base-dir>
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const logDir = process.argv[2];
const sessionsBase = process.argv[3];
if (!logDir || !sessionsBase) throw new Error("usage: bun analyze.ts <log-dir> <sessions-base-dir>");

let failed = false;
const fail = (msg: string) => {
	failed = true;
	console.error("FAIL: " + msg);
};

// Scenario -> expected persisted fallback batches at the end of the run.
const expectedBatches: Record<string, number> = { clean: 0, stripped: 1, errscan: 1 };
// Scenarios whose resumed phases must already carry an instruction message
// (the batch reaches the model from the next turn onward).
const requiresBatchFromPhase2 = new Set(["stripped", "errscan"]);

const scenarios = new Map<string, { idx: number; hash: string }>();
const lastRequestByScenario = new Map<string, string[]>();

for (const file of readdirSync(logDir).filter((f) => f.endsWith(".jsonl")).sort()) {
	const scenario = file.replace(/-[0-9]+\.jsonl$/, "");
	const phase = Number(file.match(/-(\d+)\.jsonl$/)?.[1] ?? 0);
	const reqs = readFileSync(path.join(logDir, file), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l))
		.filter((e) => e.kind === "provider_request");
	let instrHash: string | undefined;
	let instrIdx: number | undefined;
	for (let i = 0; i < reqs.length; i++) {
		const messages = reqs[i].messages as Array<{ hash: string; preview?: string }>;
		const idx = messages.findIndex((m) => typeof m.preview === "string" && m.preview.includes("<project_instructions"));
		if (idx >= 0) {
			const hash = messages[idx].hash;
			if (instrHash !== undefined && (idx !== instrIdx || hash !== instrHash)) {
				fail(`${file} req#${i + 1}: instruction message moved (idx ${instrIdx}->${idx} or hash changed)`);
			}
			const seen = scenarios.get(scenario);
			if (seen === undefined) scenarios.set(scenario, { idx, hash });
			else if (seen.idx !== idx || seen.hash !== hash) {
				fail(`${file} req#${i + 1}: instruction message changed across processes (idx ${seen.idx}->${idx} or hash changed)`);
			}
			instrHash = hash;
			instrIdx = idx;
		} else if (requiresBatchFromPhase2.has(scenario) && phase >= 2) {
			fail(`${file} req#${i + 1}: scenario ${scenario} resumed without the fallback batch`);
		}
		const curHashes = messages.map((m) => m.hash);
		if (i > 0) {
			const prev = (reqs[i - 1].messages as Array<{ hash: string }>).map((m) => m.hash);
			let lcp = 0;
			while (lcp < prev.length && lcp < curHashes.length && prev[lcp] === curHashes[lcp]) lcp++;
			if (lcp !== prev.length || curHashes.length < prev.length) {
				fail(`${file} req#${i} -> req#${i + 1}: previous request is not a strict prefix (lcp ${lcp}/${prev.length})`);
			}
		}
		const prior = lastRequestByScenario.get(scenario);
		if (prior) {
			let lcp = 0;
			while (lcp < prior.length && lcp < curHashes.length && prior[lcp] === curHashes[lcp]) lcp++;
			if (lcp !== prior.length || curHashes.length <= prior.length) {
				fail(`${file} req#${i + 1}: first request of the phase does not strictly extend the previous phase last request (lcp ${lcp}/${prior.length})`);
			}
		}
		lastRequestByScenario.set(scenario, curHashes);
	}
	console.log(`checked ${file}: ${reqs.length} requests`);
}

for (const [scenario, expected] of Object.entries(expectedBatches)) {
	const dir = path.join(sessionsBase, scenario);
	const sessionFiles = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	if (sessionFiles.length !== 1) {
		fail(`scenario ${scenario}: expected exactly one session file, found ${sessionFiles.length}`);
		continue;
	}
	const batches = readFileSync(path.join(dir, sessionFiles[0]!), "utf8")
		.split("\n")
		.filter((l) => l.includes('"custom_message"') && l.includes("ancestor-agentsmd")).length;
	console.log(`scenario ${scenario}: ${batches} persisted fallback batches (expected ${expected})`);
	if (batches !== expected) {
		fail(`scenario ${scenario}: expected ${expected} persisted fallback batches, found ${batches}`);
	}
}

if (failed) process.exit(1);
console.log("E2E OK: request prefixes append-only, instruction messages stable, batch counts as expected");
