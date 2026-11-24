import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { CaseWorkspaceManager } from "../dist/caseWorkspace.js";
import {
  MeetingAiManager,
  enforceEvidenceCitationWhitelist,
  renderEvidenceSourceReferences,
} from "../dist/meetingAi.js";
import {
  PubMedClient,
  RetrievalManager,
  buildPubMedQuery,
  classifyRetrievalIntent,
  moudBoostConcepts,
  sanitizeMedicalConcept,
  sanitizeMedicalConcepts,
  sensitiveTermsFromLocalText,
} from "../dist/retrieval.js";

function config(root, overrides = {}) {
  return {
    enabled: true,
    historicalCasesEnabled: true,
    pubmedEnabled: true,
    dataDir: path.join(root, "retrieval"),
    caseDataDir: path.join(root, "cases"),
    embeddingBaseUrl: "http://127.0.0.1:8002/v1",
    embeddingModel: "BAAI/bge-m3",
    embeddingApiKey: "",
    embeddingGpu: 4,
    caseCandidates: 12,
    caseTopK: 5,
    privateRagEnabled: false,
    privateRagDbDir: path.join(root, "private_db"),
    privateRagBm25K: 100,
    privateRagTopK: 10,
    privateRagBlend: false,
    privateRagSemanticWeight: 0.8,
    privateRagAlwaysOn: false,
    privateRagMaxExcerptChars: 900,
    pubmedEmail: "echo@example.org",
    pubmedApiKey: "test-key",
    pubmedTool: "echo-ai-assistant",
    pubmedBestMatchCount: 10,
    pubmedRecentCount: 10,
    pubmedRecentYears: 5,
    pubmedFinalCount: 5,
    pubmedQueryConcepts: 6,
    pubmedRerankTimeoutMs: 2500,
    pubmedRerankAbstractChars: 1200,
    pubmedCacheTtlSeconds: 86400,
    sourceTimeoutMs: 8000,
    totalTimeoutMs: 10000,
    textBaseUrl: "http://127.0.0.1:8001/v1",
    textModel: "test-model",
    textApiKey: "",
    ...overrides,
  };
}

function fact(text, segmentId = 1) {
  return {
    text,
    confidence: "high",
    sourceRefs: [{ type: "transcript", segmentId, timestamp: segmentId * 1000 }],
  };
}

function revision(caseId, revisionId, options = {}) {
  return {
    schemaVersion: 1,
    revisionId,
    caseId,
    streamId: `stream-${caseId}`,
    generatedAt: "2026-06-21T12:00:00.000Z",
    disclaimer: "AI-generated ECHO internal summary",
    models: { text: "test", vision: "test" },
    caseDetected: options.caseDetected ?? true,
    detectionConfidence: "high",
    caseDiscussionRange: { startTimestamp: 1000, endTimestamp: 5000 },
    caseOverview: [fact(options.overview ?? "Treatment-resistant depression", 1)],
    presentingQuestions: [fact("Which intervention is best supported?", 2)],
    patientContext: [fact("Adult patient", 3)],
    historyAndConditions: [fact("Major depressive disorder", 4)],
    medicationsAndTreatments: [fact("Prior antidepressant trials", 5)],
    testsAndFindings: [fact("Persistent severe symptoms", 6)],
    discussionThreads: [fact("Neuromodulation options discussed", 7)],
    recommendations: [
      {
        ...fact(options.recommendation ?? "Consider evidence-based neuromodulation", 8),
        rationale: null,
        proposer: null,
        consensusStatus: "agreed",
      },
    ],
    rejectedOrRevisedSuggestions: [],
    disagreements: [],
    unresolvedQuestionsAndDataGaps: [fact("Long-term outcome unknown", 9)],
    followUpActions: [
      {
        ...fact("Review response at follow-up", 10),
        responsibleParty: null,
        timing: null,
      },
    ],
    deidentificationWarnings: options.phiWarning ? [fact("Possible PHI", 11)] : [],
    generationWarnings: [],
  };
}

function workspace(caseId, revisionId, options = {}) {
  return {
    schemaVersion: 1,
    caseId,
    streamId: `stream-${caseId}`,
    meetingUuid: null,
    meetingStartedAt: null,
    meetingEndedAt: null,
    status: options.status ?? "complete",
    caseDetected: options.caseDetected ?? true,
    detectionConfidence: "high",
    caseDiscussionRange: { startTimestamp: 1000, endTimestamp: 5000 },
    currentRevisionId: revisionId,
    revisionIds: [revisionId],
    lastError: null,
    retryable: false,
    attemptCount: 1,
    sourceManifest: {
      capturedAt: null,
      segmentCount: 10,
      screenFrameCount: 0,
      asrPath: null,
      screenMetadataPath: null,
    },
    models: { text: "test", vision: "test" },
    createdAt: "2026-06-21T12:00:00.000Z",
    updatedAt: "2026-06-21T12:00:00.000Z",
  };
}

async function writeCase(root, caseId, revisionId, options = {}) {
  const directory = path.join(root, "cases", caseId, "revisions");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(root, "cases", caseId, "workspace.json"),
    JSON.stringify(workspace(caseId, revisionId, options)),
  );
  await writeFile(
    path.join(directory, `${revisionId}.json`),
    JSON.stringify(revision(caseId, revisionId, options)),
  );
}

function privateRagTokens(value) {
  const stopwords = new Set([
    "a",
    "and",
    "are",
    "can",
    "for",
    "from",
    "in",
    "is",
    "of",
    "on",
    "or",
    "patient",
    "should",
    "the",
    "to",
    "with",
  ]);
  return value
    .toLowerCase()
    .replace(/[^a-z0-9']+/gu, " ")
    .split(/\s+/u)
    .map((token) => token.replace(/^'+|'+$/gu, ""))
    .filter((token) => token.length >= 2 && !stopwords.has(token));
}

function buildPrivateLexicalIndex(chunks) {
  const docLengths = {};
  const postings = {};
  let totalLength = 0;
  for (const chunk of chunks) {
    const tokens = privateRagTokens(chunk.text);
    docLengths[chunk.chunkId] = tokens.length;
    totalLength += tokens.length;
    const counts = new Map();
    for (const token of tokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    for (const [token, count] of counts.entries()) {
      postings[token] ??= [];
      postings[token].push([chunk.chunkId, count]);
    }
  }
  return {
    schemaVersion: 1,
    indexType: "bm25-lexical",
    chunkCount: chunks.length,
    avgDocLength: chunks.length ? totalLength / chunks.length : 0,
    docLengths,
    postings,
  };
}

async function writePrivateRagDb(root, chunks, embeddings) {
  const dbDir = path.join(root, "private_db");
  await mkdir(path.join(dbDir, "indexes"), { recursive: true });
  await mkdir(path.join(dbDir, "manifests"), { recursive: true });
  await writeFile(
    path.join(dbDir, "indexes", "rag_chunks.jsonl"),
    `${chunks.map((chunk) => JSON.stringify(chunk)).join("\n")}\n`,
  );
  await writeFile(
    path.join(dbDir, "indexes", "lexical_index.json"),
    JSON.stringify(buildPrivateLexicalIndex(chunks)),
  );
  await writeFile(
    path.join(dbDir, "indexes", "embedding_index.jsonl"),
    `${embeddings.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  await writeFile(
    path.join(dbDir, "manifests", "embedding_index_manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      embeddingModel: "BAAI/bge-m3",
      embeddingDimension: 2,
      chunkCount: chunks.length,
    }),
  );
  return dbDir;
}

test("intent classifier keeps ordinary questions on the low-latency path", () => {
  assert.equal(classifyRetrievalIntent("What did the presenter just say?"), "none");
  assert.equal(
    classifyRetrievalIntent("Are there similar historical cases?"),
    "historical-cases",
  );
  assert.equal(
    classifyRetrievalIntent("Can you answer this from previous videos?"),
    "historical-cases",
  );
  assert.equal(
    classifyRetrievalIntent("请从之前的视频里找相关讨论"),
    "historical-cases",
  );
  assert.equal(
    classifyRetrievalIntent("What does PubMed evidence say about treatment?"),
    "literature",
  );
  assert.equal(
    classifyRetrievalIntent("Search medpub for OUD papers"),
    "literature",
  );
  assert.equal(
    classifyRetrievalIntent("比较历史病例和医学文献中的治疗证据"),
    "both",
  );
});

test("deterministic privacy filter rejects identifiers, institutions, and exact dates", () => {
  assert.equal(sanitizeMedicalConcept("major depressive disorder"), "major depressive disorder");
  assert.equal(sanitizeMedicalConcept("john@example.org"), null);
  assert.equal(sanitizeMedicalConcept("Penn State Hospital"), null);
  assert.equal(sanitizeMedicalConcept("admitted on 2026-06-21"), null);
  assert.equal(sanitizeMedicalConcept("MRN 123456789"), null);

  const concepts = sanitizeMedicalConcepts({
    conditions: ["major depressive disorder", "Jane Doe", "jane@example.org"],
    symptoms: ["anhedonia"],
    interventions: ["transcranial magnetic stimulation"],
    tests: [],
    populationAgeBand: "adult",
    comorbidities: ["Penn State Hospital"],
    outcomes: ["symptom remission"],
  }, sensitiveTermsFromLocalText(
    "Patient name is Jane Doe.\n[2026-06-21T10:00:00Z] Jane Doe: reports anhedonia.",
  ));
  const query = buildPubMedQuery(concepts);
  assert.match(query, /major depressive disorder/u);
  assert.match(query, /Humans\[Mesh\]/u);
  assert.doesNotMatch(query, /Jane|example|Penn State/u);
});

test("moudBoostConcepts adds named meds only and never cross-substitutes", () => {
  const methadoneQ =
    "For patients on methadone maintenance with chronic pain, what does the literature say?";
  const boosted = moudBoostConcepts(methadoneQ, ["chronic pain"]);
  assert.ok(boosted.some((c) => /methadone/i.test(c)));
  assert.ok(boosted.some((c) => /opioid use disorder/i.test(c)));
  assert.ok(!boosted.some((c) => /buprenorphine/i.test(c)));
  // Boosts are prepended ahead of extracted concepts.
  assert.ok(boosted.indexOf("methadone") < boosted.indexOf("chronic pain") || boosted[0] !== "chronic pain");

  const bupeQ = "How to start buprenorphine induction for OUD?";
  const bupeBoost = moudBoostConcepts(bupeQ, ["induction"]);
  assert.ok(bupeBoost.some((c) => /buprenorphine/i.test(c)));
  assert.ok(!bupeBoost.some((c) => /methadone/i.test(c)));

  const unrelated = moudBoostConcepts("What does the slide say about TMS?", ["TMS"]);
  assert.deepEqual(unrelated, ["TMS"]);

  const query = buildPubMedQuery(
    moudBoostConcepts(methadoneQ, [
      "chronic pain",
      "pain management in patients on methadone maintenance",
      "effectiveness of pain management in methadone maintenance",
    ]),
    6,
  );
  assert.match(query, /methadone/i);
  assert.match(query, /Humans\[Mesh\]/u);
  assert.doesNotMatch(query, /buprenorphine/i);
  // Overlong phrases are dropped by sanitize; buildPubMedQuery also prefers short clauses.
  assert.doesNotMatch(query, /pain management in patients/i);
});

test("sanitizeMedicalConcept rejects overlong PubMed phrases", () => {
  assert.equal(
    sanitizeMedicalConcept("pain management in patients on methadone maintenance"),
    null,
  );
  assert.equal(sanitizeMedicalConcept("methadone maintenance"), "methadone maintenance");
});

test("answer citations are restricted to immutable retrieval hits", () => {
  const record = {
    transcriptChunks: [{ citationId: "ECHO:abc123def0" }],
    historicalCases: [{ caseId: "case-real" }],
    literature: [{ pmid: "123" }],
  };
  const checked = enforceEvidenceCitationWhitelist(
    "Supported [ECHO:abc123def0] [Case:case-real] [PMID:123] but not [ECHO:nope] [Case:12345] [PMID:999].",
    record,
  );
  assert.equal(
    checked.answer,
    "Supported [ECHO:abc123def0] [Case:case-real] [PMID:123] but not.",
  );
  assert.deepEqual(checked.removed, ["[ECHO:nope]", "[Case:12345]", "[PMID:999]"]);
});

test("allowed ECHO citations render as recording source references", () => {
  const record = {
    transcriptChunks: [
      {
        citationId: "ECHO:abc123def0",
        cohort: "MOUD Cohort 10",
        title: "Session 10_Recording_Perioperative Management of Patients on MOUD_6.11.25",
        recordingPath: "MOUD Cohort 10/Recordings/session10.mp4",
        start: 704.4,
        end: 769.9,
      },
    ],
  };
  const rendered = renderEvidenceSourceReferences(
    "Supported by a prior discussion [ECHO:abc123def0].",
    record,
  );
  assert.equal(
    rendered,
    "Supported by a prior discussion [1].\n\n[1]: MOUD Cohort 10 | Session 10_Recording_Perioperative Management of Patients on MOUD_6.11.25 | 11:44-12:50",
  );
});

test("allowed PMID citations render as literature source references", () => {
  const rendered = renderEvidenceSourceReferences(
    "Supported by a trial [PMID:123].",
    {
      transcriptChunks: [],
      historicalCases: [],
      literature: [
        {
          pmid: "123",
          title: "Evidence for treatment",
          publicationDate: "2025 Jun",
          publicationTypes: ["Clinical Trial"],
        },
      ],
    },
  );
  assert.equal(
    rendered,
    "Supported by a trial [1].\n\n[1]: PMID 123 | Evidence for treatment | 2025 Jun | Clinical Trial",
  );
});

test("PubMed executes best-match and recent searches, deduplicates PMIDs, parses XML, and caches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "echo-pubmed-"));
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/esearch.fcgi")) {
      const recent = parsed.searchParams.get("sort") === "pub date";
      return new Response(
        JSON.stringify({
          esearchresult: { idlist: recent ? ["2", "3"] : ["1", "2"] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      `<?xml version="1.0"?>
      <PubmedArticleSet>
        <PubmedArticle>
          <MedlineCitation>
            <PMID>1</PMID>
            <Article>
              <ArticleTitle>Evidence for treatment</ArticleTitle>
              <Abstract><AbstractText>Symptoms improved in the intervention group.</AbstractText></Abstract>
              <AuthorList><Author><ForeName>Ada</ForeName><LastName>Smith</LastName></Author></AuthorList>
              <Journal>
                <Title>Example Journal</Title>
                <JournalIssue><PubDate><Year>2025</Year><Month>Jun</Month></PubDate></JournalIssue>
              </Journal>
              <PublicationTypeList><PublicationType>Clinical Trial</PublicationType></PublicationTypeList>
            </Article>
          </MedlineCitation>
          <PubmedData><ArticleIdList>
            <ArticleId IdType="doi">10.1000/example</ArticleId>
            <ArticleId IdType="pmc">PMC123</ArticleId>
          </ArticleIdList></PubmedData>
        </PubmedArticle>
      </PubmedArticleSet>`,
      { status: 200, headers: { "content-type": "application/xml" } },
    );
  };
  try {
    const client = new PubMedClient(config(root), fetcher);
    const first = await client.search('"depression"[Title/Abstract]');
    assert.equal(calls.length, 3);
    assert.equal(
      new URL(calls[2]).searchParams.get("id"),
      "1,2,3",
      "merged PMID order should be stable and deduplicated",
    );
    assert.equal(first.length, 1);
    assert.equal(first[0].pmid, "1");
    assert.equal(first[0].doi, "10.1000/example");
    assert.equal(first[0].pmcId, "PMC123");
    assert.equal(first[0].abstract, "Symptoms improved in the intervention group.");

    const second = await client.search('"depression"[Title/Abstract]');
    assert.deepEqual(second, first);
    assert.equal(calls.length, 3, "second request should use the 24-hour cache");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("slow local PubMed reranking falls back to fetched articles instead of failing retrieval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "echo-pubmed-fallback-"));
  let modelCalls = 0;
  const models = {
    async text() {
      modelCalls += 1;
      if (modelCalls === 1) {
        return JSON.stringify({
          conditions: ["opioid use disorder"],
          symptoms: [],
          interventions: ["buprenorphine"],
          tests: [],
          populationAgeBand: null,
          comorbidities: [],
          outcomes: [],
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
      return JSON.stringify({ hits: [] });
    },
    async health() {
      return { ok: true, url: "mock://text" };
    },
  };
  const pubmed = {
    async search() {
      return [
        {
          pmid: "31420089",
          title: "Medications for opioid use disorder",
          authors: [],
          journal: "Example Journal",
          publicationDate: "2019",
          publicationTypes: ["Review"],
          abstract: "Methadone and buprenorphine are effective treatments.",
          doi: null,
          pmcId: null,
          pubmedUrl: "https://pubmed.ncbi.nlm.nih.gov/31420089/",
          doiUrl: null,
          pmcUrl: null,
        },
      ];
    },
  };
  const retrieval = new RetrievalManager(
    config(root, {
      historicalCasesEnabled: false,
      pubmedRerankTimeoutMs: 20,
    }),
    () => {},
    { async get() { return null; } },
    models,
    { async embed() { return []; }, async health() { return { ok: false, url: "" }; } },
    pubmed,
  );
  try {
    const result = await retrieval.retrieveForMeeting({
      question: "Please provide PubMed literature about opioid use disorder",
      context: "",
      streamId: "stream-1",
    });
    assert.equal(result.record.status, "complete");
    assert.equal(result.record.literature.length, 1);
    assert.equal(result.record.literature[0].pmid, "31420089");
    assert.match(result.evidencePacket, /\[PMID:31420089\]/u);
    assert.match(result.evidencePacket, /Abstract excerpt/u);
  } finally {
    await retrieval.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("historical index includes only current complete deidentified cases and preserves sourceRefs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "echo-retrieval-"));
  await writeCase(root, "eligible", "rev-new");
  await writeCase(root, "phi-case", "rev-phi", { phiWarning: true });
  await writeCase(root, "no-case", "rev-none", { caseDetected: false });
  await writeCase(root, "failed-case", "rev-failed", { status: "failed" });
  const oldDirectory = path.join(root, "cases", "eligible", "revisions");
  await writeFile(
    path.join(oldDirectory, "rev-old.json"),
    JSON.stringify(revision("eligible", "rev-old", { overview: "Old revision text" })),
  );

  const models = {
    async health() {
      return { ok: true, url: "mock://text", status: 200 };
    },
    async text(messages) {
      const system = String(messages[0]?.content ?? "");
      if (system.includes("Extract only concise English medical concepts")) {
        return JSON.stringify({
          conditions: ["major depressive disorder"],
          symptoms: ["anhedonia"],
          interventions: ["transcranial magnetic stimulation"],
          tests: [],
          populationAgeBand: "adult",
          comorbidities: [],
          outcomes: ["symptom remission"],
        });
      }
      if (system.includes("Rerank deidentified historical")) {
        return JSON.stringify({
          hits: [
            {
              caseId: "eligible",
              similarities: ["Treatment-resistant depression"],
              keyDifferences: ["Current treatment exposure differs"],
              relevantRecommendationIndexes: [0],
              relevantOutcomeIndexes: [0],
            },
          ],
        });
      }
      if (system.includes("Rerank PubMed")) {
        return JSON.stringify({ hits: [] });
      }
      throw new Error(`Unexpected prompt: ${system}`);
    },
  };
  const embeddings = {
    async health() {
      return { ok: true, url: "mock://embedding", status: 200 };
    },
    async embed(texts) {
      return texts.map((text) =>
        text.toLowerCase().includes("depress") ? [1, 0, 0] : [0, 1, 0],
      );
    },
  };
  const pubmed = { async search() { return []; } };
  const events = [];
  const manager = new RetrievalManager(
    config(root, { pubmedEnabled: false }),
    (type, payload) => events.push({ type, payload }),
    { async get() { return null; } },
    models,
    embeddings,
    pubmed,
  );
  const outputHooks = [];
  manager.setOutputService({
    async onRetrievalCompleted(record) {
      outputHooks.push(record.retrievalId);
    },
  });

  try {
    const index = await manager.rebuildIndex();
    assert.equal(index.entries.length, 1);
    assert.equal(index.entries[0].caseId, "eligible");
    assert.equal(index.entries[0].revisionId, "rev-new");
    assert.doesNotMatch(index.entries[0].indexText, /Old revision text/u);

    const result = await manager.retrieveForMeeting({
      question: "Are there similar historical cases for depression?",
      context: "The current case concerns persistent depressive symptoms.",
      streamId: "meeting-1",
      senderName: "Clinician",
    });
    assert.equal(result.record.status, "complete");
    assert.equal(result.record.historicalCases.length, 1);
    assert.equal(result.record.historicalCases[0].caseId, "eligible");
    assert.deepEqual(
      result.record.historicalCases[0].relevantRecommendations[0].sourceRefs,
      [{ type: "transcript", segmentId: 8, timestamp: 8000 }],
    );
    assert.match(result.evidencePacket, /\[Case:eligible\]/u);

    const saved = JSON.parse(
      await readFile(
        path.join(
          root,
          "retrieval",
          "records",
          `${result.record.retrievalId}.json`,
        ),
        "utf8",
      ),
    );
    assert.equal(saved.streamId, "meeting-1");
    assert.equal(saved.senderName, "Clinician");
    assert.ok(events.some((event) => event.type === "retrieval-completed"));
    assert.deepEqual(outputHooks, [result.record.retrievalId]);
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("private transcript RAG retrieves BM25 candidates, semantic-reranks chunks, and emits Evidence Packet citations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "echo-private-rag-"));
  const chunks = [
    {
      schemaVersion: 1,
      chunkId: "moud-test-session-chunk-0001",
      sessionId: "moud-test-session",
      cohort: "MOUD Cohort Test",
      title: "Illicit buprenorphine discussion",
      recordingPath: "MOUD Cohort Test/Recordings/session.mp4",
      start: 10,
      end: 80,
      speakers: ["Speaker 1"],
      text: "A patient using diverted Suboxone can meet opioid use disorder criteria when there is withdrawal, tolerance, and interference with daily activities.",
    },
    {
      schemaVersion: 1,
      chunkId: "moud-test-session-chunk-0002",
      sessionId: "moud-test-session",
      cohort: "MOUD Cohort Test",
      title: "Unrelated discussion",
      recordingPath: "MOUD Cohort Test/Recordings/session.mp4",
      start: 90,
      end: 120,
      speakers: ["Speaker 2"],
      text: "The group discussed meeting logistics and attendance.",
    },
  ];
  await writePrivateRagDb(root, chunks, [
    { chunkId: chunks[0].chunkId, sessionId: chunks[0].sessionId, embedding: [1, 0] },
    { chunkId: chunks[1].chunkId, sessionId: chunks[1].sessionId, embedding: [0, 1] },
  ]);
  const models = {
    async health() {
      return { ok: true, url: "mock://text", status: 200 };
    },
    async text(messages) {
      const system = String(messages[0]?.content ?? "");
      if (system.includes("Extract only concise English medical concepts")) {
        return JSON.stringify({
          conditions: ["opioid use disorder"],
          symptoms: ["withdrawal", "cravings"],
          interventions: ["buprenorphine", "Suboxone"],
          tests: [],
          populationAgeBand: "adult",
          comorbidities: [],
          outcomes: [],
        });
      }
      throw new Error(`Unexpected prompt: ${system}`);
    },
  };
  const embeddings = {
    async health() {
      return { ok: true, url: "mock://embedding", status: 200 };
    },
    async embed(texts) {
      return texts.map(() => [1, 0]);
    },
  };
  const manager = new RetrievalManager(
    config(root, {
      historicalCasesEnabled: false,
      privateRagEnabled: true,
      privateRagDbDir: path.join(root, "private_db"),
      privateRagBm25K: 100,
      privateRagTopK: 10,
      pubmedEnabled: false,
    }),
    () => {},
    { async get() { return null; } },
    models,
    embeddings,
    { async search() { return []; } },
  );

  try {
    await manager.start();
    const result = await manager.retrieveForMeeting({
      question: "From previous videos, can a patient meet criteria for opioid use disorder based only on illicit Suboxone or buprenorphine use?",
      context: "",
      streamId: "stream-1",
    });
    assert.equal(result.record.status, "complete");
    assert.equal(result.record.intent, "historical-cases");
    assert.equal(result.record.transcriptChunks.length, 1);
    assert.equal(result.record.transcriptChunks[0].chunkId, chunks[0].chunkId);
    assert.match(result.record.transcriptChunks[0].citationId, /^ECHO:[a-f0-9]{10}$/u);
    assert.match(result.evidencePacket, /\[ECHO:[a-f0-9]{10}\]/u);
    assert.match(result.evidencePacket, /diverted Suboxone/u);
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("literature requests fall back to private transcript RAG when PubMed fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "echo-pubmed-fallback-"));
  const chunks = [
    {
      schemaVersion: 1,
      chunkId: "moud-craving-chunk-0001",
      sessionId: "moud-craving-session",
      cohort: "MOUD Cohort Test",
      title: "Cravings on buprenorphine discussion",
      recordingPath: "MOUD Cohort Test/Recordings/session.mp4",
      start: 10,
      end: 80,
      speakers: ["Speaker 1"],
      text: "When a patient on buprenorphine still has cravings, the group discussed dose reassessment, adherence barriers, and counseling supports.",
    },
  ];
  await writePrivateRagDb(root, chunks, [
    { chunkId: chunks[0].chunkId, sessionId: chunks[0].sessionId, embedding: [1, 0] },
  ]);
  const events = [];
  const manager = new RetrievalManager(
    config(root, {
      historicalCasesEnabled: false,
      privateRagEnabled: true,
      privateRagDbDir: path.join(root, "private_db"),
      privateRagBm25K: 100,
      privateRagTopK: 3,
      pubmedEnabled: true,
      pubmedEmail: "echo@example.com",
      pubmedRerankTimeoutMs: 20,
      sourceTimeoutMs: 2000,
      totalTimeoutMs: 8000,
    }),
    (type, payload) => events.push({ type, payload }),
    { async get() { return null; } },
    {
      async health() {
        return { ok: true };
      },
      async text() {
        return JSON.stringify({
          conditions: ["opioid use disorder"],
          symptoms: ["cravings"],
          interventions: ["buprenorphine"],
          tests: [],
          populationAgeBand: null,
          comorbidities: [],
          outcomes: [],
        });
      },
    },
    {
      async health() {
        return { ok: true };
      },
      async embed() {
        return [[1, 0]];
      },
    },
    {
      async search() {
        throw new Error("PubMed retrieval timed out after 19572ms");
      },
    },
  );
  try {
    const result = await manager.retrieveForMeeting({
      question: "what helps when a patient on buprenorphine still has cravings? recommend",
      context: "",
      streamId: "stream-1",
    });
    assert.equal(result.record?.intent, "literature");
    assert.equal(result.record?.literature?.length ?? 0, 0);
    assert.ok((result.record?.transcriptChunks?.length ?? 0) > 0);
    assert.match(
      result.record.warnings.join(" "),
      /fell back to prior ECHO transcript chunks/u,
    );
    assert.match(result.evidencePacket, /\[ECHO:/u);
    assert.ok(
      events.some((event) => event.type === "retrieval-private-rag-fallback"),
    );
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("literature requests recover PubMed query terms from the question when extraction returns no safe concepts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "echo-pubmed-question-fallback-"));
  let pubmedQuery = null;
  const manager = new RetrievalManager(
    config(root, {
      historicalCasesEnabled: false,
      privateRagEnabled: false,
      pubmedEnabled: true,
      pubmedEmail: "echo@example.com",
      pubmedRerankTimeoutMs: 20,
    }),
    () => {},
    { async get() { return null; } },
    {
      async health() {
        return { ok: true };
      },
      async text() {
        return JSON.stringify({
          conditions: [],
          symptoms: [],
          interventions: [],
          tests: [],
          populationAgeBand: null,
          comorbidities: [],
          outcomes: [],
        });
      },
    },
    {
      async health() {
        return { ok: true };
      },
      async embed() {
        return [[0.1, 0.2]];
      },
    },
    {
      async search(query) {
        pubmedQuery = query;
        return [
          {
            pmid: "12345678",
            title: "Dementia treatment review",
            authors: [],
            journal: "Example Journal",
            publicationDate: "2025",
            publicationTypes: ["Review"],
            abstract: "There is no cure for dementia; current therapies are symptomatic.",
            doi: null,
            pmcId: null,
            pubmedUrl: "https://pubmed.ncbi.nlm.nih.gov/12345678/",
            doiUrl: null,
            pmcUrl: null,
          },
        ];
      },
    },
  );
  try {
    const result = await manager.retrieveForMeeting({
      question: "@ECHO AI Assistant recommend a cure of dementia, citing public medical sources",
      context: "",
      streamId: "stream-1",
    });
    assert.equal(result.record?.intent, "literature");
    assert.ok((result.record?.sanitizedMedicalConcepts ?? []).length > 0);
    assert.match((result.record?.sanitizedMedicalConcepts ?? []).join(" "), /dementia/u);
    assert.match(pubmedQuery ?? "", /dementia/u);
    assert.equal(result.record?.literature?.[0]?.pmid, "12345678");
    assert.match(
      result.record.warnings.join(" "),
      /fell back to sanitized question keywords/u,
    );
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit public-source requests do not substitute private ECHO citations when PubMed fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "echo-public-source-no-echo-fallback-"));
  const chunks = [
    {
      schemaVersion: 1,
      chunkId: "moud-dementia-chunk-0001",
      sessionId: "moud-session",
      cohort: "MOUD Cohort Test",
      title: "Irrelevant transcript",
      recordingPath: "MOUD Cohort Test/Recordings/session.mp4",
      start: 5,
      end: 35,
      speakers: ["Speaker 1"],
      text: "The group discussed counseling and follow-up.",
    },
  ];
  await writePrivateRagDb(root, chunks, [
    { chunkId: chunks[0].chunkId, sessionId: chunks[0].sessionId, embedding: [1, 0] },
  ]);
  const manager = new RetrievalManager(
    config(root, {
      historicalCasesEnabled: false,
      privateRagEnabled: true,
      privateRagDbDir: path.join(root, "private_db"),
      privateRagBm25K: 100,
      privateRagTopK: 3,
      pubmedEnabled: true,
      pubmedEmail: "echo@example.com",
      pubmedRerankTimeoutMs: 20,
      sourceTimeoutMs: 2000,
      totalTimeoutMs: 8000,
    }),
    () => {},
    { async get() { return null; } },
    {
      async health() {
        return { ok: true };
      },
      async text() {
        return JSON.stringify({
          conditions: [],
          symptoms: [],
          interventions: [],
          tests: [],
          populationAgeBand: null,
          comorbidities: [],
          outcomes: [],
        });
      },
    },
    {
      async health() {
        return { ok: true };
      },
      async embed() {
        return [[1, 0]];
      },
    },
    {
      async search() {
        throw new Error("PubMed retrieval timed out after 19572ms");
      },
    },
  );
  try {
    const result = await manager.retrieveForMeeting({
      question: "@ECHO AI Assistant recommend a cure of dementia, citing public medical sources",
      context: "",
      streamId: "stream-1",
    });
    assert.equal(result.record?.intent, "literature");
    assert.equal(result.record?.literature?.length ?? 0, 0);
    assert.equal(result.record?.transcriptChunks?.length ?? 0, 0);
    assert.doesNotMatch(result.record.warnings.join(" "), /fell back to prior ECHO transcript chunks/u);
    assert.doesNotMatch(result.evidencePacket, /\[ECHO:/u);
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("private transcript RAG does not run for ordinary clinical questions without previous-video trigger", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "echo-private-rag-off-path-"));
  const manager = new RetrievalManager(
    config(root, {
      historicalCasesEnabled: false,
      privateRagEnabled: true,
      pubmedEnabled: false,
    }),
    () => {},
    { async get() { return null; } },
    {
      async health() {
        throw new Error("health should not be called");
      },
      async text() {
        throw new Error("concept extraction should not run");
      },
    },
    {
      async health() {
        throw new Error("embedding health should not run");
      },
      async embed() {
        throw new Error("embedding should not run");
      },
    },
    { async search() { return []; } },
  );
  try {
    const result = await manager.retrieveForMeeting({
      question: "Can a patient meet criteria for opioid use disorder based only on illicit Suboxone use?",
      context: "",
      streamId: "stream-1",
    });
    assert.equal(result.record, null);
    assert.equal(result.evidencePacket, "");
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary clinical questions request literature when PubMed retrieval is enabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "echo-clinical-lit-"));
  const events = [];
  const pubmed = {
    async search() {
      return [
        {
          pmid: "31420089",
          title: "Medications for opioid use disorder",
          authors: [],
          journal: "Example Journal",
          publicationDate: "2019",
          publicationTypes: ["Review"],
          abstract: "Buprenorphine is an effective treatment.",
          doi: null,
          pmcId: null,
          pubmedUrl: "https://pubmed.ncbi.nlm.nih.gov/31420089/",
          doiUrl: null,
          pmcUrl: null,
        },
      ];
    },
  };
  const manager = new RetrievalManager(
    config(root, {
      historicalCasesEnabled: false,
      privateRagEnabled: false,
      pubmedEnabled: true,
      pubmedEmail: "echo@example.com",
      pubmedRerankTimeoutMs: 20,
    }),
    (type, payload) => events.push({ type, payload }),
    { async get() { return null; } },
    {
      async health() {
        return { ok: true };
      },
      async text() {
        return JSON.stringify({
          conditions: ["opioid use disorder"],
          symptoms: [],
          interventions: ["buprenorphine"],
          tests: [],
          populationAgeBand: null,
          comorbidities: [],
          outcomes: [],
        });
      },
    },
    {
      async health() {
        return { ok: true };
      },
      async embed() {
        return [[0.1, 0.2]];
      },
    },
    pubmed,
  );
  try {
    const result = await manager.retrieveForMeeting({
      question: "What dose of buprenorphine is used for OUD induction?",
      context: "",
      streamId: "stream-1",
    });
    assert.equal(result.record?.intent, "literature");
    assert.equal(result.record?.literature?.[0]?.pmid, "31420089");
    assert.ok(
      events.some(
        (event) =>
          event.type === "retrieval-intent-classified" &&
          event.payload?.intent === "literature",
      ),
    );
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("disabled retrieval creates no data directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "echo-retrieval-off-"));
  const manager = new RetrievalManager(
    config(root, { enabled: false }),
    () => {},
    { async get() { return null; } },
  );
  try {
    await manager.start();
    await assert.rejects(readFile(path.join(root, "retrieval", "cases", "index.json")));
    assert.equal(manager.health().enabled, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("case localhost service exposes asynchronous retrieval routes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "echo-retrieval-api-"));
  const models = {
    async health() {
      return { ok: true, url: "mock://text", status: 200 };
    },
    async text(messages) {
      if (
        String(messages[0]?.content ?? "").includes(
          "Extract only concise English medical concepts",
        )
      ) {
        return JSON.stringify({
          conditions: ["major depressive disorder"],
          symptoms: [],
          interventions: [],
          tests: [],
          populationAgeBand: "adult",
          comorbidities: [],
          outcomes: [],
        });
      }
      throw new Error("Unexpected model call");
    },
  };
  const embeddings = {
    async health() {
      return { ok: true, url: "mock://embedding", status: 200 };
    },
    async embed(texts) {
      return texts.map(() => [1, 0, 0]);
    },
  };
  const caseManager = new CaseWorkspaceManager(
    {
      enabled: true,
      available: true,
      unavailableReasons: [],
      host: "127.0.0.1",
      port: 0,
      dataDir: path.join(root, "cases"),
      rtmsDataDir: path.join(root, "rtms"),
      transcriptChunkChars: 8000,
      maxScreenFrames: 30,
      jsonRepairAttempts: 2,
      textBaseUrl: "mock://text",
      textModel: "mock",
      textApiKey: "",
      vlmBaseUrl: "mock://vision",
      vlmModel: "mock",
      vlmApiKey: "",
      maxImageBytes: 2500000,
    },
    () => {},
    async () => null,
    {
      async text() { throw new Error("unused"); },
      async vision() { throw new Error("unused"); },
      async health() {
        return {
          text: { ok: true, url: "mock://text" },
          vision: { ok: true, url: "mock://vision" },
        };
      },
    },
  );
  const retrieval = new RetrievalManager(
    config(root, { pubmedEnabled: false }),
    () => {},
    { get: (caseId) => caseManager.get(caseId) },
    models,
    embeddings,
    { async search() { return []; } },
  );
  caseManager.setRetrievalService(retrieval);
  try {
    await retrieval.start();
    await caseManager.start();
    const port = caseManager.health().listeningPort;
    const healthResponse = await fetch(`http://127.0.0.1:${port}/retrieval/health`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.retrieval.enabled, true);

    const searchResponse = await fetch(`http://127.0.0.1:${port}/retrieval/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "What evidence supports treatment for depression?",
        literature: false,
      }),
    });
    assert.equal(searchResponse.status, 202);
    const queued = await searchResponse.json();
    assert.equal(queued.record.status, "queued");
    assert.equal(queued.record.intent, "historical-cases");

    const missingCase = await fetch(
      `http://127.0.0.1:${port}/cases/not-found/retrievals`,
    );
    assert.equal(missingCase.status, 404);
  } finally {
    await retrieval.shutdown();
    await caseManager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("meeting QA injects the Evidence Packet and preserves Case/PMID citations", async () => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    requests.push(body);
    const isFormatter = body.model === "formatter";
    const content = isFormatter
      ? "历史病例与研究均支持该方向 [Case:case-1] [PMID:123]."
      : "Candidate answer [Case:case-1] [PMID:123].";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const manager = new MeetingAiManager(
    {
      enabled: true,
      dataDir: await mkdtemp(path.join(os.tmpdir(), "echo-meeting-retrieval-")),
      asrEnabled: false,
      asrServiceUrl: "http://127.0.0.1:7001",
      asrChunkSeconds: 5,
      asrOverlapSeconds: 1,
      asrSpeechRmsThreshold: 200,
      asrSpeechPrerollMs: 250,
      vlmBaseUrl: `http://127.0.0.1:${port}/v1`,
      vlmModel: "vlm",
      vlmApiKey: "",
      vlmMaxTokens: 512,
      ragVlmMaxTokens: 768,
      vlmEnableThinking: false,
      answerLlmEnabled: true,
      answerLlmBaseUrl: `http://127.0.0.1:${port}/v1`,
      answerLlmModel: "formatter",
      answerLlmApiKey: "",
      answerLlmMaxTokens: 220,
      answerLlmMaxChars: 800,
      ragAnswerLlmMaxTokens: 320,
      ragAnswerLlmMaxChars: 1200,
      literatureAnswerMaxTokens: 600,
      literatureAnswerMaxChars: 2400,
      answerStyle: "concise",
      answerLlmEnableThinking: false,
      contextMode: "full-with-summary-fallback",
      screenShareEnabled: false,
      screenShareMaxImages: 0,
      screenShareMemoryLimit: 200,
      screenShareMaxImageBytes: 2500000,
      fullContextMaxChars: 20000,
      recentContextMaxChars: 6000,
      relevantContextMaxChars: 6000,
      summaryUpdateSeconds: 60,
      summaryUpdateChars: 1500,
      asrIdleFlushMs: 900,
      voiceInvocationEnabled: false,
      voiceInvocationAvailable: false,
      voiceInvocationUnavailableReasons: ["disabled for test"],
      voiceWakePhrases: ["hello echo ai"],
      voiceFollowupTimeoutMs: 12000,
      voiceMaxQuestionMs: 30000,
      voiceMaxQuestionChars: 1000,
      voiceCooldownMs: 5000,
    },
    () => {},
    async () => ({}),
  );
  manager.setEvidenceRetriever({
    async retrieveForMeeting() {
      return {
        record: {
          schemaVersion: 1,
          retrievalId: "retrieval-1",
          streamId: "stream-1",
          question: "What evidence supports this treatment?",
          intent: "both",
          sanitizedMedicalConcepts: ["major depressive disorder"],
          status: "complete",
          historicalCases: [
            {
              caseId: "case-1",
              revisionId: "revision-1",
              similarityScore: 0.9,
              similarities: ["similar treatment"],
              keyDifferences: [],
              relevantRecommendations: [],
              relevantOutcomes: [],
            },
          ],
          literature: [
            {
              pmid: "123",
              title: "Supporting study",
              authors: [],
              journal: null,
              publicationDate: "2025",
              publicationTypes: [],
              abstract: "The treatment improved outcomes.",
              doi: null,
              pmcId: null,
              pubmedUrl: "https://pubmed.ncbi.nlm.nih.gov/123/",
              doiUrl: null,
              pmcUrl: null,
              relevanceReason: "Relevant",
              abstractSupportedConclusion: "Treatment improved outcomes.",
              warnings: [],
            },
          ],
          warnings: [],
          createdAt: "2026-06-21T12:00:00.000Z",
          completedAt: "2026-06-21T12:00:01.000Z",
        },
        evidencePacket:
          "Evidence Packet:\n[Case:case-1] Similar historical case.\n[PMID:123] Supporting study.",
      };
    },
  });
  try {
    const result = await manager.ask({
      question: "What evidence supports this treatment?",
      streamId: "stream-1",
      senderName: "Clinician",
      replyType: "manual",
    });
    assert.match(result.answer, /\[1\].*\[2\]/su);
    assert.match(result.answer, /Case case-1/u);
    assert.match(result.answer, /PMID 123/u);
    assert.match(
      result.answer,
      /Educational summary for ECHO discussion; not clinical advice or a medical record\./u,
    );
    assert.equal(result.retrievalRecord.retrievalId, "retrieval-1");
    assert.match(JSON.stringify(requests[0]), /Evidence Packet/u);
    assert.match(JSON.stringify(requests[0]), /\[PMID:123\]/u);
    assert.match(
      String(requests[1].messages[0].content),
      /Preserve only these supplied citation IDs exactly/u,
    );
  } finally {
    const dataDir = manager.health().dataDir;
    await manager.shutdown();
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("meeting QA uses private transcript RAG as VLM support evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "echo-meeting-private-rag-"));
  const chunks = [
    {
      schemaVersion: 1,
      chunkId: "moud-test-session-chunk-0001",
      sessionId: "moud-test-session",
      cohort: "MOUD Cohort Test",
      title: "Illicit buprenorphine discussion",
      recordingPath: "MOUD Cohort Test/Recordings/session.mp4",
      start: 10,
      end: 80,
      speakers: ["Speaker 1"],
      text: "A patient using illicit Suboxone or buprenorphine can meet opioid use disorder criteria when use causes withdrawal, tolerance, and interference with daily activities.",
    },
  ];
  await writePrivateRagDb(root, chunks, [
    { chunkId: chunks[0].chunkId, sessionId: chunks[0].sessionId, embedding: [1, 0] },
  ]);

  const requests = [];
  let echoCitation = null;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    requests.push(body);
    const prompt = JSON.stringify(body.messages ?? []);
    echoCitation = echoCitation ?? prompt.match(/\[ECHO:[^\]]+\]/u)?.[0] ?? null;
    const isFormatter = body.model === "formatter";
    const content = isFormatter
      ? `Yes. The retrieved ECHO discussion supports applying DSM criteria such as withdrawal, tolerance, and interference with daily activities ${echoCitation}.`
      : `Candidate answer: yes, this can meet OUD criteria when withdrawal, tolerance, and functional interference are present ${echoCitation}.`;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const dataDir = path.join(root, "meeting-ai");
  const manager = new MeetingAiManager(
    {
      enabled: true,
      dataDir,
      asrEnabled: false,
      asrServiceUrl: "http://127.0.0.1:7001",
      asrChunkSeconds: 5,
      asrOverlapSeconds: 1,
      asrSpeechRmsThreshold: 200,
      asrSpeechPrerollMs: 250,
      vlmBaseUrl: `http://127.0.0.1:${port}/v1`,
      vlmModel: "vlm",
      vlmApiKey: "",
      vlmMaxTokens: 512,
      ragVlmMaxTokens: 768,
      vlmEnableThinking: false,
      answerLlmEnabled: true,
      answerLlmBaseUrl: `http://127.0.0.1:${port}/v1`,
      answerLlmModel: "formatter",
      answerLlmApiKey: "",
      answerLlmMaxTokens: 220,
      answerLlmMaxChars: 800,
      ragAnswerLlmMaxTokens: 320,
      ragAnswerLlmMaxChars: 1200,
      literatureAnswerMaxTokens: 600,
      literatureAnswerMaxChars: 2400,
      answerStyle: "concise",
      answerLlmEnableThinking: false,
      contextMode: "full-with-summary-fallback",
      screenShareEnabled: false,
      screenShareMaxImages: 0,
      screenShareMemoryLimit: 200,
      screenShareMaxImageBytes: 2500000,
      fullContextMaxChars: 20000,
      recentContextMaxChars: 6000,
      relevantContextMaxChars: 6000,
      summaryUpdateSeconds: 60,
      summaryUpdateChars: 1500,
      asrIdleFlushMs: 900,
      voiceInvocationEnabled: false,
      voiceInvocationAvailable: false,
      voiceInvocationUnavailableReasons: ["disabled for test"],
      voiceWakePhrases: ["hello echo ai"],
      voiceFollowupTimeoutMs: 12000,
      voiceMaxQuestionMs: 30000,
      voiceMaxQuestionChars: 1000,
      voiceCooldownMs: 5000,
    },
    () => {},
    async () => ({}),
  );
  const retrieval = new RetrievalManager(
    config(root, {
      historicalCasesEnabled: false,
      privateRagEnabled: true,
      privateRagDbDir: path.join(root, "private_db"),
      privateRagBm25K: 100,
      privateRagTopK: 10,
      pubmedEnabled: false,
    }),
    () => {},
    { async get() { return null; } },
    {
      async health() {
        return { ok: true, url: "mock://text", status: 200 };
      },
      async text(messages) {
        const system = String(messages[0]?.content ?? "");
        if (system.includes("Extract only concise English medical concepts")) {
          return JSON.stringify({
            conditions: ["opioid use disorder"],
            symptoms: ["withdrawal"],
            interventions: ["Suboxone", "buprenorphine"],
            tests: [],
            populationAgeBand: "adult",
            comorbidities: [],
            outcomes: ["interference with daily activities"],
          });
        }
        throw new Error(`Unexpected prompt: ${system}`);
      },
    },
    {
      async health() {
        return { ok: true, url: "mock://embedding", status: 200 };
      },
      async embed(texts) {
        return texts.map(() => [1, 0]);
      },
    },
    { async search() { return []; } },
  );
  manager.setEvidenceRetriever(retrieval);

  try {
    await retrieval.start();
    const result = await manager.ask({
      question: "From previous videos, can a patient meet criteria for opioid use disorder based only on illicit Suboxone or buprenorphine use?",
      streamId: "stream-1",
      senderName: "Clinician",
      // Zoom-path reply: private transcript index is allowed (public web uses replyType manual).
      replyType: "public-mention",
    });
    assert.equal(result.retrievalRecord.transcriptChunks.length, 1);
    assert.doesNotMatch(result.answer, /\[ECHO:[a-f0-9]{10}\]/u);
    assert.match(
      result.answer,
      /\[1\]: MOUD Cohort Test \| Illicit buprenorphine discussion \| 0:10-1:20/u,
    );
    assert.equal(result.answer.includes("[Case:"), false);
    assert.match(JSON.stringify(requests[0]), /Evidence Packet/u);
    assert.match(JSON.stringify(requests[0]), /illicit Suboxone/u);
    assert.equal(requests[0].max_tokens, 768);
    // concise clinical/RAG answers are capped at 160 tokens (demo Zoom ceiling).
    assert.equal(requests[1].max_tokens, 160);
    assert.match(
      String(requests[1].messages[0].content),
      /Preserve only these supplied citation IDs exactly/u,
    );
  } finally {
    await retrieval.shutdown();
    await manager.shutdown();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
