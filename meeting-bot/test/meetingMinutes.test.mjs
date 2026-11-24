import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MeetingMinutesManager } from "../dist/meetingMinutes.js";

function config(root, overrides = {}) {
  return {
    enabled: true,
    available: true,
    unavailableReasons: [],
    dataDir: path.join(root, "minutes"),
    textBaseUrl: "mock://llm/v1",
    textModel: "mock-minutes-model",
    textApiKey: "",
    textEnableThinking: false,
    maxTranscriptChars: 60_000,
    summaryMaxTokens: 1_200,
    maxSlides: 10,
    maxQaPairs: 100,
    llmTimeoutMs: 5_000,
    ...overrides,
  };
}

function segment(id, text, userName = "Presenter") {
  return {
    id,
    streamId: "stream-1",
    meetingUuid: "meeting-1",
    userId: id,
    userName,
    startTimestamp: 1_000 * id,
    endTimestamp: 1_000 * id + 500,
    text,
    language: "en",
    durationSeconds: 0.5,
    createdAt: new Date(1_000 * id).toISOString(),
  };
}

test("meeting minutes smoke test writes summary, QA, transcript, and slide copies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "echo-minutes-test-"));
  const sourceFrame = path.join(root, "source-slide.jpg");
  await writeFile(sourceFrame, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  const events = [];
  const modelCalls = [];
  const manager = new MeetingMinutesManager(
    config(root),
    (type, payload) => events.push({ type, payload }),
    async () => ({
      streamId: "stream-1",
      meetingUuid: "meeting-1",
      segments: [
        segment(1, "Today we reviewed medication for opioid use disorder."),
        segment(2, "The team decided to follow up on local referral workflows.", "Expert"),
      ],
      screenShareFrames: [
        {
          streamId: "stream-1",
          meetingUuid: "meeting-1",
          frameId: 1,
          uniqueFrameId: 1,
          fileName: "source-slide.jpg",
          filePath: sourceFrame,
          timestamp: 1_500,
          receivedAt: "2026-06-21T10:00:01.500Z",
          size: 4,
          codec: "JPG",
          resolution: "FHD",
          fps: 1,
          diffFromPreviousUnique: null,
          userId: 10,
          userName: "Presenter",
          startTs: null,
          endTs: null,
        },
      ],
      qaPairs: [
        {
          question: "What follow-up was decided?",
          answer: "The team will follow up on local referral workflows.",
          askedAt: 2_000,
          answeredAt: "2026-06-21T10:00:02.000Z",
          senderName: "Participant",
          replyType: "public-mention",
        },
      ],
    }),
    {
      async summarize(messages, maxTokens) {
        modelCalls.push({ messages, maxTokens });
        return [
          "## Overview",
          "The meeting reviewed medication for opioid use disorder.",
          "",
          "## Action Items",
          "- Follow up on local referral workflows.",
        ].join("\n");
      },
    },
  );

  try {
    const manifest = await manager.handleSessionClosed({
      streamId: "stream-1",
      meetingUuid: "meeting-1",
      startedAt: "2026-06-21T10:00:00.000Z",
      closedAt: "2026-06-21T10:05:00.000Z",
      reason: "smoke-test",
    });

    assert.ok(manifest);
    assert.equal(manifest.summary.generatedBy, "llm");
    assert.equal(manifest.summary.model, "mock-minutes-model");
    assert.equal(manifest.qaPairs.count, 1);
    assert.equal(manifest.slides.count, 1);
    assert.equal(modelCalls.length, 1);
    assert.equal(modelCalls[0].maxTokens, 1_200);

    const summary = await readFile(manifest.files.summaryMarkdown, "utf8");
    assert.match(summary, /Meeting Minutes/u);
    assert.match(summary, /local referral workflows/u);

    const qaPairs = JSON.parse(await readFile(manifest.files.qaPairsJson, "utf8"));
    assert.equal(qaPairs[0].question, "What follow-up was decided?");
    assert.equal(qaPairs[0].answer, "The team will follow up on local referral workflows.");

    const transcript = await readFile(manifest.files.transcriptText, "utf8");
    assert.match(transcript, /Presenter: Today we reviewed/u);
    assert.match(transcript, /Expert: The team decided/u);

    await access(manifest.slides.items[0].filePath);
    assert.ok(
      events.some((event) => event.type === "meeting-minutes-generation-completed"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disabled meeting minutes do not generate outputs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "echo-minutes-disabled-"));
  const manager = new MeetingMinutesManager(
    config(root, { enabled: false, available: false }),
    () => undefined,
    async () => {
      throw new Error("source should not be read when disabled");
    },
    {
      async summarize() {
        throw new Error("model should not be called when disabled");
      },
    },
  );

  try {
    const result = await manager.handleSessionClosed({
      streamId: "stream-disabled",
      meetingUuid: "meeting-disabled",
    });
    assert.equal(result, null);
    await assert.rejects(access(path.join(root, "minutes")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
