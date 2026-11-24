import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CaseWorkspaceManager } from "../dist/caseWorkspace.js";

const baseConfig = {
  enabled: true,
  available: true,
  unavailableReasons: [],
  host: "127.0.0.1",
  port: 0,
  dataDir: "",
  rtmsDataDir: "",
  transcriptChunkChars: 8_000,
  maxScreenFrames: 30,
  jsonRepairAttempts: 2,
  textBaseUrl: "http://127.0.0.1:8001/v1",
  textModel: "mock-text",
  textApiKey: "",
  vlmBaseUrl: "http://127.0.0.1:8000/v1",
  vlmModel: "mock-vision",
  vlmApiKey: "",
  maxImageBytes: 2_500_000,
};

function source(caseId, streamId = "stream-1") {
  return {
    schemaVersion: 1,
    caseId,
    streamId,
    meetingUuid: "meeting-1",
    capturedAt: "2026-06-21T10:05:00.000Z",
    meetingStartedAt: "2026-06-21T10:00:00.000Z",
    meetingEndedAt: "2026-06-21T10:05:00.000Z",
    asrPath: `/tmp/${streamId}.ndjson`,
    screenMetadataPath: null,
    segments: [
      {
        id: 1,
        streamId,
        meetingUuid: "meeting-1",
        userId: 101,
        userName: "Presenter",
        startTimestamp: 1_000,
        endTimestamp: 2_000,
        text: "This case concerns an adult with persistent pain.",
        language: "en",
        durationSeconds: 1,
        createdAt: "2026-06-21T10:00:01.000Z",
      },
      {
        id: 2,
        streamId,
        meetingUuid: "meeting-1",
        userId: 202,
        userName: "Expert",
        startTimestamp: 2_100,
        endTimestamp: 3_000,
        text: "I recommend arranging a follow-up assessment.",
        language: "en",
        durationSeconds: 0.9,
        createdAt: "2026-06-21T10:00:02.100Z",
      },
    ],
    frames: [],
    sourceWarnings: [],
  };
}

function extraction() {
  return {
    caseDetected: true,
    detectionConfidence: "high",
    evidence: [
      {
        category: "caseOverview",
        text: "An adult patient has persistent pain.",
        confidence: "high",
        sourceRefs: [{ type: "transcript", segmentId: 1, timestamp: 1_000 }],
      },
      {
        category: "recommendations",
        text: "Arrange a follow-up assessment.",
        confidence: "high",
        sourceRefs: [{ type: "transcript", segmentId: 2, timestamp: 2_100 }],
        rationale: null,
        proposer: "Expert",
        consensusStatus: "proposed",
      },
    ],
    generationWarnings: [],
  };
}

function aggregate() {
  return {
    caseDetected: true,
    detectionConfidence: "high",
    caseDiscussionRange: { startTimestamp: 1_000, endTimestamp: 2_100 },
    caseOverview: [
      {
        text: "An adult patient has persistent pain.",
        confidence: "high",
        sourceRefs: [{ type: "transcript", segmentId: 1, timestamp: 1_000 }],
      },
    ],
    presentingQuestions: [],
    patientContext: [],
    historyAndConditions: [],
    medicationsAndTreatments: [],
    testsAndFindings: [],
    discussionThreads: [],
    recommendations: [
      {
        text: "Arrange a follow-up assessment.",
        confidence: "high",
        sourceRefs: [{ type: "transcript", segmentId: 2, timestamp: 2_100 }],
        rationale: null,
        proposer: "Expert",
        consensusStatus: "proposed",
      },
    ],
    rejectedOrRevisedSuggestions: [],
    disagreements: [],
    unresolvedQuestionsAndDataGaps: [],
    followUpActions: [],
    deidentificationWarnings: [],
    generationWarnings: [],
  };
}

class MockModels {
  calls = [];
  repairResponse = null;
  noCase = false;

  async text(messages) {
    const prompt = messages.map((message) => JSON.stringify(message.content)).join("\n");
    this.calls.push(prompt);
    if (prompt.includes("Validation error") && this.repairResponse) {
      return JSON.stringify(this.repairResponse);
    }
    if (prompt.includes("Extracted evidence")) {
      return JSON.stringify(aggregate());
    }
    if (this.noCase) {
      return JSON.stringify({
        caseDetected: false,
        detectionConfidence: "low",
        evidence: [],
        generationWarnings: [],
      });
    }
    return JSON.stringify(extraction());
  }

  async vision() {
    throw new Error("Vision should not be called without frames");
  }

  async health() {
    return {
      text: { ok: true, url: "mock://text" },
      vision: { ok: true, url: "mock://vision" },
    };
  }
}

async function harness(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "echo-case-test-"));
  const events = [];
  const models = options.models ?? new MockModels();
  const config = {
    ...baseConfig,
    ...options.config,
    dataDir: path.join(root, "cases"),
    rtmsDataDir: path.join(root, "rtms"),
  };
  const manager = new CaseWorkspaceManager(
    config,
    (type, payload) => events.push({ type, payload }),
    async (streamId, caseId) => source(caseId, streamId),
    models,
  );
  return { root, events, models, config, manager };
}

test("disabled mode creates no directory or workspace", async () => {
  const { root, config, manager } = await harness({
    config: { enabled: false, available: false },
  });
  try {
    await manager.start();
    const result = await manager.handleSessionClosed({
      streamId: "stream-disabled",
      meetingUuid: "meeting-disabled",
    });
    assert.equal(result, null);
    await assert.rejects(access(config.dataDir));
    assert.equal(manager.health().enabled, false);
    assert.equal(manager.health().listening, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enabled REST service listens locally and exposes health/list endpoints", async () => {
  const { root, manager } = await harness();
  try {
    await manager.start();
    const port = manager.health().listeningPort;
    assert.equal(typeof port, "number");
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) =>
      response.json(),
    );
    assert.equal(health.ok, true);
    assert.equal(health.caseWorkspace.enabled, true);
    const list = await fetch(`http://127.0.0.1:${port}/cases`).then((response) =>
      response.json(),
    );
    assert.deepEqual(list.items, []);
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("session close creates one immutable, source-grounded revision", async () => {
  const { root, manager, events } = await harness();
  try {
    const first = await manager.handleSessionClosed({
      streamId: "stream-1",
      meetingUuid: "meeting-1",
      startedAt: "2026-06-21T10:00:00.000Z",
      closedAt: "2026-06-21T10:05:00.000Z",
    });
    const duplicate = await manager.handleSessionClosed({
      streamId: "stream-1",
      meetingUuid: "meeting-1",
    });
    assert.equal(first.caseId, duplicate.caseId);

    await manager.waitForIdle();
    const result = await manager.get(first.caseId);
    assert.equal(result.workspace.status, "complete");
    assert.equal(result.workspace.revisionIds.length, 1);
    assert.equal(result.currentRevision.caseDetected, true);
    assert.deepEqual(result.currentRevision.caseOverview[0].sourceRefs, [
      { type: "transcript", segmentId: 1, timestamp: 1_000 },
    ]);
    assert.ok(
      events.some((event) => event.type === "case-workspace-generation-completed"),
    );

    const stored = JSON.parse(
      await readFile(
        path.join(
          manager.health().dataDir,
          first.caseId,
          "revisions",
          `${result.currentRevision.revisionId}.json`,
        ),
        "utf8",
      ),
    );
    assert.equal(stored.disclaimer.includes("Not a medical record"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completed revision invokes the structured output hook without changing workspace status", async () => {
  const { root, manager } = await harness();
  const completed = [];
  manager.setOutputService({
    registerRoutes() {},
    health() {
      return { enabled: true };
    },
    async runtimeHealth() {
      return { enabled: true };
    },
    async onCaseRevisionCompleted(workspace, revision) {
      completed.push({
        caseId: workspace.caseId,
        revisionId: revision.revisionId,
      });
    },
  });
  try {
    const queued = await manager.handleSessionClosed({
      streamId: "stream-output-hook",
      meetingUuid: "meeting-output-hook",
    });
    await manager.waitForIdle();
    const result = await manager.get(queued.caseId);
    assert.equal(result.workspace.status, "complete");
    assert.deepEqual(completed, [
      {
        caseId: queued.caseId,
        revisionId: result.currentRevision.revisionId,
      },
    ]);
    assert.deepEqual(manager.health().caseOutput, { enabled: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("regeneration appends a revision without overwriting history", async () => {
  const { root, manager } = await harness();
  try {
    const workspace = await manager.handleSessionClosed({
      streamId: "stream-2",
      meetingUuid: "meeting-2",
    });
    await manager.waitForIdle();
    const before = await manager.get(workspace.caseId);
    const previousRevisionId = before.workspace.currentRevisionId;
    await manager.regenerate(workspace.caseId);
    await manager.waitForIdle();
    const after = await manager.get(workspace.caseId);
    assert.equal(after.workspace.revisionIds.length, 2);
    assert.notEqual(after.workspace.currentRevisionId, previousRevisionId);
    const revisions = await manager.revisions(workspace.caseId);
    assert.equal(revisions.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("no detected case produces an empty complete revision", async () => {
  const models = new MockModels();
  models.noCase = true;
  const { root, manager } = await harness({ models });
  try {
    const workspace = await manager.handleSessionClosed({
      streamId: "didactic-only",
      meetingUuid: "meeting-3",
    });
    await manager.waitForIdle();
    const result = await manager.get(workspace.caseId);
    assert.equal(result.workspace.status, "complete");
    assert.equal(result.currentRevision.caseDetected, false);
    assert.deepEqual(result.currentRevision.caseOverview, []);
    assert.ok(
      result.currentRevision.generationWarnings.some((warning) =>
        warning.includes("No source-grounded patient case"),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid source references trigger JSON repair", async () => {
  const models = new MockModels();
  const invalid = extraction();
  invalid.evidence[0].sourceRefs[0].segmentId = 999;
  let extractionCalls = 0;
  models.text = async function (messages) {
    const prompt = messages.map((message) => JSON.stringify(message.content)).join("\n");
    this.calls.push(prompt);
    if (prompt.includes("Validation error")) {
      return JSON.stringify(extraction());
    }
    if (prompt.includes("Extracted evidence")) {
      return JSON.stringify(aggregate());
    }
    extractionCalls += 1;
    return JSON.stringify(invalid);
  };

  const { root, manager } = await harness({ models });
  try {
    const workspace = await manager.handleSessionClosed({
      streamId: "stream-repair",
      meetingUuid: "meeting-repair",
    });
    await manager.waitForIdle();
    const result = await manager.get(workspace.caseId);
    assert.equal(result.workspace.status, "complete");
    assert.equal(extractionCalls, 1);
    assert.ok(models.calls.some((prompt) => prompt.includes("Validation error")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model failures leave a retryable failed workspace", async () => {
  const models = new MockModels();
  models.text = async () => {
    throw new Error("model unavailable");
  };
  const { root, manager } = await harness({ models });
  try {
    const workspace = await manager.handleSessionClosed({
      streamId: "stream-failure",
      meetingUuid: "meeting-failure",
    });
    await manager.waitForIdle();
    const result = await manager.get(workspace.caseId);
    assert.equal(result.workspace.status, "failed");
    assert.equal(result.workspace.retryable, true);
    assert.match(result.workspace.lastError, /model unavailable/);
    assert.equal(result.workspace.revisionIds.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupted processing workspace is recovered as retryable failed", async () => {
  const { root, config, manager } = await harness();
  const caseId = "case-interrupted";
  const now = "2026-06-21T10:00:00.000Z";
  const workspace = {
    schemaVersion: 1,
    caseId,
    streamId: "stream-interrupted",
    meetingUuid: "meeting-interrupted",
    meetingStartedAt: now,
    meetingEndedAt: now,
    status: "processing",
    caseDetected: null,
    detectionConfidence: null,
    caseDiscussionRange: null,
    currentRevisionId: null,
    revisionIds: [],
    lastError: null,
    retryable: false,
    attemptCount: 1,
    sourceManifest: {
      capturedAt: null,
      segmentCount: 0,
      screenFrameCount: 0,
      asrPath: null,
      screenMetadataPath: null,
    },
    models: { text: "mock-text", vision: "mock-vision" },
    createdAt: now,
    updatedAt: now,
  };
  try {
    await mkdir(path.join(config.dataDir, caseId), { recursive: true });
    await writeFile(
      path.join(config.dataDir, caseId, "workspace.json"),
      JSON.stringify(workspace),
    );
    const recovered = await manager.handleSessionClosed({
      streamId: workspace.streamId,
      meetingUuid: workspace.meetingUuid,
    });
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.retryable, true);
    assert.match(recovered.lastError, /interrupted/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
