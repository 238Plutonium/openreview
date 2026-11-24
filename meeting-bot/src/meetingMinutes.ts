import {
  copyFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  AiScreenShareFrame,
  AsrSegment,
  MeetingQaPair,
} from "./meetingAi.js";

export type MeetingMinutesConfig = {
  enabled: boolean;
  available: boolean;
  unavailableReasons: string[];
  dataDir: string;
  textBaseUrl: string;
  textModel: string;
  textApiKey: string;
  textEnableThinking: boolean;
  maxTranscriptChars: number;
  summaryMaxTokens: number;
  maxSlides: number;
  maxQaPairs: number;
  llmTimeoutMs: number;
};

export type MeetingMinutesSource = {
  streamId: string;
  meetingUuid: string | null;
  segments: AsrSegment[];
  screenShareFrames: AiScreenShareFrame[];
  qaPairs: MeetingQaPair[];
};

export type MeetingMinutesSessionClosedInput = {
  streamId: string;
  meetingUuid: string | null;
  startedAt?: string | null;
  closedAt?: string | null;
  reason?: string;
};

export type MeetingMinutesSlide = {
  index: number;
  uniqueFrameId: number;
  frameId: number;
  timestamp: number;
  receivedAt: string;
  sourcePath: string;
  fileName: string;
  filePath: string;
  userId: number | null;
  userName: string | null;
};

export type MeetingMinutesManifest = {
  schemaVersion: 1;
  streamId: string;
  meetingUuid: string | null;
  generatedAt: string;
  meetingStartedAt: string | null;
  meetingEndedAt: string | null;
  closeReason: string | null;
  outputDir: string;
  files: {
    manifest: string;
    summaryMarkdown: string;
    qaPairsJson: string;
    transcriptText: string;
    slidesManifestJson: string;
    slidesDir: string;
  };
  transcript: {
    segmentCount: number;
    charsIncludedInPrompt: number;
    truncatedForPrompt: boolean;
  };
  qaPairs: {
    count: number;
    includedInPrompt: number;
  };
  summary: {
    text: string;
    generatedBy: "llm" | "fallback";
    model: string | null;
    warnings: string[];
  };
  slides: {
    count: number;
    selectedFromFrames: number;
    directory: string;
    items: MeetingMinutesSlide[];
    warnings: string[];
  };
};

export type MeetingMinutesEventEmitter = (type: string, payload?: unknown) => void;
export type MeetingMinutesSourceProvider = (
  streamId: string,
) => Promise<MeetingMinutesSource | null> | MeetingMinutesSource | null;

type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
    text?: string;
  }>;
  error?: { message?: string } | string;
};

export type MeetingMinutesTextModel = {
  summarize(messages: LlmMessage[], maxTokens: number): Promise<string>;
};

function sanitizePathPart(value: unknown): string {
  const text = String(value ?? "unknown").trim();
  const safe = text.replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe || "unknown";
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+/gu, " ")
    .replace(/[ \t]*\n[ \t]*/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function stripThinking(value: string): string {
  let text = value.replace(/<think>[\s\S]*?<\/think>/giu, "").trim();
  const orphanThinkClose = text.toLowerCase().lastIndexOf("</think>");
  if (orphanThinkClose >= 0) {
    text = text.slice(orphanThinkClose + "</think>".length).trim();
  }
  return normalizeText(text);
}

function timestampLabel(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "unknown-time";
  }
  return new Date(value).toISOString();
}

function transcriptLine(segment: AsrSegment): string {
  const speaker = segment.userName || `user-${segment.userId ?? "unknown"}`;
  return `[${timestampLabel(segment.startTimestamp)}] ${speaker}: ${segment.text}`;
}

function qaLine(pair: MeetingQaPair, index: number): string {
  const asker = pair.senderName ? ` from ${pair.senderName}` : "";
  return [
    `Q${index + 1}${asker}: ${pair.question}`,
    `A${index + 1}: ${pair.answer}`,
  ].join("\n");
}

function clipMiddle(value: string, maxChars: number): {
  text: string;
  truncated: boolean;
} {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }

  const marker = "\n\n[... transcript omitted because it exceeded the meeting minutes prompt limit ...]\n\n";
  const headChars = Math.max(0, Math.floor((maxChars - marker.length) * 0.45));
  const tailChars = Math.max(0, maxChars - marker.length - headChars);
  return {
    text: `${value.slice(0, headChars).trimEnd()}${marker}${value.slice(-tailChars).trimStart()}`,
    truncated: true,
  };
}

function selectFrames(
  frames: AiScreenShareFrame[],
  maxSlides: number,
): AiScreenShareFrame[] {
  if (maxSlides <= 0 || frames.length === 0) {
    return [];
  }

  const deduped = Array.from(
    new Map(
      frames
        .filter((frame) => frame.filePath && frame.fileName)
        .sort((left, right) => left.timestamp - right.timestamp)
        .map((frame) => [frame.filePath, frame] as const),
    ).values(),
  );

  if (deduped.length <= maxSlides) {
    return deduped;
  }

  if (maxSlides === 1) {
    return [deduped.at(-1) as AiScreenShareFrame];
  }

  const selected: AiScreenShareFrame[] = [];
  const usedIndexes = new Set<number>();
  for (let index = 0; index < maxSlides; index += 1) {
    const sourceIndex = Math.round((index * (deduped.length - 1)) / (maxSlides - 1));
    if (!usedIndexes.has(sourceIndex)) {
      selected.push(deduped[sourceIndex] as AiScreenShareFrame);
      usedIndexes.add(sourceIndex);
    }
  }
  return selected;
}

function imageExtensionFor(frame: AiScreenShareFrame): string | null {
  const codec = frame.codec.trim().toUpperCase();
  if (codec === "PNG") {
    return ".png";
  }
  if (codec === "JPG" || codec === "JPEG") {
    return ".jpg";
  }

  const fileName = frame.fileName;
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".png" || extension === ".jpg" || extension === ".jpeg") {
    return extension;
  }
  return null;
}

function renderSummaryMarkdown(input: {
  manifest: MeetingMinutesManifest;
  qaPairs: MeetingQaPair[];
}): string {
  const qaSection =
    input.qaPairs.length > 0
      ? input.qaPairs
          .map(
            (pair, index) =>
              `${index + 1}. Q: ${pair.question}\n\n   A: ${pair.answer}`,
          )
          .join("\n\n")
      : "No human-machine QA pairs were recorded.";

  return [
    "# Meeting Minutes",
    "",
    `- Stream ID: ${input.manifest.streamId}`,
    `- Meeting UUID: ${input.manifest.meetingUuid ?? "unknown"}`,
    `- Generated at: ${input.manifest.generatedAt}`,
    `- Meeting started: ${input.manifest.meetingStartedAt ?? "unknown"}`,
    `- Meeting ended: ${input.manifest.meetingEndedAt ?? "unknown"}`,
    `- Transcript segments: ${input.manifest.transcript.segmentCount}`,
    `- Slides copied: ${input.manifest.slides.count}`,
    "",
    "## Summary",
    "",
    input.manifest.summary.text,
    "",
    "## QA Pairs",
    "",
    qaSection,
    "",
    "## Slides",
    "",
    input.manifest.slides.count > 0
      ? `Slides were copied to: ${input.manifest.slides.directory}`
      : "No screen share images were captured.",
    "",
  ].join("\n");
}

function fallbackSummary(source: MeetingMinutesSource): string {
  if (source.segments.length === 0) {
    return "No ASR transcript was captured for this meeting.";
  }

  const speakers = Array.from(
    new Set(
      source.segments
        .map((segment) => segment.userName || `user-${segment.userId ?? "unknown"}`)
        .filter(Boolean),
    ),
  );
  const firstLines = source.segments.slice(0, 5).map(transcriptLine).join("\n");
  return normalizeText(
    [
      `ASR captured ${source.segments.length} transcript segment(s).`,
      speakers.length ? `Detected speakers: ${speakers.join(", ")}.` : "",
      firstLines ? `Opening transcript excerpts:\n${firstLines}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
}

class OpenAiCompatibleMinutesModel implements MeetingMinutesTextModel {
  constructor(private readonly config: MeetingMinutesConfig) {}

  async summarize(messages: LlmMessage[], maxTokens: number): Promise<string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.textApiKey) {
      headers.Authorization = `Bearer ${this.config.textApiKey}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.llmTimeoutMs);
    try {
      const response = await fetch(
        `${this.config.textBaseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: this.config.textModel,
            messages,
            temperature: 0.2,
            max_tokens: maxTokens,
            chat_template_kwargs: {
              enable_thinking: this.config.textEnableThinking,
            },
          }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as ChatCompletionResponse;

      if (!response.ok) {
        const message =
          typeof body.error === "string"
            ? body.error
            : body.error?.message || `LLM request failed with HTTP ${response.status}`;
        throw new Error(message);
      }

      const content = body.choices?.[0]?.message?.content ?? body.choices?.[0]?.text ?? "";
      if (!content.trim()) {
        throw new Error("LLM returned an empty meeting summary");
      }
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class MeetingMinutesManager {
  private readonly model: MeetingMinutesTextModel;
  private latestManifest: MeetingMinutesManifest | null = null;

  constructor(
    private readonly config: MeetingMinutesConfig,
    private readonly emit: MeetingMinutesEventEmitter,
    private readonly sourceProvider: MeetingMinutesSourceProvider,
    model?: MeetingMinutesTextModel,
  ) {
    this.model = model ?? new OpenAiCompatibleMinutesModel(config);
  }

  health() {
    return {
      enabled: this.config.enabled,
      available: this.config.available,
      unavailableReasons: this.config.unavailableReasons,
      dataDir: this.config.dataDir,
      textBaseUrl: this.config.textBaseUrl,
      textModel: this.config.textModel,
      maxTranscriptChars: this.config.maxTranscriptChars,
      summaryMaxTokens: this.config.summaryMaxTokens,
      maxSlides: this.config.maxSlides,
      maxQaPairs: this.config.maxQaPairs,
      llmTimeoutMs: this.config.llmTimeoutMs,
      latest: this.latestManifest
        ? {
            streamId: this.latestManifest.streamId,
            generatedAt: this.latestManifest.generatedAt,
            outputDir: this.latestManifest.outputDir,
            summaryGeneratedBy: this.latestManifest.summary.generatedBy,
          }
        : null,
    };
  }

  latest() {
    return this.latestManifest;
  }

  async handleSessionClosed(
    input: MeetingMinutesSessionClosedInput,
  ): Promise<MeetingMinutesManifest | null> {
    if (!this.config.enabled) {
      return null;
    }

    if (!this.config.available) {
      this.emit("meeting-minutes-skipped", {
        streamId: input.streamId,
        reason: "unavailable",
        unavailableReasons: this.config.unavailableReasons,
      });
      return null;
    }

    try {
      return await this.generate(input);
    } catch (error) {
      this.emit("meeting-minutes-error", {
        streamId: input.streamId,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async generate(
    input: MeetingMinutesSessionClosedInput,
  ): Promise<MeetingMinutesManifest> {
    if (!this.config.enabled) {
      throw new Error("Meeting minutes are disabled");
    }

    const source = await this.sourceProvider(input.streamId);
    if (!source) {
      throw new Error(`No meeting source was found for stream ${input.streamId}`);
    }

    const generatedAt = new Date().toISOString();
    const safeStreamId = sanitizePathPart(input.streamId);
    const outputDir = path.resolve(this.config.dataDir, safeStreamId);
    const slidesDir = path.join(outputDir, "slides");
    await mkdir(slidesDir, { recursive: true });

    this.emit("meeting-minutes-generation-started", {
      streamId: input.streamId,
      meetingUuid: input.meetingUuid ?? source.meetingUuid,
      transcriptSegments: source.segments.length,
      qaPairs: source.qaPairs.length,
      screenShareFrames: source.screenShareFrames.length,
      outputDir,
    });

    const transcriptText = source.segments.map(transcriptLine).join("\n");
    const clippedTranscript = clipMiddle(
      transcriptText,
      this.config.maxTranscriptChars,
    );
    const qaPairs = source.qaPairs.slice(-this.config.maxQaPairs);
    const summaryResult = await this.generateSummary(
      source,
      clippedTranscript.text,
      clippedTranscript.truncated,
      qaPairs,
    );
    const slideResult = await this.copySlides(source.screenShareFrames, slidesDir);

    const manifestPath = path.join(outputDir, "meeting_minutes.json");
    const summaryMarkdownPath = path.join(outputDir, "summary.md");
    const qaPairsPath = path.join(outputDir, "qa_pairs.json");
    const transcriptPath = path.join(outputDir, "transcript.txt");
    const slidesManifestPath = path.join(outputDir, "slides_manifest.json");

    const manifest: MeetingMinutesManifest = {
      schemaVersion: 1,
      streamId: input.streamId,
      meetingUuid: input.meetingUuid ?? source.meetingUuid,
      generatedAt,
      meetingStartedAt: input.startedAt ?? null,
      meetingEndedAt: input.closedAt ?? null,
      closeReason: input.reason ?? null,
      outputDir,
      files: {
        manifest: manifestPath,
        summaryMarkdown: summaryMarkdownPath,
        qaPairsJson: qaPairsPath,
        transcriptText: transcriptPath,
        slidesManifestJson: slidesManifestPath,
        slidesDir,
      },
      transcript: {
        segmentCount: source.segments.length,
        charsIncludedInPrompt: clippedTranscript.text.length,
        truncatedForPrompt: clippedTranscript.truncated,
      },
      qaPairs: {
        count: source.qaPairs.length,
        includedInPrompt: qaPairs.length,
      },
      summary: summaryResult,
      slides: {
        count: slideResult.items.length,
        selectedFromFrames: source.screenShareFrames.length,
        directory: slidesDir,
        items: slideResult.items,
        warnings: slideResult.warnings,
      },
    };

    await writeFile(transcriptPath, transcriptText, "utf8");
    await writeFile(qaPairsPath, `${JSON.stringify(source.qaPairs, null, 2)}\n`, "utf8");
    await writeFile(
      slidesManifestPath,
      `${JSON.stringify({
        streamId: input.streamId,
        generatedAt,
        slides: slideResult.items,
        warnings: slideResult.warnings,
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      summaryMarkdownPath,
      renderSummaryMarkdown({ manifest, qaPairs }),
      "utf8",
    );
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    this.latestManifest = manifest;
    this.emit("meeting-minutes-generation-completed", {
      streamId: input.streamId,
      outputDir,
      manifestPath,
      summaryGeneratedBy: manifest.summary.generatedBy,
      qaPairs: source.qaPairs.length,
      slides: slideResult.items.length,
    });

    return manifest;
  }

  private async generateSummary(
    source: MeetingMinutesSource,
    transcriptText: string,
    transcriptTruncated: boolean,
    qaPairs: MeetingQaPair[],
  ): Promise<MeetingMinutesManifest["summary"]> {
    const warnings: string[] = [];
    if (transcriptTruncated) {
      warnings.push("Transcript was truncated before being sent to the summary LLM.");
    }

    if (!transcriptText.trim()) {
      return {
        text: fallbackSummary(source),
        generatedBy: "fallback",
        model: null,
        warnings: ["No ASR transcript was available for LLM summarization."],
      };
    }

    try {
      const summary = await this.model.summarize([
        {
          role: "system",
          content: [
            "You generate concise, human-readable meeting minutes from ASR transcript text.",
            "Ground every statement in the transcript or supplied human-machine QA pairs.",
            "Do not invent decisions, names, action items, or facts.",
            "Use clear markdown with these sections when supported by evidence: Overview, Key Topics, Decisions, Action Items, Open Questions, Human-Machine QA.",
            "If a section has no evidence, write 'Not captured'.",
          ].join(" "),
        },
        {
          role: "user",
          content: [
            "ASR transcript:",
            transcriptText,
            "",
            qaPairs.length
              ? `Human-machine QA pairs:\n${qaPairs.map(qaLine).join("\n\n")}`
              : "Human-machine QA pairs:\nNone recorded.",
          ].join("\n"),
        },
      ], this.config.summaryMaxTokens);

      return {
        text: stripThinking(summary),
        generatedBy: "llm",
        model: this.config.textModel,
        warnings,
      };
    } catch (error) {
      warnings.push(
        `LLM summary failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        text: fallbackSummary(source),
        generatedBy: "fallback",
        model: null,
        warnings,
      };
    }
  }

  private async copySlides(
    frames: AiScreenShareFrame[],
    slidesDir: string,
  ): Promise<{ items: MeetingMinutesSlide[]; warnings: string[] }> {
    const selected = selectFrames(frames, this.config.maxSlides);
    const items: MeetingMinutesSlide[] = [];
    const warnings: string[] = [];

    for (const [index, frame] of selected.entries()) {
      const extension = imageExtensionFor(frame);
      if (!extension) {
        warnings.push(
          `Skipped non-image screen share frame ${frame.filePath} with codec ${frame.codec}.`,
        );
        continue;
      }
      const fileName = `slide_${String(index + 1).padStart(4, "0")}_frame_${String(frame.uniqueFrameId).padStart(6, "0")}${extension}`;
      const filePath = path.join(slidesDir, fileName);
      try {
        await readFile(frame.filePath);
        await copyFile(frame.filePath, filePath);
        items.push({
          index: index + 1,
          uniqueFrameId: frame.uniqueFrameId,
          frameId: frame.frameId,
          timestamp: frame.timestamp,
          receivedAt: frame.receivedAt,
          sourcePath: frame.filePath,
          fileName,
          filePath,
          userId: frame.userId,
          userName: frame.userName,
        });
      } catch (error) {
        warnings.push(
          `Could not copy screen share frame ${frame.filePath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return { items, warnings };
  }
}
