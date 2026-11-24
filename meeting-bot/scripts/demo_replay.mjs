#!/usr/bin/env node
/**
 * One-command synthetic media replay for NAACL demo reviewers.
 *
 * Usage:
 *   node scripts/demo_replay.mjs
 *   node scripts/demo_replay.mjs --dry-run
 *   ECHO_BASE_URL=http://127.0.0.1:3000 node scripts/demo_replay.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const demoRoot = path.resolve(root, "demo_replay");
const manifestPath = path.join(demoRoot, "manifest.json");
const BASE = process.env.ECHO_BASE_URL ?? "http://127.0.0.1:3000";
const dryRun = process.argv.includes("--dry-run");

function fail(message) {
  console.error(`FAIL\t${message}`);
  process.exit(1);
}

async function get(pathname) {
  const res = await fetch(`${BASE}${pathname}`);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function post(pathname, body, timeoutMs = 180_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

if (!fs.existsSync(manifestPath)) {
  fail(`missing manifest: ${manifestPath}`);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const slideRel = manifest.slide || "fixtures/slide.jpg";
const slidePath = path.resolve(demoRoot, slideRel);
if (!fs.existsSync(slidePath)) {
  fail(`missing slide fixture: ${slidePath}`);
}

console.log(`ECHO synthetic media replay`);
console.log(`  base=${BASE}`);
console.log(`  dryRun=${dryRun}`);
console.log(`  slide=${slidePath}`);
console.log(`  questions=${(manifest.questions || []).length}`);

if (dryRun) {
  console.log("DRY-RUN\tfixtures OK");
  try {
    const { status, json } = await get("/demo/replay/health");
    if (status !== 200) {
      fail(`/demo/replay/health HTTP ${status}`);
    }
    console.log(
      `PASS\thealth enabled=${json.enabled} ai.enabled=${json.ai?.enabled ?? "?"}`,
    );
    if (!json.enabled) {
      console.log(
        "WARN\tDEMO_REPLAY_ENABLED is false — set it true and restart npm start before a live replay",
      );
    }
    console.log("=== dry-run complete ===");
    process.exit(0);
  } catch (error) {
    fail(`server unreachable at ${BASE}: ${error}`);
  }
}

const streamId = `${manifest.streamId || "demo-replay"}-${Date.now()}`;
const now = Date.now();
const frameTs = now + (manifest.frameTimestampOffsetMs ?? -15_000);

{
  const { status, json } = await post("/demo/replay/reset", { streamId });
  if (status === 403) {
    fail(json.error || "DEMO_REPLAY_ENABLED=false");
  }
  if (status !== 200 || !json.ok) {
    fail(`reset HTTP ${status} ${json.error || ""}`);
  }
  console.log(`PASS\treset streamId=${streamId}`);
}

{
  const { status, json } = await post("/demo/replay/frame", {
    streamId,
    meetingUuid: manifest.meetingUuid || "demo-replay",
    filePath: slidePath,
    frameId: 1,
    uniqueFrameId: 1,
    timestamp: frameTs,
  });
  if (status !== 200 || !json.ok) {
    fail(`frame HTTP ${status} ${json.error || ""}`);
  }
  console.log(`PASS\tframe ${path.basename(slidePath)}`);
}

{
  const { status, json } = await post("/demo/replay/transcript", {
    streamId,
    meetingUuid: manifest.meetingUuid || "demo-replay",
    baseTimestamp: frameTs + 1_000,
    segments: manifest.transcript || [],
  });
  if (status !== 200 || !json.ok) {
    fail(`transcript HTTP ${status} ${json.error || ""}`);
  }
  console.log(`PASS\ttranscript segments=${json.count}`);
}

const askedAt = now;
for (const item of manifest.questions || []) {
  const question = item.question;
  const id = item.id || "ask";
  process.stdout.write(`ASK\t${id}\t${question}\n`);
  const { status, json } = await post("/demo/replay/ask", {
    streamId,
    question,
    allowPrivateIndex: item.allowPrivateIndex !== false,
    askedAt,
    senderName: "demo-reviewer",
  });
  if (status !== 200 || !json.ok) {
    const err = String(json.error || "");
    const infraDown = /fetch failed|ECONNREFUSED|timeout|AbortError/i.test(err);
    if (infraDown) {
      console.log(`SKIP\t${id}\tGPU/LLM infra down: ${err}`);
      continue;
    }
    fail(`ask ${id} HTTP ${status} ${err}`);
  }
  const answer = json.answer || json.finalAnswer || "";
  const frames = json.screenShareFramesUsed?.length ?? 0;
  console.log(`PASS\t${id}\tframes=${frames}\tchars=${answer.length}`);
  console.log(`---- answer (${id}) ----`);
  console.log(answer);
  console.log(`---- end (${id}) ----`);
}

console.log("=== replay complete ===");
process.exit(0);
