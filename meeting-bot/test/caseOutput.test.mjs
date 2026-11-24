import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import test from "node:test";
import {
  CaseOutputManager,
  buildCaseOutputPacket,
  renderCaseOutputHtml,
} from "../dist/caseOutput.js";

function fact(text, segmentId = 1, confidence = "high") {
  return {
    text,
    confidence,
    sourceRefs: [
      { type: "transcript", segmentId, timestamp: segmentId * 1000 },
    ],
  };
}

function revision(caseId = "case-1", revisionId = "revision-1", options = {}) {
  const caseDetected = options.caseDetected ?? true;
  return {
    schemaVersion: 1,
    revisionId,
    caseId,
    streamId: `secret-stream-${caseId}`,
    generatedAt: "2026-06-21T12:00:00.000Z",
    disclaimer: "legacy disclaimer",
    models: { text: "model-a", vision: "model-b" },
    caseDetected,
    detectionConfidence: "high",
    caseDiscussionRange: caseDetected
      ? { startTimestamp: 1000, endTimestamp: 5000 }
      : null,
    caseOverview: caseDetected
      ? [fact(options.overview ?? "Persistent pain <script>alert(1)</script>", 1)]
      : [],
    presentingQuestions: caseDetected
      ? [fact("What treatment should be considered?", 2)]
      : [],
    patientContext: caseDetected ? [fact("Adult patient", 3, "low")] : [],
    historyAndConditions: caseDetected ? [fact("Chronic pain", 4)] : [],
    medicationsAndTreatments: [],
    testsAndFindings: caseDetected ? [fact("Imaging reviewed", 5)] : [],
    discussionThreads: caseDetected ? [fact("Multimodal care discussed", 6)] : [],
    recommendations: caseDetected
      ? [
          {
            ...fact("Consider physical therapy", 7),
            rationale: "Improve function",
            proposer: "Expert panel",
            consensusStatus: "agreed",
          },
        ]
      : [],
    rejectedOrRevisedSuggestions: [],
    disagreements: [],
    unresolvedQuestionsAndDataGaps: caseDetected
      ? [fact("Prior response is unknown", 8)]
      : [],
    followUpActions: caseDetected
      ? [
          {
            ...fact("Reassess at follow-up", 9),
            responsibleParty: null,
            timing: "Four weeks",
          },
        ]
      : [],
    deidentificationWarnings: options.phiWarning
      ? [fact("Potential identifying detail remains", 10)]
      : [],
    generationWarnings: options.generationWarnings ?? [],
  };
}

function workspace(caseId = "case-1", revisionIds = ["revision-1"]) {
  return {
    schemaVersion: 1,
    caseId,
    streamId: `secret-stream-${caseId}`,
    meetingUuid: "secret-meeting-uuid",
    meetingStartedAt: "2026-06-21T10:00:00.000Z",
    meetingEndedAt: "2026-06-21T11:00:00.000Z",
    status: "complete",
    caseDetected: true,
    detectionConfidence: "high",
    caseDiscussionRange: { startTimestamp: 1000, endTimestamp: 5000 },
    currentRevisionId: revisionIds.at(-1),
    revisionIds,
    lastError: null,
    retryable: false,
    attemptCount: 1,
    sourceManifest: {
      capturedAt: "2026-06-21T11:00:01.000Z",
      segmentCount: 10,
      screenFrameCount: 1,
      asrPath: "/secret/asr/path",
      screenMetadataPath: "/secret/screen/path",
    },
    models: { text: "model-a", vision: "model-b" },
    createdAt: "2026-06-21T11:00:01.000Z",
    updatedAt: "2026-06-21T12:00:00.000Z",
  };
}

function retrieval(caseId = "case-1", revisionId = "revision-1", id = "retrieval-1") {
  return {
    schemaVersion: 1,
    retrievalId: id,
    caseId,
    revisionId,
    question: "Find evidence",
    intent: "both",
    sanitizedMedicalConcepts: ["chronic pain"],
    status: "complete",
    historicalCases: [
      {
        caseId: "historical-1",
        revisionId: "historical-revision-1",
        similarityScore: 0.91,
        similarities: ["Persistent pain"],
        keyDifferences: ["Different prior treatment"],
        relevantRecommendations: [
          {
            text: "Use multimodal care",
            sourceRefs: [
              { type: "transcript", segmentId: 21, timestamp: 21000 },
            ],
          },
        ],
        relevantOutcomes: [],
      },
    ],
    literature: [
      {
        pmid: "12345",
        title: "A pain treatment study",
        authors: ["A. Author"],
        journal: "Example Journal",
        publicationDate: "2025-06",
        publicationTypes: ["Clinical Trial"],
        abstract: "Function improved.",
        doi: "10.1000/example",
        pmcId: "PMC123",
        pubmedUrl: "https://pubmed.ncbi.nlm.nih.gov/12345/",
        doiUrl: "https://doi.org/10.1000/example",
        pmcUrl: "https://pmc.ncbi.nlm.nih.gov/articles/PMC123/",
        relevanceReason: "Evaluates a relevant intervention",
        abstractSupportedConclusion: "Function improved in the study group.",
        warnings: [],
      },
    ],
    warnings: [],
    createdAt: "2026-06-21T12:01:00.000Z",
    completedAt: "2026-06-21T12:01:01.000Z",
  };
}

function outputConfig(root, overrides = {}) {
  return {
    enabled: true,
    available: true,
    unavailableReasons: [],
    caseDataDir: path.join(root, "cases"),
    formats: ["json", "html", "pdf"],
    templateVersion: "echo-clinical-v1",
    language: "en",
    pdfTimeoutMs: 1000,
    maxConcurrent: 1,
    ...overrides,
  };
}

class MockPdfRenderer {
  calls = 0;
  failuresRemaining = 0;

  async render(html) {
    this.calls += 1;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("mock Chromium unavailable");
    }
    assert.match(html, /ECHO Structured Case Report/u);
    return Buffer.from("%PDF-1.7\nmock pdf\n");
  }

  async health() {
    return {
      configured: true,
      available: this.failuresRemaining === 0,
      launched: false,
      executablePath: "/mock/chromium",
    };
  }

  async shutdown() {}
}

function harness(root, options = {}) {
  const revisions = new Map();
  for (const item of options.revisions ?? [revision()]) {
    revisions.set(`${item.caseId}:${item.revisionId}`, item);
  }
  const workspaces = new Map();
  for (const item of options.workspaces ?? [workspace()]) {
    workspaces.set(item.caseId, item);
  }
  const retrievalRecords = options.retrievalRecords ?? [];
  const pdf = options.pdf ?? new MockPdfRenderer();
  const events = [];
  const manager = new CaseOutputManager(
    outputConfig(root, options.config),
    (type, payload) => events.push({ type, payload }),
    {
      async get(caseId) {
        const item = workspaces.get(caseId);
        if (!item) return null;
        const currentRevision = item.currentRevisionId
          ? revisions.get(`${caseId}:${item.currentRevisionId}`) ?? null
          : null;
        return { workspace: item, currentRevision };
      },
      async revision(caseId, revisionId) {
        return revisions.get(`${caseId}:${revisionId}`) ?? null;
      },
    },
    {
      async recordsForCase(caseId) {
        return retrievalRecords.filter((item) => item.caseId === caseId);
      },
    },
    pdf,
  );
  return { manager, events, pdf, revisions, workspaces, retrievalRecords };
}

test("disabled output creates no directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "echo-output-off-"));
  const { manager } = harness(root, {
    config: { enabled: false, available: false },
  });
  try {
    await manager.start();
    assert.equal(manager.health().enabled, false);
    await assert.rejects(access(path.join(root, "cases")));
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("revision completion creates immutable JSON, HTML, and PDF artifacts idempotently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "echo-output-"));
  const phiRevision = revision("case-1", "revision-1", { phiWarning: true });
  const { manager, events } = harness(root, { revisions: [phiRevision] });
  try {
    await manager.onCaseRevisionCompleted(workspace(), phiRevision);
    await manager.waitForIdle();
    const outputs = manager.list("case-1");
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].status, "complete");
    assert.deepEqual(outputs[0].retrievalIds, []);
    assert.deepEqual(
      outputs[0].artifacts.map((item) => [item.format, item.status]),
      [
        ["json", "ready"],
        ["html", "ready"],
        ["pdf", "ready"],
      ],
    );

    const outputDir = path.join(
      root,
      "cases",
      "case-1",
      "outputs",
      outputs[0].outputId,
    );
    const packetText = await readFile(path.join(outputDir, "case-output.json"), "utf8");
    const packet = JSON.parse(packetText);
    assert.equal(
      packet.disclaimer,
      "AI-generated ECHO internal educational summary; not a medical record or clinical advice.",
    );
    assert.doesNotMatch(packetText, /secret-stream|secret-meeting|\/secret\//u);
    assert.deepEqual(packet.case.meetingStartedAt, "2026-06-21T10:00:00.000Z");
    assert.deepEqual(packet.caseOverview[0].sourceRefs, [
      { type: "transcript", segmentId: 1, timestamp: 1000 },
    ]);

    const html = await readFile(path.join(outputDir, "report.html"), "utf8");
    assert.match(html, /Potential de-identification risk/u);
    assert.match(html, /T-1 \(1000 ms\)/u);
    assert.match(html, /confidence-low/u);
    assert.match(html, /Not documented in source material/u);
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/u);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);

    const pdf = await readFile(path.join(outputDir, "report.pdf"));
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    for (const artifact of outputs[0].artifacts) {
      assert.ok(artifact.sizeBytes > 0);
      assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);
    }

    const duplicate = await manager.create("case-1", "revision-1", []);
    assert.equal(duplicate.outputId, outputs[0].outputId);
    assert.equal(manager.list("case-1").length, 1);
    assert.ok(events.some((event) => event.type === "case-output-completed"));
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("completed retrieval creates a cumulative evidence version without changing the base output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "echo-output-evidence-"));
  const retrievalRecords = [];
  const { manager, events } = harness(root, { retrievalRecords });
  try {
    await manager.onCaseRevisionCompleted(workspace(), revision());
    await manager.waitForIdle();
    const base = manager.list("case-1")[0];
    const baseDir = path.join(
      root,
      "cases",
      "case-1",
      "outputs",
      base.outputId,
    );
    const baseHtmlBefore = await readFile(path.join(baseDir, "report.html"));
    const baseChecksum = base.artifacts.find((item) => item.format === "html").sha256;

    const evidence = retrieval();
    retrievalRecords.push(evidence);
    await manager.onRetrievalCompleted(evidence);
    await manager.waitForIdle();

    const outputs = manager.list("case-1");
    assert.equal(outputs.length, 2);
    const enriched = outputs[0];
    assert.equal(enriched.outputVersion, 2);
    assert.deepEqual(enriched.retrievalIds, ["retrieval-1"]);
    const enrichedDir = path.join(
      root,
      "cases",
      "case-1",
      "outputs",
      enriched.outputId,
    );
    const html = await readFile(path.join(enrichedDir, "report.html"), "utf8");
    assert.match(html, /\[Case:historical-1\]/u);
    assert.match(html, /\[PMID:12345\]/u);
    assert.match(html, /https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/12345\//u);
    const enrichedHtmlBefore = Buffer.from(html);

    const secondEvidence = {
      ...retrieval("case-1", "revision-1", "retrieval-2"),
      status: "partial",
      createdAt: "2026-06-21T12:02:00.000Z",
      completedAt: "2026-06-21T12:02:01.000Z",
    };
    retrievalRecords.push(secondEvidence);
    await manager.onRetrievalCompleted(secondEvidence);
    await manager.waitForIdle();
    const cumulative = manager.list("case-1")[0];
    assert.equal(cumulative.outputVersion, 3);
    assert.deepEqual(cumulative.retrievalIds, ["retrieval-1", "retrieval-2"]);
    assert.deepEqual(
      await readFile(path.join(enrichedDir, "report.html")),
      enrichedHtmlBefore,
    );

    assert.deepEqual(await readFile(path.join(baseDir, "report.html")), baseHtmlBefore);
    assert.equal(
      manager
        .list("case-1")
        .find((item) => item.outputId === base.outputId)
        .artifacts.find((item) => item.format === "html").sha256,
      baseChecksum,
    );
    assert.ok(
      events.some(
        (event) => event.type === "case-output-evidence-version-created",
      ),
    );
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("a new immutable revision creates a new output and preserves the old artifact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "echo-output-revision-"));
  const revisionOne = revision("case-1", "revision-1", {
    overview: "First revision",
  });
  const revisionTwo = revision("case-1", "revision-2", {
    overview: "Corrected second revision",
  });
  const caseWorkspace = workspace("case-1", ["revision-1", "revision-2"]);
  const { manager } = harness(root, {
    revisions: [revisionOne, revisionTwo],
    workspaces: [caseWorkspace],
  });
  try {
    const first = await manager.create("case-1", "revision-1", []);
    await manager.waitForIdle();
    const firstPath = path.join(
      root,
      "cases",
      "case-1",
      "outputs",
      first.outputId,
      "case-output.json",
    );
    const firstBytes = await readFile(firstPath);
    const second = await manager.create("case-1", "revision-2", []);
    await manager.waitForIdle();
    assert.notEqual(first.outputId, second.outputId);
    assert.equal(second.outputVersion, 2);
    assert.deepEqual(await readFile(firstPath), firstBytes);
    const secondPacket = JSON.parse(
      await readFile(
        path.join(
          root,
          "cases",
          "case-1",
          "outputs",
          second.outputId,
          "case-output.json",
        ),
        "utf8",
      ),
    );
    assert.equal(secondPacket.caseOverview[0].text, "Corrected second revision");
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("PDF failure leaves JSON and HTML ready; retry preserves successful checksums", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "echo-output-retry-"));
  const pdf = new MockPdfRenderer();
  pdf.failuresRemaining = 1;
  const { manager, revisions, workspaces, retrievalRecords } = harness(root, {
    pdf,
  });
  try {
    const output = await manager.create("case-1", "revision-1", []);
    await manager.waitForIdle();
    assert.equal(output.status, "partial");
    assert.equal(output.retryable, true);
    assert.equal(output.artifacts.find((item) => item.format === "pdf").status, "failed");
    const jsonChecksum = output.artifacts.find((item) => item.format === "json").sha256;
    const htmlChecksum = output.artifacts.find((item) => item.format === "html").sha256;

    revisions.clear();
    workspaces.clear();
    retrievalRecords.splice(0);
    await manager.retry(output.outputId);
    await manager.waitForIdle();
    assert.equal(output.status, "complete");
    assert.equal(output.artifacts.find((item) => item.format === "json").sha256, jsonChecksum);
    assert.equal(output.artifacts.find((item) => item.format === "html").sha256, htmlChecksum);
    assert.equal(output.artifacts.find((item) => item.format === "pdf").status, "ready");
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("no-case revision renders a minimal report", () => {
  const record = {
    schemaVersion: 1,
    outputId: "output-1",
    outputVersion: 1,
    caseId: "case-1",
    revisionId: "revision-1",
    retrievalIds: [],
    templateVersion: "echo-clinical-v1",
    language: "en",
    status: "queued",
    artifacts: [],
    warnings: [],
    retryable: false,
    idempotencyKey: "key",
    createdAt: "2026-06-21T12:00:00.000Z",
  };
  const noCaseRevision = revision("case-1", "revision-1", {
    caseDetected: false,
  });
  const packet = buildCaseOutputPacket(
    record,
    workspace(),
    noCaseRevision,
    [],
  );
  const html = renderCaseOutputHtml(packet);
  assert.match(html, /No case presentation detected/u);
  assert.doesNotMatch(html, /<h2>Recommendations<\/h2>/u);
});

test("localhost output API lists metadata and downloads artifacts safely", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "echo-output-api-"));
  const { manager } = harness(root);
  const app = express();
  app.use(express.json());
  manager.registerRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  try {
    const createResponse = await fetch(
      `http://127.0.0.1:${port}/cases/case-1/outputs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revisionId: "revision-1", retrievalIds: [] }),
      },
    );
    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    await manager.waitForIdle();

    const list = await fetch(
      `http://127.0.0.1:${port}/cases/case-1/outputs?status=complete`,
    ).then((response) => response.json());
    assert.equal(list.outputs.length, 1);

    const download = await fetch(
      `http://127.0.0.1:${port}/cases/case-1/outputs/${created.output.outputId}/files/pdf`,
    );
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-type"), /application\/pdf/u);
    assert.match(
      download.headers.get("content-disposition"),
      /echo-case-case-1-v1\.pdf/u,
    );
    assert.match(download.headers.get("x-content-sha256"), /^[a-f0-9]{64}$/u);

    const invalid = await fetch(
      `http://127.0.0.1:${port}/cases/case-1/outputs/${created.output.outputId}/files/..%2Fmanifest.json`,
    );
    assert.ok([400, 404].includes(invalid.status));
  } finally {
    await manager.shutdown();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("startup recovers queued output and marks interrupted processing retryable failed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "echo-output-recovery-"));
  const records = [
    {
      schemaVersion: 1,
      outputId: "queued-output",
      outputVersion: 1,
      caseId: "case-1",
      revisionId: "revision-1",
      retrievalIds: [],
      templateVersion: "echo-clinical-v1",
      language: "en",
      status: "queued",
      artifacts: [],
      warnings: [],
      retryable: false,
      idempotencyKey: "queued-key",
      createdAt: "2026-06-21T12:00:00.000Z",
    },
    {
      schemaVersion: 1,
      outputId: "processing-output",
      outputVersion: 2,
      caseId: "case-1",
      revisionId: "revision-1",
      retrievalIds: [],
      templateVersion: "echo-clinical-v1",
      language: "en",
      status: "processing",
      artifacts: [],
      warnings: [],
      retryable: false,
      idempotencyKey: "processing-key",
      createdAt: "2026-06-21T12:01:00.000Z",
    },
  ];
  for (const record of records) {
    const directory = path.join(
      root,
      "cases",
      "case-1",
      "outputs",
      record.outputId,
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "manifest.json"),
      JSON.stringify(record),
    );
  }
  const corruptDirectory = path.join(
    root,
    "cases",
    "case-1",
    "outputs",
    "corrupt-output",
  );
  await mkdir(corruptDirectory, { recursive: true });
  await writeFile(path.join(corruptDirectory, "manifest.json"), "{not-json");
  const { manager, events } = harness(root);
  try {
    await manager.start();
    await manager.waitForIdle();
    const outputs = manager.list("case-1");
    assert.equal(outputs.find((item) => item.outputId === "queued-output").status, "complete");
    const interrupted = outputs.find(
      (item) => item.outputId === "processing-output",
    );
    assert.equal(interrupted.status, "failed");
    assert.equal(interrupted.retryable, true);
    assert.match(interrupted.warnings.join(" "), /interrupted/u);
    assert.ok(
      events.some(
        (event) =>
          event.type === "case-output-failed" &&
          event.payload?.reason === "manifest-load-failed",
      ),
    );
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
