import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { Express } from "express";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import type {
  CaseRevision,
  CaseWorkspace,
  CaseLlmMessage,
} from "./caseWorkspace.js";

export type RetrievalIntent =
  | "none"
  | "historical-cases"
  | "literature"
  | "both";

export type RetrievalStatus =
  | "queued"
  | "processing"
  | "complete"
  | "partial"
  | "failed";

export type RetrievalConfig = {
  enabled: boolean;
  historicalCasesEnabled: boolean;
  pubmedEnabled: boolean;
  dataDir: string;
  caseDataDir: string;
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingApiKey: string;
  embeddingGpu: number;
  caseCandidates: number;
  caseTopK: number;
  privateRagEnabled: boolean;
  privateRagDbDir: string;
  privateRagBm25K: number;
  privateRagTopK: number;
  privateRagBlend: boolean;
  privateRagSemanticWeight: number;
  privateRagAlwaysOn: boolean;
  privateRagMaxExcerptChars: number;
  pubmedEmail: string;
  pubmedApiKey: string;
  pubmedTool: string;
  pubmedBestMatchCount: number;
  pubmedRecentCount: number;
  pubmedRecentYears: number;
  pubmedFinalCount: number;
  pubmedQueryConcepts: number;
  pubmedRerankTimeoutMs: number;
  pubmedRerankAbstractChars: number;
  pubmedCacheTtlSeconds: number;
  sourceTimeoutMs: number;
  totalTimeoutMs: number;
  textBaseUrl: string;
  textModel: string;
  textApiKey: string;
};

export type RetrievalEventEmitter = (type: string, payload?: unknown) => void;

export type RetrievalOutputService = {
  onRetrievalCompleted(record: RetrievalRecord): Promise<void>;
};

export type RetrievalSourceRef =
  | { type: "transcript"; segmentId: number; timestamp: number }
  | { type: "screen-frame"; frameId: number; timestamp: number };

export type HistoricalCaseHit = {
  caseId: string;
  revisionId: string;
  similarityScore: number;
  similarities: string[];
  keyDifferences: string[];
  relevantRecommendations: Array<{
    text: string;
    sourceRefs: RetrievalSourceRef[];
  }>;
  relevantOutcomes: Array<{
    text: string;
    sourceRefs: RetrievalSourceRef[];
  }>;
};

export type TranscriptRagHit = {
  citationId: string;
  chunkId: string;
  sessionId: string;
  cohort: string;
  title: string;
  recordingPath: string;
  start: number;
  end: number;
  speakers: string[];
  text: string;
  bm25Rank: number;
  bm25Score: number;
  semanticScore: number;
  hybridScore: number;
};

export type PubMedHit = {
  pmid: string;
  title: string;
  authors: string[];
  journal: string | null;
  publicationDate: string | null;
  publicationTypes: string[];
  abstract: string | null;
  doi: string | null;
  pmcId: string | null;
  pubmedUrl: string;
  doiUrl: string | null;
  pmcUrl: string | null;
  relevanceReason: string;
  abstractSupportedConclusion: string | null;
  warnings: string[];
};

export type MedicalConcepts = {
  conditions: string[];
  symptoms: string[];
  interventions: string[];
  tests: string[];
  populationAgeBand: string | null;
  comorbidities: string[];
  outcomes: string[];
};

export type RetrievalRecord = {
  schemaVersion: 1;
  retrievalId: string;
  caseId?: string;
  revisionId?: string;
  streamId?: string;
  senderUserId?: number;
  senderName?: string;
  question: string;
  intent: RetrievalIntent;
  sanitizedMedicalConcepts: string[];
  outboundPubMedQuery?: string;
  status: RetrievalStatus;
  historicalCases: HistoricalCaseHit[];
  transcriptChunks: TranscriptRagHit[];
  literature: PubMedHit[];
  warnings: string[];
  indexVersion?: string;
  createdAt: string;
  completedAt?: string;
};

export type MeetingRetrievalInput = {
  question: string;
  context: string;
  streamId?: string;
  senderUserId?: number;
  senderName?: string;
  /** Zoom chat and voice may search the institutional transcript index. The public page must not. */
  allowPrivateIndex?: boolean;
};

export type MeetingRetrievalResult = {
  record: RetrievalRecord | null;
  evidencePacket: string;
};

type CaseProvider = {
  get(caseId: string): Promise<{
    workspace: CaseWorkspace;
    currentRevision: CaseRevision | null;
  } | null>;
};

type RetrievalModelClient = {
  text(messages: CaseLlmMessage[], maxTokens: number): Promise<string>;
  health(): Promise<{ ok: boolean; url: string; status?: number; error?: string }>;
};

type EmbeddingClient = {
  embed(texts: string[]): Promise<number[][]>;
  health(): Promise<{ ok: boolean; url: string; status?: number; error?: string }>;
};

type HistoricalIndexEntry = {
  caseId: string;
  revisionId: string;
  generatedAt: string;
  indexText: string;
  embedding: number[];
  overview: Array<{ text: string; sourceRefs: RetrievalSourceRef[] }>;
  recommendations: Array<{ text: string; sourceRefs: RetrievalSourceRef[] }>;
  outcomes: Array<{ text: string; sourceRefs: RetrievalSourceRef[] }>;
};

type HistoricalIndexSnapshot = {
  schemaVersion: 1;
  indexVersion: string;
  embeddingModel: string;
  embeddingDimension: number;
  builtAt: string;
  entries: HistoricalIndexEntry[];
};

type PrivateRagChunk = {
  chunkId: string;
  sessionId: string;
  cohort: string;
  title: string;
  recordingPath: string;
  start: number;
  end: number;
  speakers?: string[];
  text: string;
};

type PrivateRagEmbedding = {
  chunkId: string;
  embedding: number[];
};

type LexicalIndexSnapshot = {
  schemaVersion: number;
  builtAt?: string;
  indexType?: string;
  chunkCount: number;
  avgDocLength: number;
  docLengths: Record<string, number>;
  postings: Record<string, Array<[string, number]>>;
};

type PrivateRagIndexSnapshot = {
  dbDir: string;
  manifest: Record<string, unknown> | null;
  chunkCount: number;
  embeddingDimension: number;
  lexicalIndex: LexicalIndexSnapshot;
  chunks: PrivateRagChunk[];
  chunksById: Map<string, PrivateRagChunk>;
  embeddingsByChunkId: Map<string, number[]>;
};

type SearchInput = {
  question: string;
  context?: string;
  intent?: RetrievalIntent;
  caseId?: string;
  revisionId?: string;
  streamId?: string;
  senderUserId?: number;
  senderName?: string;
  forceHistorical?: boolean;
  forcePubmed?: boolean;
  allowPrivateIndex?: boolean;
};

type PubMedArticle = Omit<
  PubMedHit,
  "relevanceReason" | "abstractSupportedConclusion" | "warnings"
>;

const conceptSchema = z.object({
  conditions: z.array(z.string()).default([]),
  symptoms: z.array(z.string()).default([]),
  interventions: z.array(z.string()).default([]),
  tests: z.array(z.string()).default([]),
  populationAgeBand: z.string().nullable().default(null),
  comorbidities: z.array(z.string()).default([]),
  outcomes: z.array(z.string()).default([]),
});

const historicalRerankSchema = z.object({
  hits: z.array(
    z.object({
      caseId: z.string(),
      similarities: z.array(z.string()).default([]),
      keyDifferences: z.array(z.string()).default([]),
      relevantRecommendationIndexes: z.array(z.number().int().nonnegative()).default([]),
      relevantOutcomeIndexes: z.array(z.number().int().nonnegative()).default([]),
    }),
  ),
});

const literatureRerankSchema = z.object({
  hits: z.array(
    z.object({
      pmid: z.string(),
      relevanceReason: z.string(),
      abstractSupportedConclusion: z.string().nullable().default(null),
    }),
  ),
});

const XML = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: true,
});

const INDEX_CATEGORIES: Array<keyof CaseRevision> = [
  "caseOverview",
  "presentingQuestions",
  "patientContext",
  "historyAndConditions",
  "medicationsAndTreatments",
  "testsAndFindings",
  "discussionThreads",
  "recommendations",
  "rejectedOrRevisedSuggestions",
  "disagreements",
  "unresolvedQuestionsAndDataGaps",
  "followUpActions",
];

const PRIVATE_RAG_STOPWORDS = new Set([
  "a",
  "about",
  "after",
  "also",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "case",
  "cases",
  "cohort",
  "could",
  "do",
  "does",
  "echo",
  "for",
  "from",
  "have",
  "how",
  "if",
  "in",
  "into",
  "is",
  "it",
  "moud",
  "not",
  "of",
  "on",
  "or",
  "oud",
  "patient",
  "patients",
  "recording",
  "session",
  "should",
  "that",
  "the",
  "their",
  "then",
  "there",
  "this",
  "to",
  "video",
  "was",
  "we",
  "what",
  "when",
  "where",
  "with",
  "would",
  "you",
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function textValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }
  if (Array.isArray(value)) {
    return value.map(textValue).filter(Boolean).join(" ").trim();
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if ("#text" in object) {
      return textValue(object["#text"]);
    }
    return Object.entries(object)
      .filter(([key]) => !key.startsWith("@_"))
      .map(([, item]) => textValue(item))
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  return "";
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function normalizeEmbedding(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new Error("Embedding service returned a zero or invalid vector");
  }
  return vector.map((value) => value / magnitude);
}

function cosine(left: number[], right: number[]): number {
  if (left.length !== right.length) {
    return -1;
  }
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  const text = await readFile(filePath, "utf8");
  return text
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function parseJsonObject(value: string): unknown {
  const cleaned = value
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("Model response did not contain a JSON object");
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
      milliseconds,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function retryDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function privateRagTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9']+/gu, " ")
    .split(/\s+/u)
    .map((token) => token.replace(/^'+|'+$/gu, ""))
    .filter((token) => token.length >= 2 && !PRIVATE_RAG_STOPWORDS.has(token));
}

export function looksLikeClinicalQuestion(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    /\b(patient|patients|diagnos(?:e|is|tic)|criteria|dsm|opioid|oud|moud|buprenorphine|suboxone|subutex|sublocade|methadone|naltrexone|vivitrol|withdrawal|craving|cravings|chronic pain|pregnan|newborn|breastfeed|capacity|treatment|treat(?:ing|ed)?|manage(?:ment|ing)?|medication|meds?|dose|dosing|taper|induction|contraindicat|adverse|side effect|efficac(?:y|ious)|surgery|injection|mental health|clinical|symptom|therapy|prescrib)\b/u.test(
      normalized,
    ) ||
    /(患者|诊断|标准|阿片|丁丙诺啡|美沙酮|纳曲酮|戒断|疼痛|怀孕|新生儿|母乳|治疗|药物|剂量|手术|精神|临床|症状|疗效|副作用|禁忌|capacity)/u.test(
      value,
    )
  );
}

function asksForPreviousVideoEvidence(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    /\b(?:from|in|based on|according to|using|search|check|look up|retrieve|find|compare|across)\s+(?:the\s+)?(?:previous|prior|past|historical|old|earlier)\s+(?:echo\s+)?(?:video|videos|recording|recordings|session|sessions|meeting|meetings|transcript|transcripts)\b/u.test(
      normalized,
    ) ||
    /\b(?:previous|prior|past|historical|old|earlier)\s+(?:echo\s+)?(?:video|videos|recording|recordings|session|sessions|meeting|meetings|transcript|transcripts)\b/u.test(
      normalized,
    ) ||
    /\b(?:video|videos|recording|recordings|session|sessions|meeting|meetings|transcript|transcripts)\s+(?:from\s+)?(?:previous|prior|past|historical|old|earlier)\b/u.test(
      normalized,
    ) ||
    /(之前|以前|历史|过往|既往|前面|过去).{0,8}(视频|录像|录制|转录|会议|课程|session|recording|transcript)/iu.test(
      value,
    ) ||
    /(视频|录像|录制|转录|会议|课程|session|recording|transcript).{0,8}(之前|以前|历史|过往|既往|过去)/iu.test(
      value,
    )
  );
}

function stripPreviousVideoEvidenceTrigger(value: string): string {
  return value
    .replace(
      /\b(?:from|in|based on|according to|using|search|check|look up|retrieve|find|compare|across)\s+(?:the\s+)?(?:previous|prior|past|historical|old|earlier)\s+(?:echo\s+)?(?:video|videos|recording|recordings|session|sessions|meeting|meetings|transcript|transcripts)\s*,?\s*/giu,
      "",
    )
    .replace(
      /\b(?:please\s+)?(?:use|search|check|look up|retrieve|find)\s+(?:the\s+)?(?:previous|prior|past|historical|old|earlier)\s+(?:echo\s+)?(?:video|videos|recording|recordings|session|sessions|meeting|meetings|transcript|transcripts)\s*(?:to|for)?\s*/giu,
      "",
    )
    .replace(/(?:请)?(?:从|根据|基于|查|检索|搜索)?(?:之前|以前|历史|过往|既往|过去).{0,8}(?:视频|录像|录制|转录|会议|课程|session|recording|transcript)(?:里|中|里面)?(?:找|看|回答|检索|搜索)?/giu, "")
    .replace(/(?:请)?(?:从|根据|基于|查|检索|搜索)?(?:视频|录像|录制|转录|会议|课程|session|recording|transcript).{0,8}(?:之前|以前|历史|过往|既往|过去)(?:里|中|里面)?(?:找|看|回答|检索|搜索)?/giu, "")
    .replace(/\s+/gu, " ")
    .replace(/^[,，:：;；\s]+|[,，:：;；\s]+$/gu, "")
    .trim();
}

function explicitlyRequestsPublicLiterature(value: string): boolean {
  return /\b(?:pubmed|public medical source(?:s)?|public source(?:s)?|medical literature|journal article(?:s)?|medical paper(?:s)?|peer-reviewed)\b/iu.test(
    value,
  );
}

function fallbackQuestionConcepts(question: string): string[] {
  const normalized = question
    .normalize("NFKC")
    .replace(/@\s*echo\s+ai\s+assistant/giu, " ")
    .replace(
      /\b(?:please|can you|could you|would you|answer|cite|citing|use|using|search|find|look up|retrieve|recommend|provide|give|tell me|show me)\b/giu,
      " ",
    )
    .replace(
      /\b(?:pubmed|public medical source(?:s)?|public source(?:s)?|medical source(?:s)?|medical literature|literature|journal article(?:s)?|medical paper(?:s)?|peer-reviewed|source(?:s)?)\b/giu,
      " ",
    )
    .replace(/[^\p{L}\p{N}+\- ]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  if (!normalized) {
    return [];
  }

  const candidates = unique([
    normalized,
    ...normalized
      .split(/\b(?:for|about|of|on|in|with)\b/iu)
      .map((part) => part.trim())
      .filter(Boolean),
  ]);

  return candidates.filter((value) => value.split(/\s+/u).length <= 8).slice(0, 6);
}

function privateRagCitationId(chunkId: string): string {
  return `ECHO:${createHash("sha256").update(chunkId).digest("hex").slice(0, 10)}`;
}

function minMaxNormalize<T>(
  results: T[],
  value: (result: T) => number,
): Map<T, number> {
  const values = results.map(value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) {
    return new Map(results.map((result) => [result, 1]));
  }
  return new Map(results.map((result) => [result, (value(result) - min) / (max - min)]));
}

function revisionFacts(
  revision: CaseRevision,
  key: keyof CaseRevision,
): Array<{ text: string; sourceRefs: RetrievalSourceRef[] }> {
  const value = revision[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const fact = item as {
      text?: unknown;
      sourceRefs?: unknown;
    };
    const text = typeof fact.text === "string" ? fact.text.trim() : "";
    const sourceRefs = Array.isArray(fact.sourceRefs)
      ? (fact.sourceRefs as RetrievalSourceRef[])
      : [];
    return text && sourceRefs.length > 0 ? [{ text, sourceRefs }] : [];
  });
}

function revisionIndexText(revision: CaseRevision): string {
  return INDEX_CATEGORIES.flatMap((category) =>
    revisionFacts(revision, category).map((fact) => fact.text),
  ).join("\n");
}

function indexEntry(revision: CaseRevision, embedding: number[]): HistoricalIndexEntry {
  return {
    caseId: revision.caseId,
    revisionId: revision.revisionId,
    generatedAt: revision.generatedAt,
    indexText: revisionIndexText(revision),
    embedding: normalizeEmbedding(embedding),
    overview: [
      ...revisionFacts(revision, "caseOverview"),
      ...revisionFacts(revision, "presentingQuestions"),
      ...revisionFacts(revision, "historyAndConditions"),
      ...revisionFacts(revision, "testsAndFindings"),
    ],
    recommendations: revisionFacts(revision, "recommendations"),
    outcomes: [
      ...revisionFacts(revision, "followUpActions"),
      ...revisionFacts(revision, "unresolvedQuestionsAndDataGaps"),
    ],
  };
}

export function classifyRetrievalIntent(question: string): RetrievalIntent {
  const normalized = question.toLowerCase();
  const historical =
    /\b(similar|previous|prior|historical|past|comparable)\s+(case|patient|presentation)s?\b/u.test(
      normalized,
    ) ||
    asksForPreviousVideoEvidence(question) ||
    /\b(case|patient)\s+(history|series|comparison)\b/u.test(normalized) ||
    /(相似|类似|历史|既往|以前|过往).{0,6}(病例|患者|案例)/u.test(question);
  const literature =
    /\b(evidence|study|studies|research|literature|pubmed|medpub|paper|papers|article|articles|reference|references|guideline|trial|meta-analysis|systematic review|risk comparison|treatment option|standard of care|best practice|recommen\w*)\b/u.test(
      normalized,
    ) ||
    /(证据|研究|文献|指南|论文|临床试验|荟萃分析|系统综述|治疗选择|风险比较|标准治疗|推荐)/u.test(
      question,
    );
  if (historical && literature) {
    return "both";
  }
  if (historical) {
    return "historical-cases";
  }
  if (literature) {
    return "literature";
  }
  return "none";
}

const FORBIDDEN_CONCEPT_PATTERNS = [
  /@/u,
  /https?:\/\//iu,
  /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/u,
  /\b\d{3}-\d{2}-\d{4}\b/u,
  /\b(?:mrn|medical record|patient id|member id|account|ssn|dob)\b/iu,
  /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/u,
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:,\s*\d{4})?\b/iu,
  /\b(?:hospital|clinic|university|medical center|health system|street|avenue|road|boulevard|drive|suite)\b/iu,
  /\b(?:my name is|patient(?:'s)? name|lives at|works at)\b/iu,
];

export function sanitizeMedicalConcept(value: string): string | null {
  let cleaned = value
    .normalize("NFKC")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Keep PubMed Title/Abstract clauses short so esearch URLs stay valid.
  if (!cleaned || cleaned.length > 60) {
    return null;
  }
  if (cleaned.split(/\s+/u).length > 5) {
    return null;
  }
  if (FORBIDDEN_CONCEPT_PATTERNS.some((pattern) => pattern.test(cleaned))) {
    return null;
  }
  cleaned = cleaned
    .replace(/\b(?:born|seen|admitted|discharged)\s+(?:on\s+)?\d{4}-\d{2}-\d{2}\b/giu, "")
    .replace(/\b\d{5}(?:-\d{4})?\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || /\d{6,}/u.test(cleaned)) {
    return null;
  }
  if (cleaned.length > 60 || cleaned.split(/\s+/u).length > 5) {
    return null;
  }
  return cleaned;
}

export function sensitiveTermsFromLocalText(value: string): string[] {
  const terms: string[] = [];
  const patterns = [
    /\b(?:my name is|patient(?:'s)? name is|patient named|dr\.?|mr\.?|mrs\.?|ms\.?)\s+([\p{Lu}][\p{L}'-]+(?:\s+[\p{Lu}][\p{L}'-]+){0,3})/giu,
    /(?:^|\n)\[[^\]]+\]\s*([^:\n]{2,80})\s*:/gu,
    /\b([\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,})\b/giu,
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const term = match[1]?.trim();
      if (term && term.length >= 2 && term.length <= 80) {
        terms.push(term);
      }
    }
  }
  return unique(terms);
}

export function sanitizeMedicalConcepts(
  concepts: MedicalConcepts,
  blockedTerms: string[] = [],
): string[] {
  const values = [
    ...concepts.conditions,
    ...concepts.symptoms,
    ...concepts.interventions,
    ...concepts.tests,
    ...(concepts.populationAgeBand ? [concepts.populationAgeBand] : []),
    ...concepts.comorbidities,
    ...concepts.outcomes,
  ];
  const normalizedBlocked = blockedTerms.map((term) => term.toLowerCase());
  return unique(
    values.flatMap((value) => {
      const sanitized = sanitizeMedicalConcept(value);
      if (
        !sanitized ||
        normalizedBlocked.some((term) => sanitized.toLowerCase().includes(term))
      ) {
        return [];
      }
      return [sanitized];
    }),
  ).slice(0, 30);
}

function sanitizeFallbackQuestionConcepts(
  question: string,
  blockedTerms: string[] = [],
): string[] {
  const normalizedBlocked = blockedTerms.map((term) => term.toLowerCase());
  return unique(
    fallbackQuestionConcepts(question).flatMap((value) => {
      const sanitized = sanitizeMedicalConcept(value);
      if (
        !sanitized ||
        normalizedBlocked.some((term) => sanitized.toLowerCase().includes(term))
      ) {
        return [];
      }
      return [sanitized];
    }),
  ).slice(0, 8);
}

const MOUD_DOMAIN_RE =
  /\b(moud|oud|opioid|buprenorphine|suboxone|methadone|naltrexone|vivitrol|naloxone|opioid use disorder|medication(?:s)? for opioid)\b/i;

/** Extra Title/Abstract terms when the ask is in the MOUD/OUD domain. */
export function moudBoostConcepts(question: string, concepts: string[]): string[] {
  if (!MOUD_DOMAIN_RE.test(question) && !concepts.some((c) => MOUD_DOMAIN_RE.test(c))) {
    return concepts;
  }
  const q = question.toLowerCase();
  const boost: string[] = ["medications for opioid use disorder", "opioid use disorder"];
  // Only boost meds actually named — do not cross-substitute buprenorphine for methadone.
  if (/\b(buprenorphine|suboxone|subutex|sublocade)\b/i.test(q)) {
    boost.push("buprenorphine");
  }
  if (/\b(methadone|mmt|\bmot\b)\b/i.test(q)) {
    boost.push("methadone", "methadone maintenance");
  }
  if (/\b(naltrexone|vivitrol)\b/i.test(q)) {
    boost.push("naltrexone");
  }
  if (/\bchronic pain|pain manage|analges/i.test(q)) {
    boost.push("chronic pain");
  }
  // Prepend boosts so named meds survive pubmedQueryConcepts truncation.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of [...boost, ...concepts]) {
    const key = term.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(term);
  }
  return out;
}

export function buildPubMedQuery(concepts: string[], maxConcepts = 6): string {
  // Drop overlong phrases (defensive; sanitizeMedicalConcept should already filter).
  const usable = concepts.filter(
    (concept) => concept.length <= 60 && concept.split(/\s+/u).length <= 5,
  );
  // Prefer shorter clauses first (named drugs / Mesh-friendly phrases).
  const ranked = [...usable].sort(
    (a, b) => a.split(/\s+/u).length - b.split(/\s+/u).length || a.length - b.length,
  );
  const clauses = ranked
    .slice(0, maxConcepts)
    .map((concept) => `"${concept.replace(/"/g, "")}"[Title/Abstract]`);
  // Prefer human clinical literature (matches the paper's Humans[Mesh] guard).
  const core = clauses.join(" OR ");
  return core ? `(${core}) AND Humans[Mesh]` : "Humans[Mesh]";
}

class OpenAiTextClient implements RetrievalModelClient {
  constructor(private readonly config: RetrievalConfig) {}

  async text(messages: CaseLlmMessage[], maxTokens: number): Promise<string> {
    const url = `${this.config.textBaseUrl.replace(/\/$/, "")}/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.config.textApiKey
          ? { authorization: `Bearer ${this.config.textApiKey}` }
          : {}),
      },
      body: JSON.stringify({
        model: this.config.textModel,
        messages,
        temperature: 0,
        max_tokens: maxTokens,
        chat_template_kwargs: {
          enable_thinking: false,
        },
      }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      error?: string | { message?: string };
      choices?: Array<{ message?: { content?: string }; text?: string }>;
    };
    if (!response.ok) {
      throw new Error(
        typeof body.error === "string"
          ? body.error
          : body.error?.message || `Text LLM failed with HTTP ${response.status}`,
      );
    }
    const content =
      body.choices?.[0]?.message?.content ?? body.choices?.[0]?.text ?? "";
    if (!content.trim()) {
      throw new Error("Text LLM returned an empty response");
    }
    return content;
  }

  async health() {
    const url = `${this.config.textBaseUrl.replace(/\/$/, "")}/models`;
    try {
      const response = await fetch(url);
      return { ok: response.ok, url, status: response.status };
    } catch (error) {
      return { ok: false, url, error: errorMessage(error) };
    }
  }
}

class OpenAiEmbeddingClient implements EmbeddingClient {
  constructor(private readonly config: RetrievalConfig) {}

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(
      `${this.config.embeddingBaseUrl.replace(/\/$/, "")}/embeddings`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.embeddingApiKey
            ? { authorization: `Bearer ${this.config.embeddingApiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: this.config.embeddingModel,
          input: texts,
          encoding_format: "float",
        }),
      },
    );
    const body = (await response.json().catch(() => ({}))) as {
      error?: string | { message?: string };
      data?: Array<{ index?: number; embedding?: number[] }>;
    };
    if (!response.ok) {
      throw new Error(
        typeof body.error === "string"
          ? body.error
          : body.error?.message || `Embedding request failed with HTTP ${response.status}`,
      );
    }
    const sorted = [...(body.data ?? [])].sort(
      (left, right) => (left.index ?? 0) - (right.index ?? 0),
    );
    if (sorted.length !== texts.length) {
      throw new Error("Embedding response count did not match input count");
    }
    return sorted.map((item) => {
      if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
        throw new Error("Embedding response contained an empty vector");
      }
      return item.embedding;
    });
  }

  async health() {
    const url = `${this.config.embeddingBaseUrl.replace(/\/$/, "")}/models`;
    try {
      const response = await fetch(url);
      return { ok: response.ok, url, status: response.status };
    } catch (error) {
      return { ok: false, url, error: errorMessage(error) };
    }
  }
}

export class PubMedClient {
  private nextRequestAt = 0;

  constructor(
    private readonly config: RetrievalConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async search(query: string): Promise<PubMedArticle[]> {
    if (!this.config.pubmedEmail) {
      throw new Error("PUBMED_EMAIL is required");
    }
    const queryHash = createHash("sha256").update(query).digest("hex");
    const cachePath = path.join(
      this.config.dataDir,
      "pubmed",
      "cache",
      `${queryHash}.json`,
    );
    try {
      const cached = await readJson<{ cachedAt: string; articles: PubMedArticle[] }>(
        cachePath,
      );
      const ageSeconds = (this.now() - Date.parse(cached.cachedAt)) / 1000;
      if (ageSeconds >= 0 && ageSeconds <= this.config.pubmedCacheTtlSeconds) {
        return cached.articles;
      }
    } catch {
      // Cache miss or invalid cache: use PubMed.
    }

    const currentYear = new Date(this.now()).getUTCFullYear();
    const recentStart = Math.max(1900, currentYear - this.config.pubmedRecentYears);
    const [best, recent] = await Promise.all([
      this.esearch(query, this.config.pubmedBestMatchCount, {
        sort: "relevance",
      }),
      this.esearch(query, this.config.pubmedRecentCount, {
        sort: "pub date",
        mindate: String(recentStart),
        maxdate: String(currentYear),
        datetype: "pdat",
      }),
    ]);
    const pmids = unique([...best, ...recent]);
    const articles = pmids.length > 0 ? await this.efetch(pmids) : [];
    await atomicWriteJson(cachePath, {
      cachedAt: new Date(this.now()).toISOString(),
      query,
      articles,
    });
    return articles;
  }

  private commonParams(): URLSearchParams {
    const params = new URLSearchParams({
      tool: this.config.pubmedTool,
      email: this.config.pubmedEmail,
    });
    if (this.config.pubmedApiKey) {
      params.set("api_key", this.config.pubmedApiKey);
    }
    return params;
  }

  private async esearch(
    query: string,
    count: number,
    extra: Record<string, string>,
  ): Promise<string[]> {
    const params = this.commonParams();
    params.set("db", "pubmed");
    params.set("term", query);
    params.set("retmode", "json");
    params.set("retmax", String(count));
    for (const [key, value] of Object.entries(extra)) {
      params.set(key, value);
    }
    const body = (await this.requestJson(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${params}`,
    )) as { esearchresult?: { idlist?: string[] } };
    return body.esearchresult?.idlist ?? [];
  }

  private async efetch(pmids: string[]): Promise<PubMedArticle[]> {
    const params = this.commonParams();
    params.set("db", "pubmed");
    params.set("id", pmids.join(","));
    params.set("retmode", "xml");
    const xml = await this.requestText(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?${params}`,
    );
    const root = XML.parse(xml) as {
      PubmedArticleSet?: { PubmedArticle?: unknown | unknown[] };
    };
    return asArray(root.PubmedArticleSet?.PubmedArticle).flatMap((raw) => {
      try {
        return [this.parseArticle(raw as Record<string, unknown>)];
      } catch {
        return [];
      }
    });
  }

  private parseArticle(raw: Record<string, unknown>): PubMedArticle {
    const citation = (raw.MedlineCitation ?? {}) as Record<string, unknown>;
    const article = (citation.Article ?? {}) as Record<string, unknown>;
    const journal = (article.Journal ?? {}) as Record<string, unknown>;
    const journalIssue = (journal.JournalIssue ?? {}) as Record<string, unknown>;
    const pubDate = (journalIssue.PubDate ?? {}) as Record<string, unknown>;
    const pubmedData = (raw.PubmedData ?? {}) as Record<string, unknown>;
    const articleIds = asArray(
      (pubmedData.ArticleIdList as Record<string, unknown> | undefined)?.ArticleId,
    ) as Array<Record<string, unknown> | string>;
    const idByType = (type: string) =>
      articleIds
        .map((item) => {
          if (typeof item === "string") {
            return null;
          }
          return item["@_IdType"] === type ? textValue(item) : null;
        })
        .find(Boolean) ?? null;
    const pmid = textValue(citation.PMID);
    const doi = idByType("doi");
    const pmcId = idByType("pmc");
    const authorList = asArray(
      (article.AuthorList as Record<string, unknown> | undefined)?.Author,
    ) as Array<Record<string, unknown>>;
    const abstractParts = asArray(
      (article.Abstract as Record<string, unknown> | undefined)?.AbstractText,
    );
    const publicationTypes = asArray(
      (article.PublicationTypeList as Record<string, unknown> | undefined)
        ?.PublicationType,
    ).map(textValue);
    const publicationDate =
      [textValue(pubDate.Year), textValue(pubDate.Month), textValue(pubDate.Day)]
        .filter(Boolean)
        .join("-") ||
      textValue(pubDate.MedlineDate) ||
      null;
    return {
      pmid,
      title: textValue(article.ArticleTitle),
      authors: authorList
        .map((author) =>
          [textValue(author.ForeName), textValue(author.LastName)]
            .filter(Boolean)
            .join(" "),
        )
        .filter(Boolean),
      journal: textValue(journal.Title) || null,
      publicationDate,
      publicationTypes,
      abstract: abstractParts.map(textValue).filter(Boolean).join("\n") || null,
      doi,
      pmcId,
      pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      doiUrl: doi ? `https://doi.org/${doi}` : null,
      pmcUrl: pmcId ? `https://pmc.ncbi.nlm.nih.gov/articles/${pmcId}/` : null,
    };
  }

  private async rateLimit(): Promise<void> {
    const interval = this.config.pubmedApiKey ? 100 : Math.ceil(1000 / 3);
    const wait = Math.max(0, this.nextRequestAt - this.now());
    this.nextRequestAt = Math.max(this.nextRequestAt, this.now()) + interval;
    if (wait > 0) {
      await retryDelay(wait);
    }
  }

  private async requestJson(url: string): Promise<unknown> {
    const response = await this.request(url);
    return response.json();
  }

  private async requestText(url: string): Promise<string> {
    const response = await this.request(url);
    return response.text();
  }

  private async request(url: string): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await this.rateLimit();
      try {
        const response = await this.fetcher(url, {
          headers: { "user-agent": `${this.config.pubmedTool}/1.0` },
        });
        if (response.ok) {
          return response;
        }
        if (response.status !== 429 && response.status < 500) {
          throw new Error(`PubMed request failed with HTTP ${response.status}`);
        }
        lastError = new Error(`PubMed request failed with HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      if (attempt < 3) {
        await retryDelay(250 * 2 ** attempt);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("PubMed request failed");
  }
}

export class RetrievalManager {
  private index: HistoricalIndexSnapshot | null = null;
  private privateRagIndex: PrivateRagIndexSnapshot | null = null;
  private initialized = false;
  private initialization: Promise<void> | null = null;
  private recordChain: Promise<void> = Promise.resolve();
  private lastError: string | null = null;
  private privateRagError: string | null = null;
  private indexRequiresRebuild = false;
  private embeddingServiceAvailable: boolean | null = null;
  private readonly activeRetrievalIds = new Set<string>();
  private outputService: RetrievalOutputService | null = null;

  constructor(
    private readonly config: RetrievalConfig,
    private readonly emit: RetrievalEventEmitter,
    private readonly cases: CaseProvider,
    private readonly models: RetrievalModelClient = new OpenAiTextClient(config),
    private readonly embeddings: EmbeddingClient = new OpenAiEmbeddingClient(config),
    private readonly pubmed: PubMedClient = new PubMedClient(config),
  ) {}

  setOutputService(service: RetrievalOutputService): void {
    this.outputService = service;
  }

  health() {
    const historicalReasons = [
      !this.config.enabled ? "RETRIEVAL_ENABLED=false" : "",
      !this.config.historicalCasesEnabled
        ? "HISTORICAL_CASE_RETRIEVAL_ENABLED=false"
        : "",
      this.indexRequiresRebuild ? "case index requires rebuild" : "",
      this.embeddingServiceAvailable === false ? "embedding service unavailable" : "",
    ].filter(Boolean);
    const pubmedReasons = [
      !this.config.enabled ? "RETRIEVAL_ENABLED=false" : "",
      !this.config.pubmedEnabled ? "PUBMED_RETRIEVAL_ENABLED=false" : "",
      this.config.pubmedEnabled && !this.config.pubmedEmail
        ? "PUBMED_EMAIL is missing"
        : "",
    ].filter(Boolean);
    const privateRagReasons = [
      !this.config.enabled ? "RETRIEVAL_ENABLED=false" : "",
      !this.config.privateRagEnabled ? "PRIVATE_RAG_RETRIEVAL_ENABLED=false" : "",
      this.privateRagError ? `private RAG index unavailable: ${this.privateRagError}` : "",
      this.embeddingServiceAvailable === false ? "embedding service unavailable" : "",
    ].filter(Boolean);
    return {
      enabled: this.config.enabled,
      dataDir: this.config.dataDir,
      historicalCases: {
        enabled: this.config.historicalCasesEnabled,
        available:
          this.config.enabled &&
          this.config.historicalCasesEnabled &&
          !this.indexRequiresRebuild &&
          this.embeddingServiceAvailable !== false,
        unavailableReasons: historicalReasons,
        indexVersion: this.index?.indexVersion ?? null,
        entries: this.index?.entries.length ?? 0,
        embeddingBaseUrl: this.config.embeddingBaseUrl,
        embeddingModel: this.config.embeddingModel,
        embeddingGpu: this.config.embeddingGpu,
        embeddingDimension: this.index?.embeddingDimension ?? null,
      },
      privateRag: {
        enabled: this.config.privateRagEnabled,
        available:
          this.config.enabled &&
          this.config.privateRagEnabled &&
          !this.privateRagError &&
          this.embeddingServiceAvailable !== false,
        unavailableReasons: privateRagReasons,
        dbDir: this.config.privateRagDbDir,
        chunks: this.privateRagIndex?.chunkCount ?? 0,
        embeddingDimension: this.privateRagIndex?.embeddingDimension ?? null,
        bm25K: this.config.privateRagBm25K,
        embeddingK: this.config.privateRagTopK,
        blend: this.config.privateRagBlend,
        semanticWeight: this.config.privateRagSemanticWeight,
        alwaysOn: this.config.privateRagAlwaysOn,
      },
      pubmed: {
        enabled: this.config.pubmedEnabled,
        available:
          this.config.enabled &&
          this.config.pubmedEnabled &&
          Boolean(this.config.pubmedEmail),
        unavailableReasons: pubmedReasons,
        cacheTtlSeconds: this.config.pubmedCacheTtlSeconds,
      },
      sourceTimeoutMs: this.config.sourceTimeoutMs,
      totalTimeoutMs: this.config.totalTimeoutMs,
      activeRetrievals: this.activeRetrievalIds.size,
      lastError: this.lastError,
    };
  }

  async runtimeHealth() {
    if (!this.config.enabled) {
      return { ...this.health(), services: null };
    }
    const [embedding, text] = await Promise.all([
      this.config.historicalCasesEnabled || this.config.privateRagEnabled
        ? this.embeddings.health()
        : Promise.resolve({ ok: true, url: "", status: 0 }),
      this.models.health(),
    ]);
    this.embeddingServiceAvailable = embedding.ok;
    return { ...this.health(), services: { embedding, text } };
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }
    await this.initialize();
    let embeddingOk = true;
    if (this.config.historicalCasesEnabled || this.config.privateRagEnabled) {
      const embedding = await this.embeddings.health();
      this.embeddingServiceAvailable = embedding.ok;
      embeddingOk = embedding.ok;
    }
    if (this.config.privateRagEnabled) {
      await this.loadPrivateRagIndex().catch((error) => {
        this.privateRagError = errorMessage(error);
        this.lastError = errorMessage(error);
      });
    }
    if (this.config.historicalCasesEnabled) {
      if (embeddingOk && !this.index) {
        await this.rebuildIndex().catch((error) => {
          this.lastError = errorMessage(error);
        });
      }
    }
  }

  async shutdown(): Promise<void> {
    await this.recordChain.catch(() => undefined);
  }

  registerRoutes(app: Express): void {
    app.get("/retrieval/health", async (_req, res) => {
      res.json({ ok: true, retrieval: await this.runtimeHealth() });
    });
    app.post("/retrieval/index/rebuild", async (_req, res) => {
      if (!this.config.enabled || !this.config.historicalCasesEnabled) {
        res.status(503).json({ ok: false, error: "Historical retrieval is disabled" });
        return;
      }
      void this.rebuildIndex().catch(() => undefined);
      res.status(202).json({ ok: true, status: "queued" });
    });
    app.post("/retrieval/search", async (req, res) => {
      const question =
        typeof req.body?.question === "string" ? req.body.question.trim() : "";
      if (!question) {
        res.status(400).json({ ok: false, error: "question is required" });
        return;
      }
      try {
        const explicitIntent = this.parseIntent(req.body?.intent);
        const historical = req.body?.historicalCases;
        const literature = req.body?.literature;
        const intent =
          explicitIntent ??
          (historical === false && literature !== false
            ? "literature"
            : literature === false && historical !== false
              ? "historical-cases"
              : "both");
        const record = await this.queueSearch({
          question,
          context:
            typeof req.body?.context === "string" ? req.body.context : undefined,
          intent,
        });
        res.status(202).json({ ok: true, record });
      } catch (error) {
        res.status(503).json({ ok: false, error: errorMessage(error) });
      }
    });
    app.post("/cases/:caseId/retrievals", async (req, res) => {
      try {
        const result = await this.cases.get(req.params.caseId);
        if (!result || !result.currentRevision) {
          res.status(404).json({ ok: false, error: "Complete case revision not found" });
          return;
        }
        const question =
          typeof req.body?.question === "string" && req.body.question.trim()
            ? req.body.question.trim()
            : this.defaultCaseQuestion(result.currentRevision);
        const record = await this.queueSearch({
          question,
          caseId: result.workspace.caseId,
          revisionId: result.currentRevision.revisionId,
          intent: "both",
          forceHistorical: true,
          forcePubmed: true,
        });
        res.status(202).json({ ok: true, record });
      } catch (error) {
        res.status(503).json({ ok: false, error: errorMessage(error) });
      }
    });
    app.get("/cases/:caseId/retrievals", async (req, res) => {
      const caseResult = await this.cases.get(req.params.caseId);
      if (!caseResult) {
        res.status(404).json({ ok: false, error: "Case workspace not found" });
        return;
      }
      res.json({
        ok: true,
        retrievals: await this.recordsForCase(req.params.caseId),
      });
    });
    app.get("/cases/:caseId/retrievals/:retrievalId", async (req, res) => {
      const record = await this.readRecord(req.params.retrievalId).catch(() => null);
      if (!record || record.caseId !== req.params.caseId) {
        res.status(404).json({ ok: false, error: "Retrieval record not found" });
        return;
      }
      res.json({ ok: true, record });
    });
  }

  async onCaseRevisionCompleted(
    workspace: CaseWorkspace,
    revision: CaseRevision,
  ): Promise<void> {
    if (!this.config.enabled || !this.config.historicalCasesEnabled) {
      return;
    }
    await this.initialize();
    if (
      workspace.status !== "complete" ||
      !revision.caseDetected ||
      revision.deidentificationWarnings.length > 0
    ) {
      await this.removeCaseFromIndex(revision.caseId);
      return;
    }
    const text = revisionIndexText(revision);
    if (!text) {
      await this.removeCaseFromIndex(revision.caseId);
      return;
    }
    const [embedding] = await this.embeddings.embed([text]);
    if (!embedding) {
      throw new Error("Embedding service returned no vector");
    }
    await this.updateIndex(indexEntry(revision, embedding));
  }

  async retrieveForMeeting(input: MeetingRetrievalInput): Promise<MeetingRetrievalResult> {
    if (!this.config.enabled) {
      return { record: null, evidencePacket: "" };
    }
    const allowPrivateIndex = input.allowPrivateIndex !== false;
    let intent = classifyRetrievalIntent(input.question);
    if (intent === "none") {
      const clinical = looksLikeClinicalQuestion(input.question);
      const previousVideo = asksForPreviousVideoEvidence(input.question);
      // Clinical Zoom questions should retrieve evidence rather than improvise.
      if (
        allowPrivateIndex &&
        this.config.privateRagEnabled &&
        (previousVideo || (this.config.privateRagAlwaysOn && clinical))
      ) {
        intent =
          clinical && this.config.pubmedEnabled ? "both" : "historical-cases";
      } else if (clinical && this.config.pubmedEnabled) {
        intent = "literature";
      }
    }
    if (!allowPrivateIndex) {
      if (intent === "both" || intent === "historical-cases") {
        intent = this.config.pubmedEnabled ? "literature" : "none";
      }
    }
    this.emit("retrieval-intent-classified", {
      streamId: input.streamId,
      question: input.question,
      intent,
    });
    if (intent === "none") {
      return { record: null, evidencePacket: "" };
    }
    const pending = this.newRecord({ ...input, intent });
    await this.saveRecord(pending);
    const record = await this.executeSearch(
      {
        ...input,
        intent,
      },
      pending,
      Date.now() + this.config.totalTimeoutMs,
    ).catch(async (error) => {
      const failed = pending;
      failed.status = "failed";
      failed.warnings.push(errorMessage(error));
      failed.completedAt = new Date().toISOString();
      this.activeRetrievalIds.delete(failed.retrievalId);
      await this.saveRecord(failed);
      this.emit("retrieval-failed", {
        retrievalId: failed.retrievalId,
        streamId: input.streamId,
        message: errorMessage(error),
      });
      return failed;
    });
    return { record, evidencePacket: this.evidencePacket(record) };
  }

  async rebuildIndex(): Promise<HistoricalIndexSnapshot> {
    this.assertEnabled();
    await mkdir(path.join(this.config.dataDir, "cases", "builds"), {
      recursive: true,
    });
    const entries: HistoricalIndexEntry[] = [];
    let caseDirectories: Array<{ isDirectory(): boolean; name: string }> = [];
    try {
      caseDirectories = await readdir(this.config.caseDataDir, {
        withFileTypes: true,
      });
    } catch {
      caseDirectories = [];
    }
    const revisions: CaseRevision[] = [];
    for (const directory of caseDirectories) {
      if (!directory.isDirectory()) {
        continue;
      }
      try {
        const workspace = await readJson<CaseWorkspace>(
          path.join(this.config.caseDataDir, directory.name, "workspace.json"),
        );
        if (
          workspace.status !== "complete" ||
          workspace.caseDetected !== true ||
          !workspace.currentRevisionId
        ) {
          continue;
        }
        const revision = await readJson<CaseRevision>(
          path.join(
            this.config.caseDataDir,
            directory.name,
            "revisions",
            `${workspace.currentRevisionId}.json`,
          ),
        );
        if (
          revision.caseDetected &&
          revision.deidentificationWarnings.length === 0 &&
          revisionIndexText(revision)
        ) {
          revisions.push(revision);
        }
      } catch {
        // Skip corrupt or incomplete cases; the case workspace health owns those errors.
      }
    }
    const batchSize = 16;
    for (let offset = 0; offset < revisions.length; offset += batchSize) {
      const batch = revisions.slice(offset, offset + batchSize);
      const vectors = await this.embeddings.embed(batch.map(revisionIndexText));
      batch.forEach((revision, index) => {
        const vector = vectors[index];
        if (vector) {
          entries.push(indexEntry(revision, vector));
        }
      });
    }
    const dimension = entries[0]?.embedding.length ?? 0;
    const snapshot: HistoricalIndexSnapshot = {
      schemaVersion: 1,
      indexVersion: randomUUID(),
      embeddingModel: this.config.embeddingModel,
      embeddingDimension: dimension,
      builtAt: new Date().toISOString(),
      entries,
    };
    await this.saveIndex(snapshot);
    this.indexRequiresRebuild = false;
    this.emit("retrieval-case-index-updated", {
      indexVersion: snapshot.indexVersion,
      entries: entries.length,
      reason: "rebuild",
    });
    return snapshot;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.initialization) {
      return this.initialization;
    }
    this.initialization = (async () => {
      await mkdir(this.config.dataDir, { recursive: true });
      try {
        const index = await readJson<HistoricalIndexSnapshot>(this.indexPath());
        this.index = index;
        if (index.embeddingModel !== this.config.embeddingModel) {
          this.indexRequiresRebuild = true;
        }
      } catch {
        this.index = null;
      }
      this.initialized = true;
    })();
    try {
      await this.initialization;
    } finally {
      this.initialization = null;
    }
  }

  private async queueSearch(input: SearchInput): Promise<RetrievalRecord> {
    this.assertEnabled();
    await this.initialize();
    const intent =
      input.intent ??
      (input.forceHistorical && input.forcePubmed
        ? "both"
        : input.forceHistorical
          ? "historical-cases"
          : input.forcePubmed
            ? "literature"
            : classifyRetrievalIntent(input.question));
    const record = this.newRecord({ ...input, intent });
    await this.saveRecord(record);
    this.emit("retrieval-requested", {
      retrievalId: record.retrievalId,
      caseId: record.caseId,
      streamId: record.streamId,
      intent,
    });
    this.emit("retrieval-intent-classified", {
      retrievalId: record.retrievalId,
      question: record.question,
      intent,
    });
    this.recordChain = this.recordChain
      .then(async () => {
        await this.executeSearch({ ...input, intent }, record);
      })
      .catch(async (error) => {
        this.lastError = errorMessage(error);
        record.status = "failed";
        record.warnings.push(errorMessage(error));
        record.completedAt = new Date().toISOString();
        this.activeRetrievalIds.delete(record.retrievalId);
        await this.saveRecord(record);
        this.emit("retrieval-failed", {
          retrievalId: record.retrievalId,
          caseId: record.caseId,
          streamId: record.streamId,
          message: errorMessage(error),
        });
      });
    return record;
  }

  private async executeSearch(
    input: SearchInput & { intent: RetrievalIntent },
    existing?: RetrievalRecord,
    deadline?: number,
  ): Promise<RetrievalRecord> {
    this.assertEnabled();
    await this.initialize();
    const record = existing ?? this.newRecord(input);
    this.activeRetrievalIds.add(record.retrievalId);
    record.status = "processing";
    if (!record.indexVersion && this.index?.indexVersion) {
      record.indexVersion = this.index.indexVersion;
    }
    await this.saveRecord(record);
    this.emit("retrieval-requested", {
      retrievalId: record.retrievalId,
      caseId: record.caseId,
      streamId: record.streamId,
      intent: input.intent,
    });

    const conceptBudget = deadline
      ? Math.max(1, Math.min(this.config.sourceTimeoutMs, deadline - Date.now()))
      : this.config.sourceTimeoutMs;
    const concepts = await withTimeout(
      this.extractConcepts(input.question, input.context ?? ""),
      conceptBudget,
      "Medical concept extraction",
    );
    const allowPrivateIndex = input.allowPrivateIndex !== false;
    const wantsHistorical =
      allowPrivateIndex &&
      (input.intent === "historical-cases" || input.intent === "both");
    const wantsLiterature = input.intent === "literature" || input.intent === "both";
    const publicLiteratureOnly = wantsLiterature && explicitlyRequestsPublicLiterature(input.question);
    const blockedTerms = sensitiveTermsFromLocalText(`${input.question}\n${input.context ?? ""}`);
    let sanitized = sanitizeMedicalConcepts(concepts, blockedTerms);
    if (sanitized.length === 0 && wantsLiterature) {
      sanitized = sanitizeFallbackQuestionConcepts(input.question, blockedTerms);
      if (sanitized.length > 0) {
        record.warnings.push(
          "Medical concept extraction returned no safe terms; fell back to sanitized question keywords",
        );
      }
    }
    record.sanitizedMedicalConcepts = sanitized;
    if (sanitized.length === 0) {
      record.warnings.push("No safe medical concepts remained after privacy filtering");
    }

    const sourcePromises: Array<Promise<{ source: "historical" | "private-rag" | "pubmed"; ok: boolean }>> =
      [];
    let requestedSources = 0;
    const sourceBudget = deadline
      ? Math.max(1, Math.min(this.config.sourceTimeoutMs, deadline - Date.now()))
      : this.config.sourceTimeoutMs;
    const fixedIndex = await this.indexForVersion(record.indexVersion);

    if (wantsHistorical) {
      if (this.config.privateRagEnabled) {
        requestedSources += 1;
        sourcePromises.push(
          withTimeout(
            this.searchPrivateTranscriptRag(input.question, sanitized),
            sourceBudget,
            "Private transcript RAG retrieval",
          )
            .then((hits) => {
              record.transcriptChunks = hits;
              this.emit("retrieval-private-rag-completed", {
                retrievalId: record.retrievalId,
                hits: hits.length,
              });
              return { source: "private-rag" as const, ok: true };
            })
            .catch((error) => {
              record.warnings.push(`Private transcript RAG unavailable: ${errorMessage(error)}`);
              return { source: "private-rag" as const, ok: false };
            }),
        );
      }
      if (this.config.historicalCasesEnabled) {
        requestedSources += 1;
      }
      if (this.config.historicalCasesEnabled && this.indexRequiresRebuild) {
        record.warnings.push("Historical case index requires rebuild");
      } else if (this.config.historicalCasesEnabled) {
        sourcePromises.push(
          withTimeout(
            this.searchHistorical(
              input.question,
              sanitized,
              input.caseId,
              fixedIndex,
            ),
            sourceBudget,
            "Historical case retrieval",
          )
            .then((hits) => {
              record.historicalCases = hits;
              this.emit("retrieval-historical-completed", {
                retrievalId: record.retrievalId,
                hits: hits.length,
              });
              return { source: "historical" as const, ok: true };
            })
            .catch((error) => {
              record.warnings.push(`Historical case retrieval unavailable: ${errorMessage(error)}`);
              return { source: "historical" as const, ok: false };
            }),
        );
      } else if (!this.config.privateRagEnabled) {
        requestedSources += 1;
        record.warnings.push("Historical case retrieval is disabled");
      }
    }

    if (wantsLiterature) {
      requestedSources += 1;
      if (!this.config.pubmedEnabled) {
        record.warnings.push("PubMed retrieval is disabled");
      } else if (!this.config.pubmedEmail) {
        record.warnings.push("PubMed retrieval unavailable: PUBMED_EMAIL is missing");
      } else if (sanitized.length === 0) {
        record.warnings.push("PubMed retrieval skipped because no safe concepts were available");
      } else {
        const query = buildPubMedQuery(
          moudBoostConcepts(input.question, sanitized),
          this.config.pubmedQueryConcepts,
        );
        record.outboundPubMedQuery = query;
        // Reserve time for private-RAG fallback when literature is the only planned source.
        const reserveFallbackMs =
          allowPrivateIndex && this.config.privateRagEnabled && !wantsHistorical
            ? 8_000
            : 0;
        const pubmedBudget = Math.max(1_000, sourceBudget - reserveFallbackMs);
        sourcePromises.push(
          withTimeout(
            this.searchPubMed(input.question, query),
            pubmedBudget,
            "PubMed retrieval",
          )
            .then((hits) => {
              record.literature = hits;
              this.emit("retrieval-pubmed-completed", {
                retrievalId: record.retrievalId,
                hits: hits.length,
              });
              return { source: "pubmed" as const, ok: true };
            })
            .catch((error) => {
              record.warnings.push(`PubMed retrieval unavailable: ${errorMessage(error)}`);
              return { source: "pubmed" as const, ok: false };
            }),
        );
      }
    }

    const results: Array<{
      source: "historical" | "private-rag" | "pubmed";
      ok: boolean;
    }> = await Promise.all(sourcePromises);

    // If PubMed/literature was requested but returned nothing, fall back to prior
    // ECHO transcripts so clinical Zoom answers are still grounded and citable.
    if (
      allowPrivateIndex &&
      wantsLiterature &&
      this.config.privateRagEnabled &&
      !publicLiteratureOnly &&
      record.literature.length === 0 &&
      record.transcriptChunks.length === 0
    ) {
      const remainingBudget = deadline
        ? Math.max(
            1_000,
            Math.min(this.config.sourceTimeoutMs, deadline - Date.now()),
          )
        : this.config.sourceTimeoutMs;
      try {
        const hits = await withTimeout(
          this.searchPrivateTranscriptRag(input.question, sanitized),
          remainingBudget,
          "Private transcript RAG fallback",
        );
        record.transcriptChunks = hits.slice(0, Math.min(3, this.config.privateRagTopK));
        requestedSources += 1;
        results.push({ source: "private-rag", ok: hits.length > 0 });
        record.warnings.push(
          hits.length > 0
            ? "PubMed/literature evidence unavailable; fell back to prior ECHO transcript chunks"
            : "PubMed/literature evidence unavailable; private transcript RAG fallback returned no hits",
        );
        this.emit("retrieval-private-rag-fallback", {
          retrievalId: record.retrievalId,
          hits: record.transcriptChunks.length,
        });
      } catch (error) {
        requestedSources += 1;
        results.push({ source: "private-rag", ok: false });
        record.warnings.push(
          `PubMed/literature evidence unavailable; private transcript RAG fallback failed: ${errorMessage(error)}`,
        );
      }
    }

    const successfulSources = results.filter((result) => result.ok).length;
    if (requestedSources === 0) {
      record.status = "complete";
    } else if (successfulSources === requestedSources) {
      record.status = "complete";
    } else if (
      successfulSources > 0 ||
      record.historicalCases.length > 0 ||
      record.transcriptChunks.length > 0 ||
      record.literature.length > 0
    ) {
      record.status = "partial";
    } else {
      record.status = "failed";
    }
    record.completedAt = new Date().toISOString();
    await this.saveRecord(record);
    const event =
      record.status === "complete"
        ? "retrieval-completed"
        : record.status === "partial"
          ? "retrieval-partial"
          : "retrieval-failed";
    this.emit(event, {
      retrievalId: record.retrievalId,
      caseId: record.caseId,
      streamId: record.streamId,
      historicalCases: record.historicalCases.length,
      transcriptChunks: record.transcriptChunks.length,
      literature: record.literature.length,
      warnings: record.warnings,
    });
    if (
      this.outputService &&
      (record.status === "complete" || record.status === "partial")
    ) {
      await this.outputService.onRetrievalCompleted(record).catch((error) => {
        this.emit("case-output-failed", {
          caseId: record.caseId,
          revisionId: record.revisionId,
          retrievalId: record.retrievalId,
          reason: "retrieval-hook-failed",
          message: errorMessage(error),
        });
      });
    }
    this.activeRetrievalIds.delete(record.retrievalId);
    return record;
  }

  private async extractConcepts(
    question: string,
    context: string,
  ): Promise<MedicalConcepts> {
    const contextExcerpt = context.slice(-6_000);
    try {
      const raw = await this.models.text(
        [
          {
            role: "system",
            content: [
              "Extract only concise English medical concepts for evidence retrieval.",
              "Return JSON with conditions, symptoms, interventions, tests, populationAgeBand, comorbidities, and outcomes.",
              "Never include names, contacts, addresses, institutions, IDs, exact dates, speaker labels, or narrative sentences.",
              "Prioritize medical topics explicitly named in the user's question; use meeting context only when it clearly states the topic.",
              "Do not invent a disease, population, treatment, test, or outcome. If no medical topic is explicit, return empty arrays and null populationAgeBand.",
              "Translate Chinese medical concepts into English.",
            ].join(" "),
          },
          {
            role: "user",
            content: `Question:\n${question}\n\nMeeting context:\n${contextExcerpt || "(none)"}`,
          },
        ],
        500,
      );
      return conceptSchema.parse(parseJsonObject(raw));
    } catch (error) {
      this.lastError = `Concept extraction fallback: ${errorMessage(error)}`;
      const candidates =
        `${question} ${contextExcerpt}`
          .match(/[\p{L}][\p{L}\p{N}+\- ]{2,60}/gu)
          ?.map((value) => value.trim())
          .filter((value) => value.split(/\s+/).length <= 6)
          .slice(0, 20) ?? [];
      return {
        conditions: candidates,
        symptoms: [],
        interventions: [],
        tests: [],
        populationAgeBand: null,
        comorbidities: [],
        outcomes: [],
      };
    }
  }

  private async loadPrivateRagIndex(): Promise<PrivateRagIndexSnapshot> {
    if (this.privateRagIndex) {
      return this.privateRagIndex;
    }
    const indexDir = path.join(this.config.privateRagDbDir, "indexes");
    const manifestPath = path.join(
      this.config.privateRagDbDir,
      "manifests",
      "embedding_index_manifest.json",
    );
    const [lexicalIndex, chunks, embeddings, manifest] = await Promise.all([
      readJson<LexicalIndexSnapshot>(path.join(indexDir, "lexical_index.json")),
      readJsonl<PrivateRagChunk>(path.join(indexDir, "rag_chunks.jsonl")),
      readJsonl<PrivateRagEmbedding>(path.join(indexDir, "embedding_index.jsonl")),
      readJson<Record<string, unknown>>(manifestPath).catch(() => null),
    ]);
    if (chunks.length === 0) {
      throw new Error(`No private RAG chunks found in ${indexDir}`);
    }
    const chunksById = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
    const embeddingsByChunkId = new Map(
      embeddings.map((entry) => [entry.chunkId, entry.embedding]),
    );
    const firstEmbedding = embeddings.find((entry) => entry.embedding.length > 0);
    const embeddingDimension =
      typeof manifest?.embeddingDimension === "number"
        ? manifest.embeddingDimension
        : firstEmbedding?.embedding.length ?? 0;
    if (embeddingDimension <= 0) {
      throw new Error("Private RAG embedding index has no usable vectors");
    }
    const missingEmbeddings = chunks.filter(
      (chunk) => !embeddingsByChunkId.has(chunk.chunkId),
    ).length;
    if (missingEmbeddings > 0) {
      throw new Error(`Private RAG embedding index is missing ${missingEmbeddings} chunk vectors`);
    }
    if (
      typeof manifest?.embeddingModel === "string" &&
      manifest.embeddingModel !== this.config.embeddingModel
    ) {
      throw new Error(
        `Private RAG embedding model mismatch: index=${manifest.embeddingModel}, runtime=${this.config.embeddingModel}`,
      );
    }
    this.privateRagIndex = {
      dbDir: this.config.privateRagDbDir,
      manifest,
      chunkCount: chunks.length,
      embeddingDimension,
      lexicalIndex,
      chunks,
      chunksById,
      embeddingsByChunkId,
    };
    this.privateRagError = null;
    return this.privateRagIndex;
  }

  private privateRagBm25Candidates(
    query: string,
    snapshot: PrivateRagIndexSnapshot,
    limit: number,
  ): Array<{
    chunk: PrivateRagChunk;
    chunkId: string;
    bm25Rank: number;
    bm25Score: number;
  }> {
    const queryTokens = privateRagTokens(query);
    const scores = new Map<string, number>();
    const k1 = 1.5;
    const b = 0.75;
    const totalDocs = snapshot.lexicalIndex.chunkCount || snapshot.chunks.length || 1;
    const avgDocLength = snapshot.lexicalIndex.avgDocLength || 1;

    for (const token of queryTokens) {
      const posting = snapshot.lexicalIndex.postings[token];
      if (!posting) {
        continue;
      }
      const idf = Math.log(
        1 + (totalDocs - posting.length + 0.5) / (posting.length + 0.5),
      );
      for (const [chunkId, tf] of posting) {
        const docLength = snapshot.lexicalIndex.docLengths[chunkId] || avgDocLength;
        const numerator = tf * (k1 + 1);
        const denominator = tf + k1 * (1 - b + b * (docLength / avgDocLength));
        scores.set(chunkId, (scores.get(chunkId) ?? 0) + idf * (numerator / denominator));
      }
    }

    return [...scores.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, limit)
      .flatMap(([chunkId, bm25Score], rank) => {
        const chunk = snapshot.chunksById.get(chunkId);
        const embedding = snapshot.embeddingsByChunkId.get(chunkId);
        return chunk && embedding
          ? [{ chunk, chunkId, bm25Rank: rank + 1, bm25Score }]
          : [];
      });
  }

  private async searchPrivateTranscriptRag(
    question: string,
    _concepts: string[],
  ): Promise<TranscriptRagHit[]> {
    const snapshot = await this.loadPrivateRagIndex();
    const queryText = stripPreviousVideoEvidenceTrigger(question) || question;
    const candidates = this.privateRagBm25Candidates(
      queryText,
      snapshot,
      this.config.privateRagBm25K,
    );
    if (candidates.length === 0) {
      return [];
    }
    const [rawVector] = await this.embeddings.embed([queryText]);
    if (!rawVector) {
      throw new Error("Embedding service returned no private RAG query vector");
    }
    const queryVector = normalizeEmbedding(rawVector);
    if (queryVector.length !== snapshot.embeddingDimension) {
      throw new Error("Private RAG embedding dimension does not match query embedding");
    }
    const scored = candidates.map((candidate) => {
      const embedding = snapshot.embeddingsByChunkId.get(candidate.chunkId);
      if (!embedding) {
        throw new Error(`Private RAG vector missing for ${candidate.chunkId}`);
      }
      return {
        ...candidate,
        semanticScore: cosine(queryVector, embedding),
      };
    });
    const bm25Norm = minMaxNormalize(scored, (result) => result.bm25Score);
    const semanticNorm = minMaxNormalize(scored, (result) => result.semanticScore);
    const reranked = scored
      .map((result) => ({
        ...result,
        hybridScore: this.config.privateRagBlend
          ? this.config.privateRagSemanticWeight * (semanticNorm.get(result) ?? 0)
            + (1 - this.config.privateRagSemanticWeight) * (bm25Norm.get(result) ?? 0)
          : result.semanticScore,
      }))
      .sort((left, right) => right.hybridScore - left.hybridScore)
      .slice(0, this.config.privateRagTopK);

    return reranked.map((result) => ({
      citationId: privateRagCitationId(result.chunkId),
      chunkId: result.chunkId,
      sessionId: result.chunk.sessionId,
      cohort: result.chunk.cohort,
      title: result.chunk.title,
      recordingPath: result.chunk.recordingPath,
      start: result.chunk.start,
      end: result.chunk.end,
      speakers: result.chunk.speakers ?? [],
      text: result.chunk.text,
      bm25Rank: result.bm25Rank,
      bm25Score: Number(result.bm25Score.toFixed(6)),
      semanticScore: Number(result.semanticScore.toFixed(6)),
      hybridScore: Number(result.hybridScore.toFixed(6)),
    }));
  }

  private async searchHistorical(
    question: string,
    concepts: string[],
    excludeCaseId?: string,
    snapshot: HistoricalIndexSnapshot | null = this.index,
  ): Promise<HistoricalCaseHit[]> {
    if (!snapshot || snapshot.entries.length === 0) {
      return [];
    }
    const queryText = [question, ...concepts].join("\n");
    const [rawVector] = await this.embeddings.embed([queryText]);
    if (!rawVector) {
      throw new Error("Embedding service returned no query vector");
    }
    const vector = normalizeEmbedding(rawVector);
    if (vector.length !== snapshot.embeddingDimension) {
      this.indexRequiresRebuild = true;
      throw new Error("Embedding dimension changed; index rebuild is required");
    }
    const candidates = snapshot.entries
      .filter((entry) => entry.caseId !== excludeCaseId)
      .map((entry) => ({ entry, score: cosine(vector, entry.embedding) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, this.config.caseCandidates);
    if (candidates.length === 0) {
      return [];
    }
    try {
      const raw = await this.models.text(
        [
          {
            role: "system",
            content: [
              "Rerank deidentified historical ECHO cases for the current medical question.",
              "Return JSON: {hits:[{caseId, similarities, keyDifferences, relevantRecommendationIndexes, relevantOutcomeIndexes}]}",
              `Return at most ${this.config.caseTopK} hits. Use only supplied facts and indexes.`,
            ].join(" "),
          },
          {
            role: "user",
            content: JSON.stringify({
              question,
              concepts,
              candidates: candidates.map(({ entry, score }) => ({
                caseId: entry.caseId,
                similarityScore: score,
                overview: entry.overview.map((item) => item.text),
                recommendations: entry.recommendations.map((item) => item.text),
                outcomes: entry.outcomes.map((item) => item.text),
              })),
            }),
          },
        ],
        1_200,
      );
      const reranked = historicalRerankSchema.parse(parseJsonObject(raw));
      return reranked.hits.slice(0, this.config.caseTopK).flatMap((hit) => {
        const candidate = candidates.find(({ entry }) => entry.caseId === hit.caseId);
        if (!candidate) {
          return [];
        }
        return [
          {
            caseId: candidate.entry.caseId,
            revisionId: candidate.entry.revisionId,
            similarityScore: Number(candidate.score.toFixed(6)),
            similarities: hit.similarities,
            keyDifferences: hit.keyDifferences,
            relevantRecommendations: hit.relevantRecommendationIndexes.flatMap(
              (index) => {
                const item = candidate.entry.recommendations[index];
                return item ? [item] : [];
              },
            ),
            relevantOutcomes: hit.relevantOutcomeIndexes.flatMap((index) => {
              const item = candidate.entry.outcomes[index];
              return item ? [item] : [];
            }),
          },
        ];
      });
    } catch {
      return candidates.slice(0, this.config.caseTopK).map(({ entry, score }) => ({
        caseId: entry.caseId,
        revisionId: entry.revisionId,
        similarityScore: Number(score.toFixed(6)),
        similarities: entry.overview.slice(0, 3).map((item) => item.text),
        keyDifferences: [],
        relevantRecommendations: entry.recommendations.slice(0, 3),
        relevantOutcomes: entry.outcomes.slice(0, 2),
      }));
    }
  }

  private async searchPubMed(question: string, query: string): Promise<PubMedHit[]> {
    const articles = await this.pubmed.search(query);
    if (articles.length === 0) {
      return [];
    }
    try {
      const raw = await withTimeout(
        this.models.text(
          [
            {
              role: "system",
              content: [
                "Rerank PubMed citation and abstract records for the medical question.",
                "Return JSON: {hits:[{pmid,relevanceReason,abstractSupportedConclusion}]}",
                `Return at most ${this.config.pubmedFinalCount} hits.`,
                "Prefer titles/abstracts that match the same medication, population, and indication as the question (e.g. methadone maintenance + chronic pain is not satisfied by a buprenorphine-initiation review).",
                "Drop off-topic hits even if they mention opioids broadly.",
                "Conclusions must be supported by the supplied abstract. Use null when no abstract is available.",
              ].join(" "),
            },
            {
              role: "user",
              content: JSON.stringify({
                question,
                articles: articles.map((article) => ({
                  pmid: article.pmid,
                  title: article.title,
                  publicationDate: article.publicationDate,
                  publicationTypes: article.publicationTypes,
                  abstract: article.abstract?.slice(
                    0,
                    this.config.pubmedRerankAbstractChars,
                  ),
                })),
              }),
            },
          ],
          700,
        ),
        this.config.pubmedRerankTimeoutMs,
        "Local PubMed reranking",
      );
      const reranked = literatureRerankSchema.parse(parseJsonObject(raw));
      return reranked.hits.slice(0, this.config.pubmedFinalCount).flatMap((hit) => {
        const article = articles.find((item) => item.pmid === hit.pmid);
        if (!article) {
          return [];
        }
        return [
          {
            ...article,
            relevanceReason: hit.relevanceReason,
            abstractSupportedConclusion: article.abstract
              ? hit.abstractSupportedConclusion
              : null,
            warnings: article.abstract ? [] : ["Abstract unavailable; no conclusion inferred"],
          },
        ];
      });
    } catch {
      return articles.slice(0, this.config.pubmedFinalCount).map((article) => ({
        ...article,
        relevanceReason: "Matched the sanitized PubMed medical concept query",
        abstractSupportedConclusion: null,
        warnings: article.abstract
          ? ["Local literature reranking unavailable; ordered by PubMed search relevance"]
          : ["Abstract unavailable; no conclusion inferred"],
      }));
    }
  }

  private evidencePacket(record: RetrievalRecord): string {
    if (!record || record.status === "failed") {
      return record
        ? "External evidence is currently unavailable. Answer from meeting context only and state this limitation briefly."
        : "";
    }
    const transcriptChunks = record.transcriptChunks.map((hit) =>
      [
        `[${hit.citationId}] semantic=${hit.semanticScore} bm25=${hit.bm25Score} bm25_rank=${hit.bm25Rank}`,
        `${hit.cohort} | ${hit.title} | ${hit.start.toFixed(1)}-${hit.end.toFixed(1)}s`,
        `Recording: ${hit.recordingPath}`,
        hit.speakers.length ? `Speakers: ${hit.speakers.join(", ")}` : "",
        `Transcript excerpt: ${hit.text.slice(0, this.config.privateRagMaxExcerptChars)}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const historical = record.historicalCases.map((hit) =>
      [
        `[Case:${hit.caseId}] similarity=${hit.similarityScore}`,
        hit.similarities.length
          ? `Similarities: ${hit.similarities.join("; ")}`
          : "",
        hit.keyDifferences.length
          ? `Differences: ${hit.keyDifferences.join("; ")}`
          : "",
        hit.relevantRecommendations.length
          ? `Relevant recommendations: ${hit.relevantRecommendations.map((item) => item.text).join("; ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const literature = record.literature.map((hit) =>
      [
        `[PMID:${hit.pmid}] ${hit.title}`,
        hit.publicationDate ? `Publication date: ${hit.publicationDate}` : "",
        `Relevance: ${hit.relevanceReason}`,
        hit.abstractSupportedConclusion
          ? `Abstract-supported conclusion: ${hit.abstractSupportedConclusion}`
          : hit.abstract
            ? `Abstract excerpt: ${hit.abstract.slice(0, 900)}`
            : "No abstract-supported conclusion is available.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return [
      "Evidence Packet (immutable retrieval record; distinguish retrieved historical ECHO transcript chunks, structured historical cases, and public literature from the current meeting content):",
      ...transcriptChunks,
      ...historical,
      ...literature,
      record.warnings.length ? `Warnings: ${record.warnings.join("; ")}` : "",
      "Use transcript chunk citations exactly as [ECHO:<chunkId>], historical case citations exactly as [Case:<caseId>], and literature citations exactly as [PMID:<pmid>].",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private newRecord(input: SearchInput & { intent: RetrievalIntent }): RetrievalRecord {
    return {
      schemaVersion: 1,
      retrievalId: randomUUID(),
      ...(input.caseId ? { caseId: input.caseId } : {}),
      ...(input.revisionId ? { revisionId: input.revisionId } : {}),
      ...(input.streamId ? { streamId: input.streamId } : {}),
      ...(input.senderUserId !== undefined
        ? { senderUserId: input.senderUserId }
        : {}),
      ...(input.senderName ? { senderName: input.senderName } : {}),
      question: input.question,
      intent: input.intent,
      sanitizedMedicalConcepts: [],
      status: "queued",
      historicalCases: [],
      transcriptChunks: [],
      literature: [],
      warnings: [],
      ...(this.index?.indexVersion
        ? { indexVersion: this.index.indexVersion }
        : {}),
      createdAt: new Date().toISOString(),
    };
  }

  private async saveRecord(record: RetrievalRecord): Promise<void> {
    await atomicWriteJson(this.recordPath(record.retrievalId), record);
    if (record.caseId) {
      await atomicWriteJson(
        path.join(
          this.config.caseDataDir,
          record.caseId,
          "retrievals",
          `${record.retrievalId}.json`,
        ),
        record,
      );
    }
  }

  async readRecord(retrievalId: string): Promise<RetrievalRecord> {
    return readJson<RetrievalRecord>(this.recordPath(retrievalId));
  }

  async recordsForCase(caseId: string): Promise<RetrievalRecord[]> {
    const directory = path.join(this.config.caseDataDir, caseId, "retrievals");
    try {
      const names = (await readdir(directory))
        .filter((name) => name.endsWith(".json"))
        .sort()
        .reverse();
      return Promise.all(
        names.map((name) => readJson<RetrievalRecord>(path.join(directory, name))),
      );
    } catch {
      return [];
    }
  }

  private async updateIndex(entry: HistoricalIndexEntry): Promise<void> {
    const existing = this.index;
    if (
      existing &&
      (existing.embeddingModel !== this.config.embeddingModel ||
        (existing.embeddingDimension !== 0 &&
          existing.embeddingDimension !== entry.embedding.length))
    ) {
      this.indexRequiresRebuild = true;
      throw new Error("Embedding model or dimension changed; index rebuild is required");
    }
    const entries = [
      ...(existing?.entries ?? []).filter((item) => item.caseId !== entry.caseId),
      entry,
    ];
    const snapshot: HistoricalIndexSnapshot = {
      schemaVersion: 1,
      indexVersion: randomUUID(),
      embeddingModel: this.config.embeddingModel,
      embeddingDimension: entry.embedding.length,
      builtAt: new Date().toISOString(),
      entries,
    };
    await this.saveIndex(snapshot);
    this.emit("retrieval-case-index-updated", {
      caseId: entry.caseId,
      revisionId: entry.revisionId,
      indexVersion: snapshot.indexVersion,
      entries: entries.length,
      reason: "incremental",
    });
  }

  private async removeCaseFromIndex(caseId: string): Promise<void> {
    if (!this.index?.entries.some((entry) => entry.caseId === caseId)) {
      return;
    }
    const snapshot: HistoricalIndexSnapshot = {
      ...this.index,
      indexVersion: randomUUID(),
      builtAt: new Date().toISOString(),
      entries: this.index.entries.filter((entry) => entry.caseId !== caseId),
    };
    await this.saveIndex(snapshot);
  }

  private async saveIndex(snapshot: HistoricalIndexSnapshot): Promise<void> {
    await atomicWriteJson(this.indexPath(), snapshot);
    await atomicWriteJson(
      path.join(
        this.config.dataDir,
        "cases",
        "builds",
        `${snapshot.indexVersion}.json`,
      ),
      snapshot,
    );
    this.index = snapshot;
  }

  private async indexForVersion(
    indexVersion?: string,
  ): Promise<HistoricalIndexSnapshot | null> {
    if (!indexVersion) {
      return this.index;
    }
    if (this.index?.indexVersion === indexVersion) {
      return this.index;
    }
    try {
      return await readJson<HistoricalIndexSnapshot>(
        path.join(
          this.config.dataDir,
          "cases",
          "builds",
          `${indexVersion}.json`,
        ),
      );
    } catch {
      throw new Error(`Historical case index snapshot not found: ${indexVersion}`);
    }
  }

  private defaultCaseQuestion(revision: CaseRevision): string {
    const questions = revisionFacts(revision, "presentingQuestions").map(
      (fact) => fact.text,
    );
    const overview = revisionFacts(revision, "caseOverview").map(
      (fact) => fact.text,
    );
    return [
      "Find similar historical ECHO cases and relevant PubMed evidence for this case.",
      ...questions,
      ...overview.slice(0, 3),
    ].join(" ");
  }

  private parseIntent(value: unknown): RetrievalIntent | undefined {
    return ["none", "historical-cases", "literature", "both"].includes(
      String(value),
    )
      ? (String(value) as RetrievalIntent)
      : undefined;
  }

  private assertEnabled(): void {
    if (!this.config.enabled) {
      throw new Error("Evidence retrieval is disabled");
    }
  }

  private indexPath(): string {
    return path.join(this.config.dataDir, "cases", "index.json");
  }

  private recordPath(retrievalId: string): string {
    return path.join(this.config.dataDir, "records", `${retrievalId}.json`);
  }
}
