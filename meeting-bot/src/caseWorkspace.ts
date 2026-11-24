import express, { type Express } from "express";
import { randomUUID } from "node:crypto";
import { type Server } from "node:http";
import { type AddressInfo } from "node:net";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AiScreenShareFrame, AsrSegment } from "./meetingAi.js";

export type CaseWorkspaceStatus = "queued" | "processing" | "complete" | "failed";
export type CaseConfidence = "high" | "medium" | "low";

export type CaseWorkspaceConfig = {
  enabled: boolean;
  available: boolean;
  unavailableReasons: string[];
  host: string;
  port: number;
  dataDir: string;
  rtmsDataDir: string;
  transcriptChunkChars: number;
  maxScreenFrames: number;
  jsonRepairAttempts: number;
  textBaseUrl: string;
  textModel: string;
  textApiKey: string;
  vlmBaseUrl: string;
  vlmModel: string;
  vlmApiKey: string;
  maxImageBytes: number;
};

export type CaseWorkspaceEventEmitter = (type: string, payload?: unknown) => void;

export type CaseWorkspaceRetrievalService = {
  registerRoutes(app: Express): void;
  onCaseRevisionCompleted(
    workspace: CaseWorkspace,
    revision: CaseRevision,
  ): Promise<void>;
};

export type CaseWorkspaceOutputService = {
  registerRoutes(app: Express): void;
  health(): unknown;
  runtimeHealth(): Promise<unknown>;
  onCaseRevisionCompleted(
    workspace: CaseWorkspace,
    revision: CaseRevision,
  ): Promise<void>;
};

export type CaseSourceSnapshot = {
  schemaVersion: 1;
  caseId: string;
  streamId: string;
  meetingUuid: string | null;
  capturedAt: string;
  meetingStartedAt: string | null;
  meetingEndedAt: string | null;
  asrPath: string | null;
  screenMetadataPath: string | null;
  segments: AsrSegment[];
  frames: AiScreenShareFrame[];
  sourceWarnings: string[];
};

export type CaseSourceProvider = (
  streamId: string,
  caseId: string,
  meetingUuid?: string | null,
  meetingStartedAt?: string | null,
  meetingEndedAt?: string | null,
) => Promise<CaseSourceSnapshot | null>;

type LlmMessageContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;

export type CaseLlmMessage = {
  role: "system" | "user" | "assistant";
  content: LlmMessageContent;
};

export type CaseModelClient = {
  text(messages: CaseLlmMessage[], maxTokens: number): Promise<string>;
  vision(messages: CaseLlmMessage[], maxTokens: number): Promise<string>;
  health(): Promise<{
    text: { ok: boolean; url: string; status?: number; error?: string };
    vision: { ok: boolean; url: string; status?: number; error?: string };
  }>;
};

const transcriptSourceRefSchema = z.object({
  type: z.literal("transcript"),
  segmentId: z.number().int().positive(),
  timestamp: z.number().finite(),
});

const screenSourceRefSchema = z.object({
  type: z.literal("screen-frame"),
  frameId: z.number().int().positive(),
  timestamp: z.number().finite(),
});

const sourceRefSchema = z.discriminatedUnion("type", [
  transcriptSourceRefSchema,
  screenSourceRefSchema,
]);

const confidenceSchema = z.enum(["high", "medium", "low"]);

const caseFactSchema = z.object({
  text: z.string().trim().min(1),
  confidence: confidenceSchema,
  sourceRefs: z.array(sourceRefSchema).min(1),
});

const recommendationSchema = caseFactSchema.extend({
  rationale: z.string().trim().nullable().default(null),
  proposer: z.string().trim().nullable().default(null),
  consensusStatus: z
    .enum(["agreed", "mixed", "proposed", "rejected", "unclear"])
    .default("unclear"),
});

const followUpSchema = caseFactSchema.extend({
  responsibleParty: z.string().trim().nullable().default(null),
  timing: z.string().trim().nullable().default(null),
});

const caseRangeSchema = z
  .object({
    startTimestamp: z.number().finite(),
    endTimestamp: z.number().finite(),
  })
  .nullable();

export const caseRevisionContentSchema = z.object({
  caseDetected: z.boolean(),
  detectionConfidence: confidenceSchema,
  caseDiscussionRange: caseRangeSchema,
  caseOverview: z.array(caseFactSchema),
  presentingQuestions: z.array(caseFactSchema),
  patientContext: z.array(caseFactSchema),
  historyAndConditions: z.array(caseFactSchema),
  medicationsAndTreatments: z.array(caseFactSchema),
  testsAndFindings: z.array(caseFactSchema),
  discussionThreads: z.array(caseFactSchema),
  recommendations: z.array(recommendationSchema),
  rejectedOrRevisedSuggestions: z.array(caseFactSchema),
  disagreements: z.array(caseFactSchema),
  unresolvedQuestionsAndDataGaps: z.array(caseFactSchema),
  followUpActions: z.array(followUpSchema),
  deidentificationWarnings: z.array(caseFactSchema),
  generationWarnings: z.array(z.string().trim().min(1)),
});

export type CaseRevisionContent = z.infer<typeof caseRevisionContentSchema>;

const evidenceCategorySchema = z.enum([
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
  "deidentificationWarnings",
]);

const extractionSchema = z.object({
  caseDetected: z.boolean(),
  detectionConfidence: confidenceSchema,
  evidence: z.array(
    z.object({
      category: evidenceCategorySchema,
      text: z.string().trim().min(1),
      confidence: confidenceSchema,
      sourceRefs: z.array(sourceRefSchema).min(1),
      rationale: z.string().trim().nullable().optional(),
      proposer: z.string().trim().nullable().optional(),
      consensusStatus: z
        .enum(["agreed", "mixed", "proposed", "rejected", "unclear"])
        .optional(),
      responsibleParty: z.string().trim().nullable().optional(),
      timing: z.string().trim().nullable().optional(),
    }),
  ),
  generationWarnings: z.array(z.string().trim().min(1)).default([]),
});

type Extraction = z.infer<typeof extractionSchema>;

export type CaseRevision = CaseRevisionContent & {
  schemaVersion: 1;
  revisionId: string;
  caseId: string;
  streamId: string;
  generatedAt: string;
  disclaimer: string;
  models: {
    text: string;
    vision: string;
  };
};

export type CaseWorkspace = {
  schemaVersion: 1;
  caseId: string;
  streamId: string;
  meetingUuid: string | null;
  meetingStartedAt: string | null;
  meetingEndedAt: string | null;
  status: CaseWorkspaceStatus;
  caseDetected: boolean | null;
  detectionConfidence: CaseConfidence | null;
  caseDiscussionRange: {
    startTimestamp: number;
    endTimestamp: number;
  } | null;
  currentRevisionId: string | null;
  revisionIds: string[];
  lastError: string | null;
  retryable: boolean;
  attemptCount: number;
  sourceManifest: {
    capturedAt: string | null;
    segmentCount: number;
    screenFrameCount: number;
    asrPath: string | null;
    screenMetadataPath: string | null;
  };
  models: {
    text: string;
    vision: string;
  };
  createdAt: string;
  updatedAt: string;
};

type SessionClosedInput = {
  streamId: string;
  meetingUuid: string | null;
  startedAt?: string | null;
  closedAt?: string | null;
  reason?: string;
};

type GenerationRequest = {
  caseId: string;
  reason: "session-closed" | "backfill" | "regenerate" | "recovered";
  refreshSources: boolean;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: { content?: string };
    text?: string;
  }>;
  error?: { message?: string } | string;
};

const TEXT_EXTRACTION_MAX_TOKENS = 1_600;
const VISION_EXTRACTION_MAX_TOKENS = 1_200;
const AGGREGATION_MAX_TOKENS = 3_000;
const DISCLAIMER =
  "AI-generated ECHO internal summary for education and review. Not a medical record or independent clinical recommendation.";

function sanitizePathPart(value: unknown): string {
  const text = String(value ?? "unknown").trim();
  return text.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonFromText(value: string): unknown {
  let text = value.trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last >= first) {
    text = text.slice(first, last + 1);
  }
  return JSON.parse(text);
}

function transcriptLine(segment: AsrSegment): string {
  return JSON.stringify({
    segmentId: segment.id,
    timestamp: segment.startTimestamp,
    endTimestamp: segment.endTimestamp,
    speaker: segment.userName ?? `user-${segment.userId ?? "unknown"}`,
    text: segment.text,
  });
}

function chunkSegments(segments: AsrSegment[], maxChars: number): AsrSegment[][] {
  const chunks: AsrSegment[][] = [];
  let current: AsrSegment[] = [];
  let chars = 0;

  for (const segment of segments) {
    const cost = transcriptLine(segment).length + 1;
    if (current.length > 0 && chars + cost > maxChars) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(segment);
    chars += cost;
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function frameMimeType(frame: AiScreenShareFrame): string {
  return frame.codec.toUpperCase() === "PNG" ||
    frame.fileName.toLowerCase().endsWith(".png")
    ? "image/png"
    : "image/jpeg";
}

function selectKeyFrames(
  frames: AiScreenShareFrame[],
  maxFrames: number,
): AiScreenShareFrame[] {
  const sorted = [...frames].sort((left, right) => left.timestamp - right.timestamp);
  if (sorted.length <= maxFrames) {
    return sorted;
  }

  const ranked = sorted.map((frame, index) => {
    const next = sorted[index + 1];
    const dwellMs = next
      ? Math.max(0, next.timestamp - frame.timestamp)
      : index > 0
        ? Math.max(0, frame.timestamp - (sorted[index - 1]?.timestamp ?? frame.timestamp))
        : 0;
    return { frame, dwellMs, edge: index === 0 || index === sorted.length - 1 };
  });

  return ranked
    .sort((left, right) => {
      if (left.edge !== right.edge) {
        return left.edge ? -1 : 1;
      }
      return right.dwellMs - left.dwellMs;
    })
    .slice(0, maxFrames)
    .map((item) => item.frame)
    .sort((left, right) => left.timestamp - right.timestamp);
}

function batch<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function sourceRange(refs: Array<z.infer<typeof sourceRefSchema>>) {
  if (refs.length === 0) {
    return null;
  }
  const timestamps = refs.map((ref) => ref.timestamp);
  return {
    startTimestamp: Math.min(...timestamps),
    endTimestamp: Math.max(...timestamps),
  };
}

function emptyRevisionContent(
  warnings: string[],
  confidence: CaseConfidence = "low",
): CaseRevisionContent {
  return {
    caseDetected: false,
    detectionConfidence: confidence,
    caseDiscussionRange: null,
    caseOverview: [],
    presentingQuestions: [],
    patientContext: [],
    historyAndConditions: [],
    medicationsAndTreatments: [],
    testsAndFindings: [],
    discussionThreads: [],
    recommendations: [],
    rejectedOrRevisedSuggestions: [],
    disagreements: [],
    unresolvedQuestionsAndDataGaps: [],
    followUpActions: [],
    deidentificationWarnings: [],
    generationWarnings: warnings,
  };
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

async function readNdjson<T>(filePath: string): Promise<{
  entries: T[];
  warnings: string[];
}> {
  try {
    const text = await readFile(filePath, "utf8");
    const entries: T[] = [];
    const warnings: string[] = [];
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!line.trim()) {
        continue;
      }
      try {
        entries.push(JSON.parse(line) as T);
      } catch (error) {
        warnings.push(
          `Skipped malformed NDJSON line ${index + 1} in ${filePath}: ${errorMessage(error)}`,
        );
      }
    }
    return { entries, warnings };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { entries: [], warnings: [`Source file not found: ${filePath}`] };
    }
    throw error;
  }
}

export async function loadCaseSourceFromDisk(
  rtmsDataDir: string,
  streamId: string,
  caseId: string,
  meetingUuid?: string | null,
  meetingStartedAt?: string | null,
  meetingEndedAt?: string | null,
): Promise<CaseSourceSnapshot> {
  const safeStreamId = sanitizePathPart(streamId);
  const asrPath = path.join(rtmsDataDir, "asr", `${safeStreamId}.ndjson`);
  const screenMetadataPath = path.join(
    rtmsDataDir,
    "screenshare",
    safeStreamId,
    "unique",
    "unique_metadata.ndjson",
  );
  const [asr, screens] = await Promise.all([
    readNdjson<AsrSegment>(asrPath),
    readNdjson<AiScreenShareFrame>(screenMetadataPath),
  ]);
  const allTimestamps = [
    ...asr.entries.flatMap((segment) => [
      segment.startTimestamp,
      segment.endTimestamp,
    ]),
    ...screens.entries.map((frame) => frame.timestamp),
  ].filter((value) => Number.isFinite(value) && value > 0);

  return {
    schemaVersion: 1,
    caseId,
    streamId,
    meetingUuid:
      meetingUuid ??
      asr.entries[0]?.meetingUuid ??
      screens.entries[0]?.meetingUuid ??
      null,
    capturedAt: new Date().toISOString(),
    meetingStartedAt:
      meetingStartedAt ??
      (allTimestamps.length > 0
        ? new Date(Math.min(...allTimestamps)).toISOString()
        : null),
    meetingEndedAt:
      meetingEndedAt ??
      (allTimestamps.length > 0
        ? new Date(Math.max(...allTimestamps)).toISOString()
        : null),
    asrPath,
    screenMetadataPath,
    segments: asr.entries.sort(
      (left, right) => left.startTimestamp - right.startTimestamp,
    ),
    frames: screens.entries.sort((left, right) => left.timestamp - right.timestamp),
    sourceWarnings: [...asr.warnings, ...screens.warnings],
  };
}

export class OpenAiCaseModelClient implements CaseModelClient {
  constructor(private readonly config: CaseWorkspaceConfig) {}

  text(messages: CaseLlmMessage[], maxTokens: number): Promise<string> {
    return this.call(
      this.config.textBaseUrl,
      this.config.textModel,
      this.config.textApiKey,
      messages,
      maxTokens,
    );
  }

  vision(messages: CaseLlmMessage[], maxTokens: number): Promise<string> {
    return this.call(
      this.config.vlmBaseUrl,
      this.config.vlmModel,
      this.config.vlmApiKey,
      messages,
      maxTokens,
    );
  }

  async health() {
    const [text, vision] = await Promise.all([
      this.check(`${this.config.textBaseUrl.replace(/\/$/, "")}/models`),
      this.check(`${this.config.vlmBaseUrl.replace(/\/$/, "")}/models`),
    ]);
    return { text, vision };
  }

  private async call(
    baseUrl: string,
    model: string,
    apiKey: string,
    messages: CaseLlmMessage[],
    maxTokens: number,
  ): Promise<string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.1,
        max_tokens: maxTokens,
        chat_template_kwargs: {
          enable_thinking: false,
        },
      }),
    });
    const body = (await response.json().catch(() => ({}))) as ChatCompletionResponse;
    if (!response.ok) {
      const message =
        typeof body.error === "string"
          ? body.error
          : body.error?.message || `LLM request failed with HTTP ${response.status}`;
      throw new Error(message);
    }
    const content =
      body.choices?.[0]?.message?.content ?? body.choices?.[0]?.text ?? "";
    if (!content.trim()) {
      throw new Error("LLM returned an empty response");
    }
    return content;
  }

  private async check(url: string) {
    try {
      const response = await fetch(url);
      return { ok: response.ok, url, status: response.status };
    } catch (error) {
      return { ok: false, url, error: errorMessage(error) };
    }
  }
}

export class CaseWorkspaceManager {
  private readonly workspaces = new Map<string, CaseWorkspace>();
  private readonly caseIdByStream = new Map<string, string>();
  private generationChain: Promise<void> = Promise.resolve();
  private server: Server | null = null;
  private serverError: string | null = null;
  private initialized = false;
  private retrievalService: CaseWorkspaceRetrievalService | null = null;
  private outputService: CaseWorkspaceOutputService | null = null;

  constructor(
    private readonly config: CaseWorkspaceConfig,
    private readonly emit: CaseWorkspaceEventEmitter,
    private readonly sourceProvider: CaseSourceProvider,
    private readonly models: CaseModelClient = new OpenAiCaseModelClient(config),
  ) {}

  setRetrievalService(service: CaseWorkspaceRetrievalService): void {
    this.retrievalService = service;
  }

  setOutputService(service: CaseWorkspaceOutputService): void {
    this.outputService = service;
  }

  health() {
    const values = Array.from(this.workspaces.values());
    return {
      enabled: this.config.enabled,
      available: this.config.available,
      unavailableReasons: this.config.unavailableReasons,
      host: this.config.host,
      port: this.config.port,
      listeningPort:
        (this.server?.address() as AddressInfo | null)?.port ?? null,
      listening: Boolean(this.server?.listening),
      serverError: this.serverError,
      dataDir: this.config.dataDir,
      transcriptChunkChars: this.config.transcriptChunkChars,
      maxScreenFrames: this.config.maxScreenFrames,
      jsonRepairAttempts: this.config.jsonRepairAttempts,
      workspaces: values.length,
      queued: values.filter((workspace) => workspace.status === "queued").length,
      processing: values.filter((workspace) => workspace.status === "processing").length,
      complete: values.filter((workspace) => workspace.status === "complete").length,
      failed: values.filter((workspace) => workspace.status === "failed").length,
      caseOutput: this.outputService?.health() ?? null,
    };
  }

  async runtimeHealth() {
    return {
      ...this.health(),
      services: this.config.enabled ? await this.models.health() : null,
      caseOutput: this.outputService
        ? await this.outputService.runtimeHealth()
        : null,
    };
  }

  async start(): Promise<void> {
    if (!this.config.enabled || this.server) {
      return;
    }
    await this.initialize();
    const app = this.createApp();
    await new Promise<void>((resolve, reject) => {
      const server = app.listen(this.config.port, this.config.host, () => {
        this.server = server;
        this.serverError = null;
        resolve();
      });
      server.once("error", (error) => {
        this.serverError = errorMessage(error);
        reject(error);
      });
    });
  }

  async shutdown(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = null;
    }
    await this.generationChain.catch(() => undefined);
  }

  async handleSessionClosed(input: SessionClosedInput): Promise<CaseWorkspace | null> {
    if (!this.config.enabled) {
      return null;
    }
    await this.initialize();
    if (!this.config.available) {
      this.emit("case-workspace-generation-failed", {
        streamId: input.streamId,
        reason: "unavailable",
        unavailableReasons: this.config.unavailableReasons,
      });
      return null;
    }

    const existing = this.workspaceForStream(input.streamId);
    if (existing) {
      return existing;
    }

    const workspace = this.newWorkspace(input);
    this.registerWorkspace(workspace);
    await this.saveWorkspace(workspace);
    this.emit("case-workspace-queued", {
      caseId: workspace.caseId,
      streamId: workspace.streamId,
      reason: input.reason ?? "session-closed",
    });
    this.enqueue({
      caseId: workspace.caseId,
      reason: "session-closed",
      refreshSources: true,
    });
    return workspace;
  }

  async backfill(streamId: string): Promise<CaseWorkspace> {
    this.assertUsable();
    await this.initialize();
    const existing = this.workspaceForStream(streamId);
    if (existing) {
      if (existing.status === "queued" || existing.status === "processing") {
        return existing;
      }
      if (existing.status === "complete") {
        return existing;
      }
      await this.queueExisting(existing, "backfill");
      return existing;
    }

    const workspace = this.newWorkspace({
      streamId,
      meetingUuid: null,
      reason: "backfill",
    });
    this.registerWorkspace(workspace);
    await this.saveWorkspace(workspace);
    this.emit("case-workspace-queued", {
      caseId: workspace.caseId,
      streamId,
      reason: "backfill",
    });
    this.enqueue({
      caseId: workspace.caseId,
      reason: "backfill",
      refreshSources: true,
    });
    return workspace;
  }

  async regenerate(caseId: string): Promise<CaseWorkspace> {
    this.assertUsable();
    await this.initialize();
    const workspace = this.workspaces.get(caseId);
    if (!workspace) {
      throw new Error(`Case workspace not found: ${caseId}`);
    }
    if (workspace.status === "queued" || workspace.status === "processing") {
      throw new Error("Case workspace generation is already in progress");
    }
    await this.queueExisting(workspace, "regenerate");
    this.emit("case-workspace-regeneration-requested", {
      caseId,
      streamId: workspace.streamId,
    });
    return workspace;
  }

  async waitForIdle(): Promise<void> {
    await this.generationChain.catch(() => undefined);
  }

  list(options: {
    status?: CaseWorkspaceStatus;
    limit?: number;
    cursor?: string;
  } = {}) {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    let values = Array.from(this.workspaces.values())
      .filter((workspace) => !options.status || workspace.status === options.status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    if (options.cursor) {
      const index = values.findIndex((workspace) => workspace.caseId === options.cursor);
      if (index >= 0) {
        values = values.slice(index + 1);
      }
    }
    const items = values.slice(0, limit);
    return {
      items,
      nextCursor: values.length > limit ? items.at(-1)?.caseId ?? null : null,
    };
  }

  async get(caseId: string) {
    const workspace = this.workspaces.get(caseId);
    if (!workspace) {
      return null;
    }
    const currentRevision = workspace.currentRevisionId
      ? await this.readRevision(caseId, workspace.currentRevisionId)
      : null;
    return { workspace, currentRevision };
  }

  async revisions(caseId: string) {
    const workspace = this.workspaces.get(caseId);
    if (!workspace) {
      return null;
    }
    return Promise.all(
      workspace.revisionIds.map((revisionId) => this.readRevision(caseId, revisionId)),
    );
  }

  async revision(caseId: string, revisionId: string) {
    const workspace = this.workspaces.get(caseId);
    if (!workspace || !workspace.revisionIds.includes(revisionId)) {
      return null;
    }
    return this.readRevision(caseId, revisionId);
  }

  private async initialize(): Promise<void> {
    if (this.initialized || !this.config.enabled) {
      return;
    }
    this.initialized = true;
    await mkdir(this.config.dataDir, { recursive: true });
    const entries = await readdir(this.config.dataDir, { withFileTypes: true });
    const queued: CaseWorkspace[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const workspacePath = this.workspacePath(entry.name);
      try {
        const workspace = await readJson<CaseWorkspace>(workspacePath);
        if (workspace.status === "processing") {
          workspace.status = "failed";
          workspace.retryable = true;
          workspace.lastError = "Generation was interrupted by a process restart";
          workspace.updatedAt = new Date().toISOString();
          await this.saveWorkspace(workspace);
        } else if (workspace.status === "queued") {
          queued.push(workspace);
        }
        this.registerWorkspace(workspace);
      } catch (error) {
        this.emit("case-workspace-generation-failed", {
          caseId: entry.name,
          reason: "workspace-load-failed",
          message: errorMessage(error),
        });
      }
    }

    for (const workspace of queued) {
      this.enqueue({
        caseId: workspace.caseId,
        reason: "recovered",
        refreshSources: false,
      });
    }
  }

  private createApp(): Express {
    const app = express();
    app.use(express.json({ limit: "1mb" }));

    app.get("/health", async (_req, res) => {
      res.json({ ok: true, caseWorkspace: await this.runtimeHealth() });
    });

    app.get("/cases", (req, res) => {
      const rawStatus = typeof req.query.status === "string" ? req.query.status : "";
      const status = ["queued", "processing", "complete", "failed"].includes(rawStatus)
        ? (rawStatus as CaseWorkspaceStatus)
        : undefined;
      const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
      const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
      res.json({
        ok: true,
        ...this.list({
          status,
          limit: Number.isInteger(rawLimit) && (rawLimit ?? 0) > 0 ? rawLimit : undefined,
          cursor,
        }),
      });
    });

    app.get("/cases/:caseId", async (req, res) => {
      const result = await this.get(req.params.caseId);
      if (!result) {
        res.status(404).json({ ok: false, error: "Case workspace not found" });
        return;
      }
      res.json({ ok: true, ...result });
    });

    app.get("/cases/:caseId/revisions", async (req, res) => {
      const revisions = await this.revisions(req.params.caseId);
      if (!revisions) {
        res.status(404).json({ ok: false, error: "Case workspace not found" });
        return;
      }
      res.json({ ok: true, revisions });
    });

    app.get("/cases/:caseId/revisions/:revisionId", async (req, res) => {
      const revision = await this.revision(
        req.params.caseId,
        req.params.revisionId,
      );
      if (!revision) {
        res.status(404).json({ ok: false, error: "Revision not found" });
        return;
      }
      res.json({ ok: true, revision });
    });

    app.post("/cases/:caseId/regenerate", async (req, res) => {
      try {
        const workspace = await this.regenerate(req.params.caseId);
        res.status(202).json({ ok: true, workspace });
      } catch (error) {
        const message = errorMessage(error);
        res
          .status(message.includes("not found") ? 404 : message.includes("progress") ? 409 : 503)
          .json({ ok: false, error: message });
      }
    });

    app.post("/cases/backfill", async (req, res) => {
      try {
        const streamId =
          typeof req.body?.streamId === "string" ? req.body.streamId.trim() : "";
        if (!streamId) {
          res.status(400).json({ ok: false, error: "streamId is required" });
          return;
        }
        const workspace = await this.backfill(streamId);
        res.status(202).json({ ok: true, workspace });
      } catch (error) {
        res.status(503).json({ ok: false, error: errorMessage(error) });
      }
    });

    this.retrievalService?.registerRoutes(app);
    this.outputService?.registerRoutes(app);

    app.use((req, res) => {
      res.status(404).json({ ok: false, error: `Not found: ${req.method} ${req.path}` });
    });
    return app;
  }

  private assertUsable(): void {
    if (!this.config.enabled) {
      throw new Error("Case workspace is disabled");
    }
    if (!this.config.available) {
      throw new Error(
        `Case workspace is unavailable: ${this.config.unavailableReasons.join(", ")}`,
      );
    }
  }

  private newWorkspace(input: SessionClosedInput): CaseWorkspace {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      caseId: randomUUID(),
      streamId: input.streamId,
      meetingUuid: input.meetingUuid,
      meetingStartedAt: input.startedAt ?? null,
      meetingEndedAt: input.closedAt ?? null,
      status: "queued",
      caseDetected: null,
      detectionConfidence: null,
      caseDiscussionRange: null,
      currentRevisionId: null,
      revisionIds: [],
      lastError: null,
      retryable: false,
      attemptCount: 0,
      sourceManifest: {
        capturedAt: null,
        segmentCount: 0,
        screenFrameCount: 0,
        asrPath: null,
        screenMetadataPath: null,
      },
      models: {
        text: this.config.textModel,
        vision: this.config.vlmModel,
      },
      createdAt: now,
      updatedAt: now,
    };
  }

  private registerWorkspace(workspace: CaseWorkspace): void {
    this.workspaces.set(workspace.caseId, workspace);
    this.caseIdByStream.set(workspace.streamId, workspace.caseId);
  }

  private workspaceForStream(streamId: string): CaseWorkspace | null {
    const caseId = this.caseIdByStream.get(streamId);
    return caseId ? this.workspaces.get(caseId) ?? null : null;
  }

  private async queueExisting(
    workspace: CaseWorkspace,
    reason: GenerationRequest["reason"],
  ): Promise<void> {
    workspace.status = "queued";
    workspace.lastError = null;
    workspace.retryable = false;
    workspace.updatedAt = new Date().toISOString();
    await this.saveWorkspace(workspace);
    this.enqueue({
      caseId: workspace.caseId,
      reason,
      refreshSources: false,
    });
  }

  private enqueue(request: GenerationRequest): void {
    this.generationChain = this.generationChain
      .then(() => this.generate(request))
      .catch((error) => {
        this.emit("case-workspace-generation-failed", {
          caseId: request.caseId,
          reason: "queue-error",
          message: errorMessage(error),
        });
      });
  }

  private async generate(request: GenerationRequest): Promise<void> {
    const workspace = this.workspaces.get(request.caseId);
    if (!workspace) {
      return;
    }
    workspace.status = "processing";
    workspace.lastError = null;
    workspace.retryable = false;
    workspace.attemptCount += 1;
    workspace.updatedAt = new Date().toISOString();
    await this.saveWorkspace(workspace);
    await this.logAttempt(workspace.caseId, {
      event: "started",
      reason: request.reason,
      attempt: workspace.attemptCount,
      createdAt: workspace.updatedAt,
    });
    this.emit("case-workspace-generation-started", {
      caseId: workspace.caseId,
      streamId: workspace.streamId,
      reason: request.reason,
      attempt: workspace.attemptCount,
    });

    try {
      let source: CaseSourceSnapshot;
      if (!request.refreshSources) {
        try {
          source = await readJson<CaseSourceSnapshot>(
            this.sourcesPath(workspace.caseId),
          );
        } catch {
          source =
            (await this.sourceProvider(
              workspace.streamId,
              workspace.caseId,
              workspace.meetingUuid,
              workspace.meetingStartedAt,
              workspace.meetingEndedAt,
            )) ??
            (await loadCaseSourceFromDisk(
              this.config.rtmsDataDir,
              workspace.streamId,
              workspace.caseId,
              workspace.meetingUuid,
              workspace.meetingStartedAt,
              workspace.meetingEndedAt,
            ));
          await atomicWriteJson(this.sourcesPath(workspace.caseId), source);
        }
      } else {
        source =
          (await this.sourceProvider(
            workspace.streamId,
            workspace.caseId,
            workspace.meetingUuid,
            workspace.meetingStartedAt,
            workspace.meetingEndedAt,
          )) ??
          (await loadCaseSourceFromDisk(
            this.config.rtmsDataDir,
            workspace.streamId,
            workspace.caseId,
            workspace.meetingUuid,
            workspace.meetingStartedAt,
            workspace.meetingEndedAt,
          ));
        await atomicWriteJson(this.sourcesPath(workspace.caseId), source);
      }

      workspace.meetingUuid = source.meetingUuid;
      workspace.meetingStartedAt = source.meetingStartedAt;
      workspace.meetingEndedAt = source.meetingEndedAt;
      workspace.sourceManifest = {
        capturedAt: source.capturedAt,
        segmentCount: source.segments.length,
        screenFrameCount: source.frames.length,
        asrPath: source.asrPath,
        screenMetadataPath: source.screenMetadataPath,
      };
      workspace.updatedAt = new Date().toISOString();
      await this.saveWorkspace(workspace);
      this.emit("case-workspace-source-snapshotted", {
        caseId: workspace.caseId,
        streamId: workspace.streamId,
        segmentCount: source.segments.length,
        screenFrameCount: source.frames.length,
      });

      const content = await this.generateRevisionContent(source);
      const revision: CaseRevision = {
        schemaVersion: 1,
        revisionId: randomUUID(),
        caseId: workspace.caseId,
        streamId: workspace.streamId,
        generatedAt: new Date().toISOString(),
        disclaimer: DISCLAIMER,
        models: {
          text: this.config.textModel,
          vision: this.config.vlmModel,
        },
        ...content,
      };
      await atomicWriteJson(
        this.revisionPath(workspace.caseId, revision.revisionId),
        revision,
      );

      workspace.status = "complete";
      workspace.caseDetected = revision.caseDetected;
      workspace.detectionConfidence = revision.detectionConfidence;
      workspace.caseDiscussionRange = revision.caseDiscussionRange;
      workspace.currentRevisionId = revision.revisionId;
      workspace.revisionIds.push(revision.revisionId);
      workspace.lastError = null;
      workspace.retryable = false;
      workspace.updatedAt = revision.generatedAt;
      await this.saveWorkspace(workspace);
      await this.logAttempt(workspace.caseId, {
        event: "completed",
        revisionId: revision.revisionId,
        caseDetected: revision.caseDetected,
        createdAt: revision.generatedAt,
      });
      this.emit("case-workspace-generation-completed", {
        caseId: workspace.caseId,
        streamId: workspace.streamId,
        revisionId: revision.revisionId,
        caseDetected: revision.caseDetected,
      });
      if (this.outputService) {
        await this.outputService
          .onCaseRevisionCompleted(workspace, revision)
          .catch((error) => {
            this.emit("case-output-failed", {
              caseId: workspace.caseId,
              revisionId: revision.revisionId,
              reason: "revision-hook-failed",
              message: errorMessage(error),
            });
          });
      }
      if (this.retrievalService) {
        await this.retrievalService
          .onCaseRevisionCompleted(workspace, revision)
          .catch((error) => {
            this.emit("retrieval-case-index-update-failed", {
              caseId: workspace.caseId,
              revisionId: revision.revisionId,
              message: errorMessage(error),
            });
          });
      }
    } catch (error) {
      workspace.status = "failed";
      workspace.lastError = errorMessage(error);
      workspace.retryable = true;
      workspace.updatedAt = new Date().toISOString();
      await this.saveWorkspace(workspace);
      await this.logAttempt(workspace.caseId, {
        event: "failed",
        message: workspace.lastError,
        createdAt: workspace.updatedAt,
      });
      this.emit("case-workspace-generation-failed", {
        caseId: workspace.caseId,
        streamId: workspace.streamId,
        message: workspace.lastError,
      });
    }
  }

  private async generateRevisionContent(
    source: CaseSourceSnapshot,
  ): Promise<CaseRevisionContent> {
    const extractions: Extraction[] = [];
    const transcriptChunks = chunkSegments(
      source.segments,
      this.config.transcriptChunkChars,
    );

    for (const [index, chunk] of transcriptChunks.entries()) {
      const raw = await this.models.text(
        [
          {
            role: "system",
            content:
              "You extract source-grounded facts from an ECHO meeting transcript for an internal post-session case summary. Distinguish one patient case presentation/discussion from didactic teaching and meeting administration. Never infer missing clinical facts. Return JSON only. Every evidence item must cite one or more provided transcript segmentId values and use type 'transcript'.",
          },
          {
            role: "user",
            content: [
              `Transcript chunk ${index + 1}/${transcriptChunks.length}:`,
              chunk.map(transcriptLine).join("\n"),
              "Return this JSON shape:",
              JSON.stringify({
                caseDetected: true,
                detectionConfidence: "high|medium|low",
                evidence: [
                  {
                    category:
                      "caseOverview|presentingQuestions|patientContext|historyAndConditions|medicationsAndTreatments|testsAndFindings|discussionThreads|recommendations|rejectedOrRevisedSuggestions|disagreements|unresolvedQuestionsAndDataGaps|followUpActions|deidentificationWarnings",
                    text: "fact stated in the source",
                    confidence: "high|medium|low",
                    sourceRefs: [
                      {
                        type: "transcript",
                        segmentId: 1,
                        timestamp: 0,
                      },
                    ],
                    rationale: null,
                    proposer: null,
                    consensusStatus: "unclear",
                    responsibleParty: null,
                    timing: null,
                  },
                ],
                generationWarnings: [],
              }),
              "If this chunk contains only didactic or administrative content, set caseDetected=false and evidence=[].",
            ].join("\n\n"),
          },
        ],
        TEXT_EXTRACTION_MAX_TOKENS,
      );
      extractions.push(
        await this.parseWithRepair(
          raw,
          extractionSchema,
          `transcript extraction ${index + 1}`,
          (value) =>
            this.validateExtractionReferences(value, {
              transcriptSegments: chunk,
              screenFrames: [],
            }),
        ),
      );
    }

    const selectedFrames = selectKeyFrames(
      source.frames,
      this.config.maxScreenFrames,
    );
    for (const [index, frames] of batch(selectedFrames, 3).entries()) {
      const content: Exclude<LlmMessageContent, string> = [
        {
          type: "text",
          text: [
            `Screen-share batch ${index + 1}.`,
            "Extract only patient-case facts explicitly visible in these images. Ignore didactic slides, title slides, and general educational material. Return JSON only. Every item must cite a provided frameId with type 'screen-frame'.",
            "Frames:",
            ...frames.map((frame) =>
              JSON.stringify({
                frameId: frame.frameId,
                timestamp: frame.timestamp,
                presenter: frame.userName,
                fileName: frame.fileName,
              }),
            ),
            "Return this JSON shape:",
            JSON.stringify({
              caseDetected: true,
              detectionConfidence: "high|medium|low",
              evidence: [
                {
                  category:
                    "caseOverview|presentingQuestions|patientContext|historyAndConditions|medicationsAndTreatments|testsAndFindings|discussionThreads|recommendations|rejectedOrRevisedSuggestions|disagreements|unresolvedQuestionsAndDataGaps|followUpActions|deidentificationWarnings",
                  text: "fact visible in the image",
                  confidence: "high|medium|low",
                  sourceRefs: [
                    {
                      type: "screen-frame",
                      frameId: 1,
                      timestamp: 0,
                    },
                  ],
                  rationale: null,
                  proposer: null,
                  consensusStatus: "unclear",
                  responsibleParty: null,
                  timing: null,
                },
              ],
              generationWarnings: [],
            }),
            "If the images contain only didactic or administrative material, set caseDetected=false and evidence=[].",
          ].join("\n"),
        },
      ];
      const included: AiScreenShareFrame[] = [];
      for (const frame of frames) {
        try {
          const image = await readFile(frame.filePath);
          if (image.length > this.config.maxImageBytes) {
            continue;
          }
          content.push({
            type: "image_url",
            image_url: {
              url: `data:${frameMimeType(frame)};base64,${image.toString("base64")}`,
            },
          });
          included.push(frame);
        } catch {
          // Missing frames are recorded through generation warnings below.
        }
      }
      if (included.length === 0) {
        continue;
      }
      const raw = await this.models.vision(
        [
          {
            role: "system",
            content:
              "You are the visual evidence extractor for an ECHO post-session case summary. Return only source-grounded JSON and do not infer patient details.",
          },
          { role: "user", content },
        ],
        VISION_EXTRACTION_MAX_TOKENS,
      );
      extractions.push(
        await this.parseWithRepair(
          raw,
          extractionSchema,
          `screen extraction ${index + 1}`,
          (value) =>
            this.validateExtractionReferences(value, {
              transcriptSegments: [],
              screenFrames: included,
            }),
        ),
      );
    }

    const evidence = extractions.flatMap((extraction) => extraction.evidence);
    const detected = extractions.some(
      (extraction) => extraction.caseDetected && extraction.evidence.length > 0,
    );
    const warnings = [
      ...source.sourceWarnings,
      ...extractions.flatMap((extraction) => extraction.generationWarnings),
    ];
    if (!detected || evidence.length === 0) {
      return emptyRevisionContent(
        Array.from(
          new Set([
            ...warnings,
            "No source-grounded patient case discussion was detected.",
          ]),
        ),
      );
    }

    const raw = await this.models.text(
      [
        {
          role: "system",
          content:
            "You assemble an immutable ECHO internal case summary from extracted evidence. Deduplicate semantically equivalent items, preserve disagreements and rejected suggestions, and never add information not present in evidence. Copy sourceRefs exactly. Return JSON only.",
        },
        {
          role: "user",
          content: [
            "Extracted evidence:",
            JSON.stringify(evidence),
            "Source warnings:",
            JSON.stringify(warnings),
            "Return a JSON object with exactly these fields:",
            JSON.stringify(emptyRevisionContent([])),
            "Set caseDetected=true. detectionConfidence must be high, medium, or low. Compute caseDiscussionRange from cited timestamps.",
          ].join("\n\n"),
        },
      ],
      AGGREGATION_MAX_TOKENS,
    );

    const content = await this.parseWithRepair(
      raw,
      caseRevisionContentSchema,
      "case aggregation",
      (value) => this.validateSourceReferences(value, source),
    );
    content.generationWarnings = Array.from(
      new Set([...warnings, ...content.generationWarnings]),
    );
    const refs = this.allSourceRefs(content);
    content.caseDiscussionRange = sourceRange(refs);
    content.caseDetected = refs.length > 0;
    return content;
  }

  private async parseWithRepair<TSchema extends z.ZodTypeAny>(
    raw: string,
    schema: TSchema,
    label: string,
    validate?: (value: z.output<TSchema>) => void,
  ): Promise<z.output<TSchema>> {
    let candidate = raw;
    let lastError = "";

    for (let attempt = 0; attempt <= this.config.jsonRepairAttempts; attempt += 1) {
      try {
        const parsed = schema.parse(jsonFromText(candidate));
        validate?.(parsed);
        return parsed;
      } catch (error) {
        lastError = errorMessage(error);
        if (attempt >= this.config.jsonRepairAttempts) {
          break;
        }
        candidate = await this.models.text(
          [
            {
              role: "system",
              content:
                "Repair the provided output into valid JSON matching the requested schema. Preserve only existing facts and source references. Return JSON only.",
            },
            {
              role: "user",
              content: [
                `Stage: ${label}`,
                `Validation error: ${lastError}`,
                "Invalid output:",
                candidate,
              ].join("\n\n"),
            },
          ],
          AGGREGATION_MAX_TOKENS,
        );
      }
    }
    throw new Error(`${label} failed JSON validation: ${lastError}`);
  }

  private allSourceRefs(content: CaseRevisionContent) {
    return [
      ...content.caseOverview,
      ...content.presentingQuestions,
      ...content.patientContext,
      ...content.historyAndConditions,
      ...content.medicationsAndTreatments,
      ...content.testsAndFindings,
      ...content.discussionThreads,
      ...content.recommendations,
      ...content.rejectedOrRevisedSuggestions,
      ...content.disagreements,
      ...content.unresolvedQuestionsAndDataGaps,
      ...content.followUpActions,
      ...content.deidentificationWarnings,
    ].flatMap((item) => item.sourceRefs);
  }

  private validateSourceReferences(
    content: CaseRevisionContent,
    source: CaseSourceSnapshot,
  ): void {
    const segmentIds = new Set(source.segments.map((segment) => segment.id));
    const frameIds = new Set(source.frames.map((frame) => frame.frameId));
    for (const ref of this.allSourceRefs(content)) {
      if (ref.type === "transcript") {
        const segment = source.segments.find((item) => item.id === ref.segmentId);
        if (!segmentIds.has(ref.segmentId) || !segment) {
          throw new Error(`Unknown transcript segmentId ${ref.segmentId}`);
        }
        if (ref.timestamp !== segment.startTimestamp) {
          throw new Error(
            `Transcript segmentId ${ref.segmentId} must use timestamp ${segment.startTimestamp}`,
          );
        }
      }
      if (ref.type === "screen-frame") {
        const frame = source.frames.find((item) => item.frameId === ref.frameId);
        if (!frameIds.has(ref.frameId) || !frame) {
          throw new Error(`Unknown screen frameId ${ref.frameId}`);
        }
        if (ref.timestamp !== frame.timestamp) {
          throw new Error(
            `Screen frameId ${ref.frameId} must use timestamp ${frame.timestamp}`,
          );
        }
      }
    }
  }

  private validateExtractionReferences(
    extraction: Extraction,
    allowed: {
      transcriptSegments: AsrSegment[];
      screenFrames: AiScreenShareFrame[];
    },
  ): void {
    const segments = new Map(
      allowed.transcriptSegments.map((segment) => [segment.id, segment]),
    );
    const frames = new Map(allowed.screenFrames.map((frame) => [frame.frameId, frame]));

    for (const item of extraction.evidence) {
      for (const ref of item.sourceRefs) {
        if (ref.type === "transcript") {
          const segment = segments.get(ref.segmentId);
          if (!segment) {
            throw new Error(
              `Unknown transcript segmentId ${ref.segmentId}; valid IDs: ${[
                ...segments.keys(),
              ].join(", ")}`,
            );
          }
          if (ref.timestamp !== segment.startTimestamp) {
            throw new Error(
              `Transcript segmentId ${ref.segmentId} must use timestamp ${segment.startTimestamp}`,
            );
          }
        } else {
          const frame = frames.get(ref.frameId);
          if (!frame) {
            throw new Error(
              `Unknown screen frameId ${ref.frameId}; valid IDs: ${[
                ...frames.keys(),
              ].join(", ")}`,
            );
          }
          if (ref.timestamp !== frame.timestamp) {
            throw new Error(
              `Screen frameId ${ref.frameId} must use timestamp ${frame.timestamp}`,
            );
          }
        }
      }
    }
  }

  private workspaceDir(caseId: string): string {
    return path.join(this.config.dataDir, sanitizePathPart(caseId));
  }

  private workspacePath(caseId: string): string {
    return path.join(this.workspaceDir(caseId), "workspace.json");
  }

  private sourcesPath(caseId: string): string {
    return path.join(this.workspaceDir(caseId), "sources.json");
  }

  private revisionPath(caseId: string, revisionId: string): string {
    return path.join(
      this.workspaceDir(caseId),
      "revisions",
      `${sanitizePathPart(revisionId)}.json`,
    );
  }

  private generationPath(caseId: string): string {
    return path.join(this.workspaceDir(caseId), "generation.ndjson");
  }

  private saveWorkspace(workspace: CaseWorkspace): Promise<void> {
    return atomicWriteJson(this.workspacePath(workspace.caseId), workspace);
  }

  private async readRevision(caseId: string, revisionId: string) {
    return readJson<CaseRevision>(this.revisionPath(caseId, revisionId));
  }

  private async logAttempt(caseId: string, entry: unknown): Promise<void> {
    const filePath = this.generationPath(caseId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
  }
}
