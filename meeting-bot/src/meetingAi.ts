import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  VoiceInvocationManager,
  type VoiceTranscriptBoundary,
} from "./voiceInvocation.js";
import type {
  MeetingRetrievalInput,
  MeetingRetrievalResult,
  RetrievalRecord,
} from "./retrieval.js";
import { looksLikeClinicalQuestion } from "./retrieval.js";
export type MeetingAiConfig = {
  enabled: boolean;
  dataDir: string;
  asrEnabled: boolean;
  asrServiceUrl: string;
  asrChunkSeconds: number;
  asrOverlapSeconds: number;
  asrSpeechRmsThreshold: number;
  asrSpeechPrerollMs: number;
  vlmBaseUrl: string;
  vlmModel: string;
  vlmApiKey: string;
  vlmMaxTokens: number;
  ragVlmMaxTokens: number;
  vlmEnableThinking: boolean;
  vlmMultimodal: boolean;
  answerLlmEnabled: boolean;
  answerLlmBaseUrl: string;
  answerLlmModel: string;
  answerLlmApiKey: string;
  answerLlmMaxTokens: number;
  answerLlmMaxChars: number;
  ragAnswerLlmMaxTokens: number;
  ragAnswerLlmMaxChars: number;
  literatureAnswerMaxTokens: number;
  literatureAnswerMaxChars: number;
  /** concise = demo-feedback short Zoom bubbles; standard = longer educational replies */
  answerStyle: "concise" | "standard";
  answerLlmEnableThinking: boolean;
  botName?: string;
  contextMode: string;
  screenShareEnabled: boolean;
  screenShareMaxImages: number;
  screenShareMemoryLimit: number;
  screenShareMaxImageBytes: number;
  /** When true (default), visual asks with zero frames return a fixed unavailable reply and skip the drafting MLLM. */
  noFrameFixedReply: boolean;
  /** Experiment-only switch; omitted/true preserves normal speech-frame withholding. */
  speechRecallWithholdFrames?: boolean;
  /** When true, only allowlisted askers (or host names) get answers; others get a short deferral. */
  facilitatorOnly?: boolean;
  /** Comma-separated display-name allowlist used when facilitatorOnly is true. */
  allowedAskers?: string[];
  fullContextMaxChars: number;
  recentContextMaxChars: number;
  relevantContextMaxChars: number;
  summaryUpdateSeconds: number;
  summaryUpdateChars: number;
  asrIdleFlushMs: number;
  voiceInvocationEnabled: boolean;
  voiceInvocationAvailable: boolean;
  voiceInvocationUnavailableReasons: string[];
  voiceWakePhrases: string[];
  voiceFollowupTimeoutMs: number;
  voiceMaxQuestionMs: number;
  voiceMaxQuestionChars: number;
  voiceCooldownMs: number;
};

export type AiEventEmitter = (type: string, payload?: unknown) => void;

export type RtmsAudioChunk = {
  streamId: string;
  meetingUuid: string | null;
  userId: number | null;
  userName: string | null;
  timestamp: number;
  receivedAt: string;
  size: number;
  buffer: Buffer;
};

export type AiChatReplyTarget = {
  messageId?: string;
  messageIdAttribute?: "data-message-id" | "data-id" | "id";
  senderName: string;
  receiverName: string;
  privateToBot: boolean;
  message: string;
  timeText: string;
  occurrence: number;
};

export type AiQuestion = {
  question: string;
  streamId?: string;
  senderUserId?: number;
  senderName?: string;
  replyToUserId?: number;
  replyToMessage?: AiChatReplyTarget;
  replyType?: "private" | "public-mention" | "voice-public" | "manual";
  /** Set false by /ai/ask. The request body cannot turn the institutional index on. */
  allowPrivateIndex?: boolean;
  askedAt?: number;
  contextCutoffAt?: number;
  trigger?: unknown;
};

/** Format Zoom chat delivery.
 * - Text nested replies: raw answer body (thread UI carries context)
 * - Voice public: @asker so they get a notification in Everyone chat
 * - Fallback soft-quote only when no nested reply target is available
 */
export function formatZoomChatReply(
  answer: string,
  question: AiQuestion,
  botName = DEFAULT_BOT_NAME,
): string {
  const body = normalizeMultilineText(answer);
  if (!body) {
    return body;
  }
  if (
    question.replyType === "private" ||
    question.replyType === "manual" ||
    question.replyToMessage
  ) {
    return body;
  }

  const asker = (question.senderName ?? "participant").trim() || "participant";

  // Audio / voice prompts: ping the asker so they get a Zoom @ notification.
  if (question.replyType === "voice-public") {
    return `@${asker}\n\n${body}`;
  }

  const rawQuestion = normalizeText(question.question);
  const mention = botName.trim() || DEFAULT_BOT_NAME;
  const stripped = rawQuestion
    .replace(new RegExp(`@?${escapeRegExp(mention)}`, "giu"), " ")
    .replace(/\s+/gu, " ")
    .trim();
  const snippet =
    stripped.length > 120 ? `${stripped.slice(0, 117).trimEnd()}...` : stripped;
  if (!snippet) {
    return body;
  }
  return `Re @${asker}: "${snippet}"\n\n${body}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export type AsrSegment = {
  id: number;
  streamId: string;
  meetingUuid: string | null;
  userId: number | null;
  userName: string | null;
  startTimestamp: number;
  endTimestamp: number;
  text: string;
  language: string | null;
  durationSeconds: number;
  createdAt: string;
};

export type AiScreenShareFrame = {
  streamId: string;
  meetingUuid: string | null;
  frameId: number;
  uniqueFrameId: number;
  fileName: string;
  filePath: string;
  timestamp: number;
  receivedAt: string;
  size: number;
  codec: string;
  resolution: string;
  fps: number;
  diffFromPreviousUnique: number | null;
  userId: number | null;
  userName: string | null;
  startTs: number | null;
  endTs: number | null;
};

export type MeetingQaPair = {
  question: string;
  answer: string;
  askedAt: number | null;
  answeredAt: string | null;
  senderUserId?: number;
  senderName?: string;
  replyType?: AiQuestion["replyType"];
  streamId?: string;
  contextChars?: number;
  models?: {
    vlm?: string;
    answer?: string;
  };
  screenShareFramesUsed?: Array<{
    uniqueFrameId: number;
    frameId: number;
    timestamp: number;
    filePath: string;
  }>;
  retrieval?: unknown;
};

type AudioFrame = {
  buffer: Buffer;
  timestamp: number;
  receivedAt: string;
  size: number;
  durationSeconds: number;
};

type AsrBufferState = {
  streamId: string;
  meetingUuid: string | null;
  userKey: string;
  userId: number | null;
  userName: string | null;
  pending: AudioFrame[];
  overlap: AudioFrame[];
  preRoll: AudioFrame[];
  pendingSeconds: number;
  preRollSeconds: number;
  speechActive: boolean;
  lastRms: number;
  inFlight: boolean;
  inFlightPromise: Promise<void> | null;
  pendingBoundary: VoiceTranscriptBoundary | null;
  idleTimer: NodeJS.Timeout | null;
  lastText: string;
  submittedSegments: number;
};

type MeetingMemory = {
  streamId: string;
  meetingUuid: string | null;
  segments: AsrSegment[];
  screenShareFrames: AiScreenShareFrame[];
  summary: string;
  summaryInFlight: boolean;
  summaryUpdatedAt: string | null;
  summaryCharsSinceUpdate: number;
  lastSummaryAttemptAt: number;
};

type QuestionFocus = "speech" | "visual" | "general";

type SendChat = (
  message: string,
  userId?: number,
  replyTarget?: AiChatReplyTarget,
) => Promise<unknown>;

export type MeetingEvidenceRetriever = {
  retrieveForMeeting(input: MeetingRetrievalInput): Promise<MeetingRetrievalResult>;
};

type AsrResponse = {
  text?: string;
  language?: string;
  durationSeconds?: number;
  inferenceSeconds?: number;
  segments?: Array<{ text?: string }>;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
    text?: string;
  }>;
};

type LlmMessageContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;

type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: LlmMessageContent;
};

type LlmClientConfig = {
  baseUrl: string;
  model: string;
  apiKey: string;
  enableThinking: boolean;
};

const PCM_BYTES_PER_SECOND = 16_000 * 2;

export function pcm16Rms(buffer: Buffer): number {
  const sampleCount = Math.floor(buffer.length / 2);
  if (sampleCount === 0) {
    return 0;
  }

  let sumSquares = 0;
  for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
    const sample = buffer.readInt16LE(offset);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

function sanitizePathPart(value: unknown): string {
  const text = String(value ?? "unknown").trim();
  const safe = text.replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe || "unknown";
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeMultilineText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+/gu, " ")
    .replace(/[ \t]*\n[ \t]*/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function compactForCompare(value: string): string {
  return normalizeText(value).toLowerCase();
}

function isoFromTimestamp(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "";
  }

  return new Date(timestamp).toISOString();
}

function transcriptLine(segment: AsrSegment): string {
  const time = isoFromTimestamp(segment.startTimestamp) || segment.createdAt;
  const speaker = segment.userName || `user-${segment.userId ?? "unknown"}`;
  return `[${time}] ${speaker}: ${segment.text}`;
}

function takeTailChars(lines: string[], maxChars: number): string {
  const selected: string[] = [];
  let used = 0;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    const cost = line.length + 1;
    if (selected.length > 0 && used + cost > maxChars) {
      break;
    }
    selected.unshift(line);
    used += cost;
  }

  return selected.join("\n");
}

function keywords(question: string): string[] {
  const matches = question.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  return Array.from(new Set(matches)).slice(0, 12);
}

// Chat questions are typed fast and full of typos ("what did i jus tsay"), so
// intent is matched against the question with separators stripped.
function compactQuestion(question: string): string {
  return question.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

const SPEECH_QUESTION_MARKERS = [
  "say",
  "said",
  "hear",
  "heard",
  "speak",
  "spoke",
  "spoken",
  "talk",
  "discuss",
  "mention",
  "repeat",
  "说",
  "讲",
  "聊",
  "提到",
  "听",
];

const VISUAL_QUESTION_MARKERS = [
  "slide",
  "screen",
  "image",
  "picture",
  "photo",
  "diagram",
  "figure",
  "chart",
  "shown",
  "display",
  "thepage",
  "thispage",
  "mypage",
  "readpage",
  "幻灯",
  "屏幕",
  "画面",
  "图",
];

// "What did he say?" asks about spoken words, so slide text must not be quoted
// back as speech. "What does my slide say?" asks about on-screen text, so the
// shared screen must stay available. Adjacent slide/screen + say/show/read
// phrases are visual; other speech markers still win when both appear.
const SPEECH_WORD =
  /\b(?:say|said|says|saying|hear|heard|hearing|speak|spoke|spoken|speaking|talk|talks|talked|talking|discuss|discussed|discussing|mention|mentioned|mentioning|repeat|repeated|repeating)\b/iu;
const VISUAL_WORD =
  /\b(?:slides?|screens?|images?|pictures?|photos?|diagrams?|figures?|charts?|shown|display(?:ed|ing)?|pages?)\b/iu;
const SCREEN_SAYS =
  /\b(?:slides?|screens?|images?|pictures?|photos?|diagrams?|figures?|charts?|pages?|幻灯片?|屏幕|画面)\b(?:\s+\S+){0,3}\s+\b(?:says?|said|show[sn]?|shown|tells?|reads?)\b/iu;
const READS_SCREEN =
  /\b(?:says?|said|show[sn]?|shown|tells?|reads?)\b(?:\s+(?:on|in|from|the|my|this|a)){0,4}\s+\b(?:slides?|screens?|images?|pictures?|photos?|diagrams?|figures?|charts?|pages?|幻灯片?|屏幕|画面)\b/iu;

export function privateIndexAllowed(question: {
  replyType?: AiQuestion["replyType"];
  allowPrivateIndex?: boolean;
}): boolean {
  return question.allowPrivateIndex !== false && question.replyType !== "manual";
}

export function questionFocus(question: string): QuestionFocus {
  const hasSpeech =
    SPEECH_WORD.test(question) ||
    SPEECH_QUESTION_MARKERS.some(
      (marker) => marker.codePointAt(0)! > 127 && question.includes(marker),
    );
  const hasVisual =
    VISUAL_WORD.test(question) ||
    VISUAL_QUESTION_MARKERS.some(
      (marker) => marker.codePointAt(0)! > 127 && question.includes(marker),
    );

  const asksWhatScreenSays =
    SCREEN_SAYS.test(question) || READS_SCREEN.test(question);

  if (hasVisual && asksWhatScreenSays) {
    return "visual";
  }

  if (hasSpeech) {
    return "speech";
  }

  if (hasVisual) {
    return "visual";
  }

  return "general";
}

// "Who are you?" / "what can you do?" never need the shared slide. Attaching a
// screen frame to a long transcript is a common VLM HTTP 400 on this host.
export function looksLikeSelfIdentityQuestion(question: string): boolean {
  const compact = compactQuestion(question);
  return (
    /(?:whoareyou|whoareu|whoareya|whoisthis|whoisthat|introduceyourself|tellmeaboutyourself|whatcanyoudo|whatdoyoudo|whatareyou|whatsyourname|whatisyourname|areyouecho)/u.test(
      compact,
    ) || /(你是谁|介绍一下你自己|你能做什么|你叫什么)/u.test(question)
  );
}

const DEFAULT_BOT_NAME = "ECHO AI Assistant";
const VLM_CONTEXT_CHARS_WITH_IMAGE = 2_500;
const VLM_CONTEXT_CHARS_TEXT_ONLY = 4_500;
const VLM_EVIDENCE_CHARS_WITH_IMAGE = 1_200;
const VLM_EVIDENCE_CHARS_TEXT_ONLY = 2_000;

export function selfIdentityAnswer(
  question: string,
  botName = DEFAULT_BOT_NAME,
): string {
  const name = botName.trim() || DEFAULT_BOT_NAME;
  if (looksChinese(question)) {
    return `我是${name}，这个 Zoom 会议里的 AI 助手。我会听取发言、阅读共享屏幕，并根据当前会议内容和已有的 ECHO 资料回答问题。我是教学辅助，不能代替临床判断。`;
  }
  return `I am ${name}, the AI assistant in this Zoom meeting. I listen to the discussion, read shared slides, and answer from the live meeting and available ECHO materials. I am an educational helper, not a clinical decision-maker.`;
}

function clipTail(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(value.length - maxChars);
}

function shouldWithholdScreenShare(
  question: string,
  focus: QuestionFocus,
  withholdSpeechFrames = true,
): boolean {
  return (withholdSpeechFrames && focus === "speech") || looksLikeSelfIdentityQuestion(question);
}

export function stripPowerpointPageLabel(answer: string): string {
  return normalizeText(
    answer
      .replace(/\(?\bslides?\s+\d+\s*(?:of|\/)\s*\d+\b\)?/giu, " ")
      .replace(/\s+\./g, ".")
      .replace(/\.{2,}/g, "."),
  );
}

function slideBodyLeftover(answer: string): string {
  return stripPowerpointPageLabel(answer)
    .replace(
      /\b(the|this|it|current|shared|visible|slide|screen|presentation|image|deck|is|shows?|says?|displays?|reads?|features?|contains?|presents?|currently|on|showing|displaying)\b/giu,
      " ",
    )
    .replace(/[.'"!:,()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function looksLikeThinSlideAnswer(answer: string): boolean {
  const text = normalizeText(answer);
  if (slideBodyLeftover(text).length >= 20) {
    return false;
  }
  if (text.length < 40) {
    return true;
  }
  return (
    /\bslides?\s+\d+\s*(?:of|\/)\s*\d+\b/iu.test(text) ||
    /^(the )?(current )?slide( is| shows?| says?)?( \d+( of \d+)?)?\.?$/iu.test(text)
  );
}

export function preferSlideBodyText(answer: string): string {
  const stripped = stripPowerpointPageLabel(answer);
  return slideBodyLeftover(stripped).length >= 20
    ? stripped
    : normalizeText(answer);
}

function unansweredSlideBody(question: string): string {
  return looksChinese(question)
    ? "我能看到共享屏幕，但只读到页码，没有读到幻灯片正文。请把幻灯片画布再共享一次，或先翻到下一页再翻回来。"
    : "I can see the shared screen, but I only caught the page label, not the slide body. Please reshare the slide canvas, or go forward one slide and back.";
}

export function looksLikeDeniedSlideAccess(answer: string): boolean {
  return /\b(don'?t|do not|cannot|can't|no)\b.+\b(access|see|visible|available)\b.+\b(slide|screen|image|content|context)\b/iu.test(
    answer,
  ) || /\bdescribe what'?s on the slide\b/iu.test(answer);
}

function prependUserText(
  content: LlmMessageContent,
  prefix: string,
): LlmMessageContent {
  if (typeof content === "string") {
    return `${prefix}\n\n${content}`;
  }
  const parts = content.map((part) =>
    part.type === "text" ? { ...part, text: `${prefix}\n\n${part.text}` } : part,
  );
  if (!parts.some((part) => part.type === "text")) {
    return [{ type: "text", text: prefix }, ...parts];
  }
  return parts;
}

function trimAnswer(answer: string, maxChars: number): string {
  const text = normalizeText(answer);
  if (text.length <= maxChars) {
    return text;
  }

  return trimAtSentenceBoundary(text, maxChars);
}

/** Hard ceilings for demo-feedback concise Zoom chat (overrides higher env budgets). */
export function conciseAnswerCharCap(
  style: "concise" | "standard",
  kind: "default" | "clinical" | "literature",
  configured: number,
): number {
  if (style !== "concise") {
    return configured;
  }
  const ceiling =
    kind === "literature" ? 900 : kind === "clinical" ? 600 : 450;
  return Math.min(configured, ceiling);
}

function trimAnswerPreservingLineBreaks(answer: string, maxChars: number): string {
  const text = answer
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+/gu, " ")
    .replace(/[ \t]*\n[ \t]*/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (text.length <= maxChars) {
    return text;
  }

  return trimAtSentenceBoundary(text, maxChars);
}

/** Split numbered source footnotes (`[n]: ...`) from the prose body. */
export function splitBodyAndFootnotes(answer: string): {
  body: string;
  footnotes: string;
} {
  const text = answer
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+/gu, " ")
    .replace(/[ \t]*\n[ \t]*/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  const match = text.match(/\n\n(\[\d+\]:[\s\S]*)$/u);
  if (!match || match.index === undefined) {
    return { body: text, footnotes: "" };
  }
  return {
    body: text.slice(0, match.index).trim(),
    footnotes: match[1].trim(),
  };
}

/**
 * Trim Zoom answers without chopping PMID/ECHO footnotes.
 * Matches the website proxy: keep full footnote lines; only shorten prose.
 */
export function trimAnswerPreservingFootnotes(
  answer: string,
  maxChars: number,
): string {
  const { body, footnotes } = splitBodyAndFootnotes(answer);
  if (!footnotes) {
    return trimAnswerPreservingLineBreaks(answer, maxChars);
  }

  const footBlock = footnotes;
  const separator = "\n\n";
  const reserved = footBlock.length + separator.length;
  if (reserved >= maxChars) {
    // Prefer intact sources over prose when the budget is tiny.
    return footBlock.length <= maxChars
      ? footBlock
      : trimAnswerPreservingLineBreaks(footBlock, maxChars);
  }

  const bodyBudget = Math.max(0, maxChars - reserved);
  const trimmedBody = trimAnswerPreservingLineBreaks(body, bodyBudget);
  if (!trimmedBody) {
    return footBlock;
  }
  return `${trimmedBody}${separator}${footBlock}`;
}

// Prefer ending on a sentence (or at least a word) so Zoom chat never shows "underlyi..."
export function trimAtSentenceBoundary(text: string, maxChars: number): string {
  const budget = Math.max(0, maxChars - 3);
  if (budget <= 0) {
    return "...";
  }

  const slice = text.slice(0, budget);
  const sentenceEnd = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("? "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf(".\n"),
    slice.lastIndexOf("?\n"),
    slice.lastIndexOf("!\n"),
  );
  if (sentenceEnd >= Math.floor(budget * 0.55)) {
    return `${slice.slice(0, sentenceEnd + 1).trimEnd()}...`;
  }

  const wordEnd = slice.search(/\s\S*$/u);
  if (wordEnd >= Math.floor(budget * 0.55)) {
    return `${slice.slice(0, wordEnd).trimEnd()}...`;
  }

  return `${slice.trimEnd()}...`;
}

function looksChinese(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value);
}

function cleanFinalAnswer(answer: string, question: string): string {
  let text = answer.trim();
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  const orphanThinkClose = text.toLowerCase().lastIndexOf("</think>");
  if (orphanThinkClose >= 0) {
    text = text.slice(orphanThinkClose + "</think>".length).trim();
  }

  const finalMarker = /(?:final answer|answer|答案|最终答案)\s*[:：]\s*/gi;
  const markerMatches = Array.from(text.matchAll(finalMarker));
  if (markerMatches.length > 0) {
    const last = markerMatches.at(-1);
    const markerEnd = (last?.index ?? 0) + (last?.[0].length ?? 0);
    text = text.slice(markerEnd).trim();
  }

  const startsWithReasoning =
    /^(?:thinking process|reasoning|analysis|思考过程|推理过程)\s*[:：]/i.test(text) ||
    /^\s*(?:\d+\.\s+|\*\*?\s+|[-*]\s+)(?:analy[sz]e|identify|determine|the user|step|检查|分析|判断)/i.test(
      text,
    );
  if (startsWithReasoning && markerMatches.length === 0) {
    return looksChinese(question)
      ? "我目前还没有足够清晰的会议上下文来给出简洁答案。"
      : "I do not have enough clear meeting context to answer concisely yet.";
  }

  const introPatterns = [/(?:^|\n)\s*(?:therefore|so),?\s+/i];
  for (const pattern of introPatterns) {
    const match = text.match(pattern);
    if (match && typeof match.index === "number" && match.index < 240) {
      text = text.slice(match.index + match[0].length).trim();
      break;
    }
  }

  return text;
}

export function allowedEvidenceCitations(record: RetrievalRecord | null): Set<string> {
  const allowed = new Set<string>();
  for (const hit of record?.transcriptChunks ?? []) {
    allowed.add(`[${hit.citationId}]`);
  }
  for (const hit of record?.historicalCases ?? []) {
    allowed.add(`[Case:${hit.caseId}]`);
  }
  for (const hit of record?.literature ?? []) {
    allowed.add(`[PMID:${hit.pmid}]`);
  }
  return allowed;
}

function formatSourceTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "unknown";
  }

  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;

  if (hours > 0) {
    return [
      String(hours),
      String(minutes).padStart(2, "0"),
      String(remainingSeconds).padStart(2, "0"),
    ].join(":");
  }

  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function transcriptSourceLabel(
  hit: NonNullable<RetrievalRecord["transcriptChunks"]>[number],
): string {
  const title = hit.title || path.basename(hit.recordingPath || "recording");
  return [
    hit.cohort,
    title,
    `${formatSourceTime(hit.start)}-${formatSourceTime(hit.end)}`,
  ]
    .filter(Boolean)
    .join(" | ");
}

export function renderEvidenceSourceReferences(
  answer: string,
  record: RetrievalRecord | null,
): string {
  if (!record) {
    return answer;
  }

  const transcriptByCitation = new Map<
    string,
    NonNullable<RetrievalRecord["transcriptChunks"]>[number]
  >(
    (record.transcriptChunks ?? []).map((hit) => [
      `[${hit.citationId}]`,
      hit,
    ]),
  );
  const caseByCitation = new Map<
    string,
    NonNullable<RetrievalRecord["historicalCases"]>[number]
  >(
    (record.historicalCases ?? []).map((hit) => [
      `[Case:${hit.caseId}]`,
      hit,
    ]),
  );
  const literatureByCitation = new Map<
    string,
    NonNullable<RetrievalRecord["literature"]>[number]
  >(
    (record.literature ?? []).map((hit) => [`[PMID:${hit.pmid}]`, hit]),
  );

  if (
    transcriptByCitation.size === 0 &&
    caseByCitation.size === 0 &&
    literatureByCitation.size === 0
  ) {
    return answer;
  }

  const usedSources: Array<{ marker: string; label: string }> = [];
  const markerByCitation = new Map<string, string>();

  const withMarkers = answer.replace(
    /\[(?:ECHO:[^\]\s]+|Case:[^\]\s]+|PMID:\d+)\]/gu,
    (citation) => {
      const existing = markerByCitation.get(citation);
      if (existing) {
        return existing;
      }

      let label: string | null = null;
      const transcriptHit = transcriptByCitation.get(citation);
      if (transcriptHit) {
        label = transcriptSourceLabel(transcriptHit);
      } else {
        const caseHit = caseByCitation.get(citation);
        if (caseHit) {
          const similarity = caseHit.similarities?.[0];
          label = [
            `Case ${caseHit.caseId}`,
            similarity ? similarity.slice(0, 120) : null,
          ]
            .filter(Boolean)
            .join(" | ");
        } else {
          const literatureHit = literatureByCitation.get(citation);
          if (literatureHit) {
            label = [
              `PMID ${literatureHit.pmid}`,
              literatureHit.title || null,
              literatureHit.publicationDate || null,
              literatureHit.publicationTypes?.[0] || null,
            ]
              .filter(Boolean)
              .join(" | ");
          }
        }
      }

      if (!label) {
        return citation;
      }

      const marker = `[${usedSources.length + 1}]`;
      markerByCitation.set(citation, marker);
      usedSources.push({ marker, label });
      return marker;
    },
  );

  if (usedSources.length === 0) {
    return answer;
  }

  // Put each [n] on its own line when several citations are clustered.
  const withSeparatedMarkers = withMarkers.replace(
    /(\[\d+\])(?:\s*,\s*|\s*)(?=\[\d+\])/gu,
    "$1\n",
  );

  const sources = usedSources
    .map((source) => `${source.marker}: ${source.label}`)
    .join("\n\n");
  return `${withSeparatedMarkers.trim()}\n\n${sources}`;
}

function hasRetrievalEvidence(record: RetrievalRecord | null): boolean {
  return Boolean(
    (record?.transcriptChunks?.length ?? 0) > 0 ||
      (record?.historicalCases?.length ?? 0) > 0 ||
      (record?.literature?.length ?? 0) > 0,
  );
}

export const CLINICAL_ZOOM_DISCLAIMER_EN =
  "Educational summary for ECHO discussion; not clinical advice or a medical record.";
export const CLINICAL_ZOOM_DISCLAIMER_ZH =
  "ECHO 教育性摘要，不构成临床建议或病历记录。";

export function clinicalDisclaimerForQuestion(question: string): string {
  return looksChinese(question)
    ? CLINICAL_ZOOM_DISCLAIMER_ZH
    : CLINICAL_ZOOM_DISCLAIMER_EN;
}

export function usesClinicalAnswerMode(
  question: string,
  record: RetrievalRecord | null,
): boolean {
  if (hasRetrievalEvidence(record)) {
    return true;
  }
  if (
    record?.intent === "literature" ||
    record?.intent === "historical-cases" ||
    record?.intent === "both"
  ) {
    return true;
  }
  return looksLikeClinicalQuestion(question);
}

export function appendClinicalDisclaimer(
  answer: string,
  question: string,
): string {
  const disclaimer = clinicalDisclaimerForQuestion(question);
  const trimmed = answer.trim();
  if (!trimmed) {
    return disclaimer;
  }
  if (trimmed.includes(disclaimer)) {
    return trimmed;
  }
  return `${trimmed}\n\n${disclaimer}`;
}

export function enforceEvidenceCitationWhitelist(
  answer: string,
  record: RetrievalRecord | null,
): { answer: string; removed: string[] } {
  const allowed = allowedEvidenceCitations(record);
  const removed: string[] = [];
    const cleaned = answer
    .replace(/\[(Case|PMID|ECHO):([^\]\s]+)\]/giu, (citation, type, id) => {
      const normalizedType = String(type).toLowerCase();
      const canonicalType =
        normalizedType === "case"
          ? "Case"
          : normalizedType === "pmid"
            ? "PMID"
            : "ECHO";
      const canonical = `[${canonicalType}:${id}]`;
      if (allowed.has(canonical)) {
        return canonical;
      }
      removed.push(citation);
      return "";
    })
    .replace(/[ \t]+([,.;:!?])/gu, "$1")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\n[ \t]+/gu, "\n")
    .trim();
  return { answer: cleaned, removed: Array.from(new Set(removed)) };
}

function screenShareMimeType(frame: AiScreenShareFrame): string {
  const codec = frame.codec.trim().toUpperCase();
  if (codec === "PNG" || frame.fileName.toLowerCase().endsWith(".png")) {
    return "image/png";
  }
  return "image/jpeg";
}

function frameLine(frame: AiScreenShareFrame): string {
  const time = isoFromTimestamp(frame.timestamp) || frame.receivedAt;
  const presenter = frame.userName || `user-${frame.userId ?? "unknown"}`;
  return `Frame ${frame.uniqueFrameId} captured at ${time} from ${presenter}: ${frame.fileName}`;
}

function tailFrames(frames: AudioFrame[], seconds: number): AudioFrame[] {
  if (seconds <= 0) {
    return [];
  }

  const selected: AudioFrame[] = [];
  let duration = 0;

  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (!frame) {
      continue;
    }

    selected.unshift(frame);
    duration += frame.durationSeconds;
    if (duration >= seconds) {
      break;
    }
  }

  return selected;
}

function combineFrames(frames: AudioFrame[]): Buffer {
  return Buffer.concat(frames.map((frame) => frame.buffer));
}

export class MeetingAiManager {
  private readonly asrBuffers = new Map<string, AsrBufferState>();
  private readonly memories = new Map<string, MeetingMemory>();
  private readonly voiceInvocation: VoiceInvocationManager;
  private qaChain: Promise<void> = Promise.resolve();
  private segmentId = 0;
  private latestStreamId: string | null = null;
  private evidenceRetriever: MeetingEvidenceRetriever | null = null;

  constructor(
    private readonly config: MeetingAiConfig,
    private readonly emit: AiEventEmitter,
    private readonly sendChat: SendChat,
  ) {
    this.voiceInvocation = new VoiceInvocationManager(
      {
        enabled: config.voiceInvocationEnabled,
        available: config.voiceInvocationAvailable,
        unavailableReasons: config.voiceInvocationUnavailableReasons,
        wakePhrases: config.voiceWakePhrases,
        followupTimeoutMs: config.voiceFollowupTimeoutMs,
        maxQuestionMs: config.voiceMaxQuestionMs,
        maxQuestionChars: config.voiceMaxQuestionChars,
        cooldownMs: config.voiceCooldownMs,
      },
      emit,
      (voiceQuestion) => {
        this.enqueueQuestion({
          question: voiceQuestion.question,
          streamId: voiceQuestion.streamId,
          senderUserId: voiceQuestion.userId ?? undefined,
          senderName: voiceQuestion.userName ?? undefined,
          replyType: "voice-public",
          askedAt: voiceQuestion.questionEndedAt,
          contextCutoffAt: voiceQuestion.wakeStartedAt,
          trigger: {
            type: "voice-invocation",
            wakePhrase: voiceQuestion.wakePhrase,
            wakeStartedAt: voiceQuestion.wakeStartedAt,
            questionEndedAt: voiceQuestion.questionEndedAt,
            meetingUuid: voiceQuestion.meetingUuid,
            rawTranscripts: voiceQuestion.rawTranscripts,
          },
        });
      },
    );
  }

  setEvidenceRetriever(retriever: MeetingEvidenceRetriever): void {
    this.evidenceRetriever = retriever;
  }

  health() {
    return {
      enabled: this.config.enabled,
      dataDir: this.config.dataDir,
      asrEnabled: this.config.asrEnabled,
      asrServiceUrl: this.config.asrServiceUrl,
      asrChunkSeconds: this.config.asrChunkSeconds,
      asrOverlapSeconds: this.config.asrOverlapSeconds,
      asrIdleFlushMs: this.config.asrIdleFlushMs,
      asrSpeechRmsThreshold: this.config.asrSpeechRmsThreshold,
      asrSpeechPrerollMs: this.config.asrSpeechPrerollMs,
      vlmBaseUrl: this.config.vlmBaseUrl,
      vlmModel: this.config.vlmModel,
      vlmMaxTokens: this.config.vlmMaxTokens,
      ragVlmMaxTokens: this.config.ragVlmMaxTokens,
      answerLlmEnabled: this.config.answerLlmEnabled,
      answerLlmBaseUrl: this.config.answerLlmBaseUrl,
      answerLlmModel: this.config.answerLlmModel,
      answerLlmMaxTokens: this.config.answerLlmMaxTokens,
      answerLlmMaxChars: this.config.answerLlmMaxChars,
      ragAnswerLlmMaxTokens: this.config.ragAnswerLlmMaxTokens,
      ragAnswerLlmMaxChars: this.config.ragAnswerLlmMaxChars,
      literatureAnswerMaxTokens: this.config.literatureAnswerMaxTokens,
      literatureAnswerMaxChars: this.config.literatureAnswerMaxChars,
      answerStyle: this.config.answerStyle,
      contextMode: this.config.contextMode,
      screenShareEnabled: this.config.screenShareEnabled,
      screenShareMaxImages: this.config.screenShareMaxImages,
      screenShareMemoryLimit: this.config.screenShareMemoryLimit,
      screenShareMaxImageBytes: this.config.screenShareMaxImageBytes,
      noFrameFixedReply: this.config.noFrameFixedReply,
      speechRecallWithholdFrames: this.config.speechRecallWithholdFrames !== false,
      latestStreamId: this.latestStreamId,
      voiceInvocation: this.voiceInvocation.health(),
      asrBuffers: Array.from(this.asrBuffers.values()).map((buffer) => ({
        streamId: buffer.streamId,
        userId: buffer.userId,
        userName: buffer.userName,
        pendingSeconds: Number(buffer.pendingSeconds.toFixed(3)),
        preRollSeconds: Number(buffer.preRollSeconds.toFixed(3)),
        speechActive: buffer.speechActive,
        lastRms: Number(buffer.lastRms.toFixed(1)),
        inFlight: buffer.inFlight,
        pendingBoundary: buffer.pendingBoundary,
        submittedSegments: buffer.submittedSegments,
      })),
      memories: Array.from(this.memories.values()).map((memory) => ({
        streamId: memory.streamId,
        meetingUuid: memory.meetingUuid,
        segments: memory.segments.length,
        screenShareFrames: memory.screenShareFrames.length,
        latestScreenShareAt: memory.screenShareFrames.at(-1)?.receivedAt ?? null,
        summaryChars: memory.summary.length,
        summaryUpdatedAt: memory.summaryUpdatedAt,
        summaryInFlight: memory.summaryInFlight,
      })),
    };
  }

  async runtimeHealth() {
    const [asr, vlm, answerLlm] = await Promise.all([
      this.checkService(`${this.config.asrServiceUrl.replace(/\/$/, "")}/health`),
      this.checkService(`${this.config.vlmBaseUrl.replace(/\/$/, "")}/models`),
      this.config.answerLlmEnabled
        ? this.checkService(`${this.config.answerLlmBaseUrl.replace(/\/$/, "")}/models`)
        : Promise.resolve({
            ok: true,
            url: `${this.config.answerLlmBaseUrl.replace(/\/$/, "")}/models`,
            body: { skipped: true, reason: "ANSWER_LLM_ENABLED=false" },
          }),
    ]);

    return {
      ...this.health(),
      services: {
        asr,
        vlm,
        answerLlm,
      },
    };
  }

  memory(streamId?: string) {
    const memory = this.memoryFor(streamId);
    if (!memory) {
      return {
        streamId: streamId ?? this.latestStreamId,
        summary: "",
        segments: [],
        screenShareFrames: [],
        totalScreenShareFrames: 0,
      };
    }

    return {
      streamId: memory.streamId,
      meetingUuid: memory.meetingUuid,
      summary: memory.summary,
      summaryUpdatedAt: memory.summaryUpdatedAt,
      segments: memory.segments.slice(-200),
      screenShareFrames: memory.screenShareFrames.slice(-20),
      totalSegments: memory.segments.length,
      totalScreenShareFrames: memory.screenShareFrames.length,
    };
  }

  screens(streamId?: string, limit = 50) {
    const memory = this.memoryFor(streamId);
    if (!memory) {
      return {
        streamId: streamId ?? this.latestStreamId,
        frames: [],
        totalFrames: 0,
      };
    }

    const boundedLimit = Math.max(1, Math.min(limit, 500));
    return {
      streamId: memory.streamId,
      frames: memory.screenShareFrames.slice(-boundedLimit),
      totalFrames: memory.screenShareFrames.length,
    };
  }

  caseSource(streamId: string): {
    streamId: string;
    meetingUuid: string | null;
    segments: AsrSegment[];
    screenShareFrames: AiScreenShareFrame[];
  } | null {
    const memory = this.memories.get(streamId);
    if (!memory) {
      return null;
    }

    return {
      streamId: memory.streamId,
      meetingUuid: memory.meetingUuid,
      segments: memory.segments.map((segment) => ({ ...segment })),
      screenShareFrames: memory.screenShareFrames.map((frame) => ({ ...frame })),
    };
  }

  async qaHistory(streamId: string): Promise<MeetingQaPair[]> {
    const filePath = await this.qaPath(streamId);
    let content = "";
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    }

    return content
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          const question = typeof record.question === "string" ? record.question.trim() : "";
          const answerSource =
            typeof record.finalAnswer === "string"
              ? record.finalAnswer
              : typeof record.answer === "string"
                ? record.answer
                : "";
          const answer = answerSource.trim();
          if (!question || !answer) {
            return [];
          }

          return [
            {
              question,
              answer,
              askedAt:
                typeof record.askedAt === "number" && Number.isFinite(record.askedAt)
                  ? record.askedAt
                  : null,
              answeredAt: typeof record.createdAt === "string" ? record.createdAt : null,
              ...(typeof record.senderUserId === "number"
                ? { senderUserId: record.senderUserId }
                : {}),
              ...(typeof record.senderName === "string"
                ? { senderName: record.senderName }
                : {}),
              ...(typeof record.replyType === "string"
                ? { replyType: record.replyType as AiQuestion["replyType"] }
                : {}),
              ...(typeof record.streamId === "string" ? { streamId: record.streamId } : {}),
              ...(typeof record.contextChars === "number"
                ? { contextChars: record.contextChars }
                : {}),
              models: {
                ...(typeof record.vlmModel === "string" ? { vlm: record.vlmModel } : {}),
                ...(typeof record.answerModel === "string"
                  ? { answer: record.answerModel }
                  : {}),
              },
              screenShareFramesUsed: Array.isArray(record.screenShareFramesUsed)
                ? record.screenShareFramesUsed
                    .map((frame) => frame as Record<string, unknown>)
                    .filter(
                      (frame) =>
                        typeof frame.uniqueFrameId === "number" &&
                        typeof frame.frameId === "number" &&
                        typeof frame.timestamp === "number" &&
                        typeof frame.filePath === "string",
                    )
                    .map((frame) => ({
                      uniqueFrameId: frame.uniqueFrameId as number,
                      frameId: frame.frameId as number,
                      timestamp: frame.timestamp as number,
                      filePath: frame.filePath as string,
                    }))
                : [],
              retrieval: record.retrieval,
            },
          ];
        } catch {
          return [];
        }
      });
  }

  async waitForQaIdle(): Promise<void> {
    await this.qaChain;
  }

  ingestAudioChunk(chunk: RtmsAudioChunk): void {
    if (!this.config.enabled || !this.config.asrEnabled) {
      return;
    }

    this.latestStreamId = chunk.streamId;
    const userKey = sanitizePathPart(chunk.userId ?? chunk.userName ?? "unknown");
    const key = `${chunk.streamId}:${userKey}`;
    const state =
      this.asrBuffers.get(key) ??
      {
        streamId: chunk.streamId,
        meetingUuid: chunk.meetingUuid,
        userKey,
        userId: chunk.userId,
        userName: chunk.userName,
        pending: [],
        overlap: [],
        preRoll: [],
        pendingSeconds: 0,
        preRollSeconds: 0,
        speechActive: false,
        lastRms: 0,
        inFlight: false,
        inFlightPromise: null,
        pendingBoundary: null,
        idleTimer: null,
        lastText: "",
        submittedSegments: 0,
      };

    state.meetingUuid = chunk.meetingUuid;
    state.userId = chunk.userId;
    state.userName = chunk.userName;

    const frame: AudioFrame = {
      buffer: Buffer.from(chunk.buffer),
      timestamp: chunk.timestamp,
      receivedAt: chunk.receivedAt,
      size: chunk.size,
      durationSeconds: chunk.size / PCM_BYTES_PER_SECOND,
    };
    const rms = pcm16Rms(frame.buffer);
    const isSpeech = rms >= this.config.asrSpeechRmsThreshold;
    state.lastRms = rms;

    if (!state.speechActive && !isSpeech) {
      this.appendPreRoll(state, frame);
      this.asrBuffers.set(key, state);
      return;
    }

    if (!state.speechActive) {
      state.speechActive = true;
      state.pending.push(...state.preRoll);
      state.pendingSeconds += state.preRollSeconds;
      state.preRoll = [];
      state.preRollSeconds = 0;
    }

    state.pending.push(frame);
    state.pendingSeconds += frame.durationSeconds;
    this.asrBuffers.set(key, state);

    // RTMS sends audio packets continuously, including near-zero silence. Only
    // voiced packets may extend the endpoint timer; otherwise the old logic
    // never observed a 900 ms "idle" period and voice questions waited through
    // several ASR windows before submission.
    if (isSpeech) {
      this.scheduleIdleFlush(state);
    }

    if (state.pendingSeconds >= this.config.asrChunkSeconds) {
      void this.submitAsr(state, false, "max-window");
    }
  }

  ingestScreenShareFrame(frame: AiScreenShareFrame): void {
    if (!this.config.enabled || !this.config.screenShareEnabled) {
      return;
    }

    const memory = this.ensureMemory(frame.streamId, frame.meetingUuid);
    memory.screenShareFrames.push(frame);
    if (memory.screenShareFrames.length > this.config.screenShareMemoryLimit) {
      memory.screenShareFrames.splice(
        0,
        memory.screenShareFrames.length - this.config.screenShareMemoryLimit,
      );
    }
    this.latestStreamId = frame.streamId;
  }

  /** Inject a transcript segment without live ASR (synthetic media replay). */
  async ingestAsrSegment(segment: AsrSegment): Promise<void> {
    if (!this.config.enabled) {
      return;
    }
    await this.addAsrSegment(segment);
  }

  /** Drop in-memory frames/segments for a stream (replay reset). */
  clearMemory(streamId: string): boolean {
    const existed = this.memories.delete(streamId);
    if (this.latestStreamId === streamId) {
      this.latestStreamId = Array.from(this.memories.keys()).at(-1) ?? "";
    }
    return existed;
  }

  async flushStream(streamId: string): Promise<void> {
    const states = Array.from(this.asrBuffers.values()).filter(
      (state) => state.streamId === streamId,
    );

    await Promise.all(states.map((state) => this.drainAsrState(state, "stream-flush")));
    this.voiceInvocation.closeStream(streamId);
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      Array.from(this.asrBuffers.values()).map((state) =>
        this.drainAsrState(state, "stream-flush"),
      ),
    );
    this.voiceInvocation.shutdown();
  }

  enqueueQuestion(question: AiQuestion): void {
    if (!this.config.enabled) {
      this.emit("qa-ignored", { reason: "AI is disabled", question: question.question });
      return;
    }

    this.emit("qa-received", {
      question: question.question,
      streamId: question.streamId ?? this.latestStreamId,
      senderUserId: question.senderUserId,
      senderName: question.senderName,
      replyType: question.replyType,
    });

    this.qaChain = this.qaChain
      .then(async () => {
        await this.answerAndSend(question);
      })
      .catch((error) => {
        this.emit("qa-error", {
          question: question.question,
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  async ask(question: AiQuestion): Promise<{
    answer: string;
    vlmRawAnswer: string;
    finalAnswer: string;
    vlmModel: string;
    answerModel: string;
    streamId: string | null;
    context: string;
    screenShareFramesUsed: AiScreenShareFrame[];
    retrievalRecord: RetrievalRecord | null;
  }> {
    const streamId = question.streamId ?? this.latestStreamId;
    if (looksLikeSelfIdentityQuestion(question.question)) {
      const answer = selfIdentityAnswer(
        question.question,
        this.config.botName,
      );
      this.emit("qa-identity-answered", {
        streamId,
        question: question.question,
        answer,
      });
      return {
        answer,
        vlmRawAnswer: answer,
        finalAnswer: answer,
        vlmModel: this.config.vlmModel,
        answerModel: "identity-template",
        streamId,
        context: "",
        screenShareFramesUsed: [],
        retrievalRecord: null,
      };
    }
    if (this.config.facilitatorOnly) {
      const allow = (this.config.allowedAskers ?? [])
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const asker = (question.senderName ?? "").trim().toLowerCase();
      const ok =
        allow.length === 0
          ? false
          : allow.some((name) => asker === name || asker.includes(name));
      if (!ok) {
        const answer =
          "Please ask the session facilitator to invoke ECHO-AI (host/allowlist mode is on).";
        this.emit("qa-facilitator-only-deferred", {
          streamId,
          senderName: question.senderName,
          question: question.question,
        });
        return {
          answer,
          vlmRawAnswer: answer,
          finalAnswer: answer,
          vlmModel: this.config.vlmModel,
          answerModel: "facilitator-only-gate",
          streamId,
          context: "",
          screenShareFramesUsed: [],
          retrievalRecord: null,
        };
      }
    }
    const context = this.buildContext(
      streamId,
      question.question,
      question.contextCutoffAt,
    );
    const askedAt = question.askedAt ?? Date.now();
    const focus = questionFocus(question.question);
    const availableScreenShareFrames = this.screenShareFramesForQuestion(streamId, askedAt);
    const candidateScreenShareFrames = shouldWithholdScreenShare(
      question.question,
      focus,
      this.config.speechRecallWithholdFrames !== false,
    )
      ? []
      : availableScreenShareFrames;
    const retrievalStartedAt = Date.now();
    const retrieval = this.evidenceRetriever
      ? await this.evidenceRetriever.retrieveForMeeting({
          question: question.question,
          context,
          streamId: streamId ?? undefined,
          senderUserId: question.senderUserId,
          senderName: question.senderName,
          allowPrivateIndex: privateIndexAllowed(question),
        })
      : { record: null, evidencePacket: "" };
    const allowedCitations = Array.from(
      allowedEvidenceCitations(retrieval.record),
    );

    this.emit("qa-context-built", {
      streamId,
      question: question.question,
      contextChars: context.length,
      retrievalMs: Date.now() - retrievalStartedAt,
      retrievalStatus: retrieval.record?.status ?? null,
    });

    this.emit("qa-vision-context-built", {
      streamId,
      question: question.question,
      focus,
      frameCount: candidateScreenShareFrames.length,
      framesWithheld: availableScreenShareFrames.length - candidateScreenShareFrames.length,
      frames: candidateScreenShareFrames.map((frame) => ({
        uniqueFrameId: frame.uniqueFrameId,
        frameId: frame.frameId,
        timestamp: frame.timestamp,
        receivedAt: frame.receivedAt,
        filePath: frame.filePath,
      })),
    });

    const { content: userContent, frames: screenShareFrames } = await this.questionContentWithImages(
      question,
      context,
      candidateScreenShareFrames,
      retrieval.evidencePacket,
      focus,
      availableScreenShareFrames.length,
    );
    if (
      this.config.noFrameFixedReply &&
      focus === "visual" &&
      screenShareFrames.length === 0
    ) {
      const answer = looksChinese(question.question)
        ? "我现在看不到当前共享的幻灯片（没有收到屏幕画面）。请确认正在共享屏幕，或停止后再重新共享一次。"
        : "I cannot see the current slide: no live screen-share image is arriving. Please confirm screen share is on, or stop sharing and start again.";
      return {
        answer,
        vlmRawAnswer: answer,
        finalAnswer: answer,
        vlmModel: this.config.vlmModel,
        answerModel: this.config.answerLlmEnabled
          ? this.config.answerLlmModel
          : `${this.config.vlmModel} (single-model fallback)`,
        streamId,
        context,
        screenShareFramesUsed: [],
        retrievalRecord: retrieval.record,
      };
    }
    const retrievalEvidenceAvailable = hasRetrievalEvidence(retrieval.record);
    const clinicalMode = usesClinicalAnswerMode(
      question.question,
      retrieval.record,
    );
    const vlmMaxTokens = retrievalEvidenceAvailable
      ? this.config.ragVlmMaxTokens
      : this.config.vlmMaxTokens;

    this.emit("qa-vlm-started", {
      streamId,
      question: question.question,
      model: this.config.vlmModel,
      maxTokens: vlmMaxTokens,
      retrievalEvidenceAvailable,
      clinicalMode,
      screenShareFrames: screenShareFrames.length,
    });

    const vlmStartedAt = Date.now();
    const systemContent = [
      "You are the internal multimodal reasoning model for ECHO, an AI meeting assistant.",
      clinicalMode
        ? "This question is clinical or evidence-related. Produce a professional educational candidate answer for healthcare clinicians in an ECHO session, not casual chat banter."
        : "Use the meeting transcript, screen share frames, and the user's question to produce a complete candidate answer.",
      "When an Evidence Packet is provided, distinguish current meeting content from retrieved historical ECHO transcript chunks, structured historical ECHO cases, and public literature.",
      allowedCitations.length > 0
        ? `The only permitted evidence citations are: ${allowedCitations.join(", ")}. Preserve those IDs exactly and never create another [ECHO:*], [Case:*], or [PMID:*] citation.`
        : "No evidence citation IDs are available. Never output any [ECHO:*], [Case:*], or [PMID:*] citation.",
      focus === "speech"
        ? "This question asks what someone said out loud, so answer only from the spoken transcript. Text printed on a slide is not speech: never quote slide or screen text as something a person said. If the transcript holds no relevant speech, say that you did not catch it and do not substitute anything from the screen."
        : focus === "visual"
          ? "This question asks about the shared screen. The attached image(s) are the full live screen share. Describe the slide content that is actually visible: title, headings, and body text. Never invent a topic. Never answer with only a PowerPoint page label such as Slide N of M. Never say you cannot see or access the slide while an image is attached. If no screen-share image is supplied, then say you cannot see the current slide."
          : "Answer from the transcript and the screen share frames together, and make clear which one each fact comes from when it matters.",
      clinicalMode
        ? [
            "Write a natural Zoom chat answer: lead with the educational point, weave in supporting evidence from the transcript and/or Evidence Packet with citations when available, and include important caveats or unknowns when needed.",
            "Do not use section labels, headings, or prefixes such as Bottom line, Evidence, Caveats, Analysis, or Summary.",
            "Prefer precise specialty terminology present in the Evidence Packet (for example MOUD, buprenorphine formulations, induction, taper). Do not invent drug names, doses, diagnoses, or outcomes that are not supported by the transcript or Evidence Packet.",
            "Only cite a PMID when its title/abstract matches the same medication and clinical question (do not cite a buprenorphine-initiation paper for a methadone-maintenance pain question).",
            "When citing evidence, use at most 3 of the strongest supplied citation IDs. Do not dump every available citation.",
            "If the Evidence Packet says external evidence is unavailable or only meeting context remains, say that briefly and avoid definitive treatment directives.",
            "Distinguish what supplied abstracts or prior ECHO discussions support from what is unknown. Never speak as a clinical guideline, never claim standard of care, and never issue patient-specific treatment orders.",
            "If evidence is thin or absent, say so clearly and avoid overconfident clinical claims.",
          ].join(" ")
        : [
            "Questions arrive as live chat messages: expect typos, missing punctuation, slang, contractions, and casual or incomplete grammar (for example \"what did i jus tsay\", \"where're we getting at\", \"what's he on about\", \"what does my slide say\"). Read past the wording, infer the most plausible intent, and answer that.",
            "Frequent intents are: recalling what was spoken, catching up on what has been discussed so far, explaining the current slide, and clarifying a term that was used.",
            "Never reply that you do not understand the question or ask the participant to rephrase while the transcript, screen frames, or evidence contain anything relevant. Pick the most likely reading and answer it.",
          ].join(" "),
      "Do not invent operational instructions (OAuth, RTMS, restarts) unless they appear in the transcript or question.",
      "Reply in the same language as the question when possible.",
      "This output is internal and will be rewritten by a separate text formatter before it is sent to Zoom.",
      "End with a clear candidate final answer.",
    ].join(" ");

    let usedScreenShareFrames = screenShareFrames;
    let vlmRawAnswer: string | undefined;
    try {
      vlmRawAnswer = await this.callVlm(
        [
          { role: "system", content: systemContent },
          { role: "user", content: userContent },
        ],
        vlmMaxTokens,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (screenShareFrames.length > 0) {
        // Vision prompts with high-res frames plus a long transcript can exceed
        // the VLM 8192-token window and return HTTP 400 even with a single image.
        this.emit("qa-vlm-retry-text-only", {
          streamId,
          question: question.question,
          previousFrameCount: screenShareFrames.length,
          message,
        });
        try {
          const retry = await this.questionContentWithImages(
            question,
            context,
            [],
            retrieval.evidencePacket,
            focus,
            availableScreenShareFrames.length,
          );
          usedScreenShareFrames = [];
          vlmRawAnswer = await this.callVlm(
            [
              { role: "system", content: systemContent },
              { role: "user", content: retry.content },
            ],
            vlmMaxTokens,
          );
        } catch (textOnlyError) {
          this.emit("qa-vlm-retry-text-only-failed", {
            streamId,
            question: question.question,
            message:
              textOnlyError instanceof Error ? textOnlyError.message : String(textOnlyError),
          });
        }
      }

      if (vlmRawAnswer === undefined) {
        this.emit("qa-vlm-retry-clipped-context", {
          streamId,
          question: question.question,
          message,
        });
        const compact = await this.questionContentWithImages(
          question,
          clipTail(context, 2_200),
          [],
          "",
          focus,
          availableScreenShareFrames.length,
        );
        usedScreenShareFrames = [];
        vlmRawAnswer = await this.callVlm(
          [
            { role: "system", content: systemContent },
            { role: "user", content: compact.content },
          ],
          Math.min(256, vlmMaxTokens),
        );
      }
    }

    if (!vlmRawAnswer) {
      throw new Error("LLM request failed with no VLM answer");
    }

    if (
      focus === "visual" &&
      usedScreenShareFrames.length > 0 &&
      looksLikeThinSlideAnswer(vlmRawAnswer)
    ) {
      this.emit("qa-vlm-retry-read-slide", {
        streamId,
        question: question.question,
        previousRaw: vlmRawAnswer,
      });
      const canvasOnly = await this.questionContentWithImages(
        question,
        "",
        usedScreenShareFrames,
        "",
        focus,
        availableScreenShareFrames.length,
      );
      vlmRawAnswer = preferSlideBodyText(
        await this.callVlm(
          [
            {
              role: "system",
              content:
                "You transcribe a shared PowerPoint canvas. Quote the visible title and every body bullet verbatim. Ignore browser chrome, thumbnail strips, and Slide N of M page labels. Never answer with only a slide number.",
            },
            { role: "user", content: canvasOnly.content },
          ],
          vlmMaxTokens,
        ),
      );
      if (looksLikeThinSlideAnswer(vlmRawAnswer)) {
        this.emit("qa-vlm-slide-still-thin", {
          streamId,
          question: question.question,
          raw: vlmRawAnswer,
        });
        vlmRawAnswer = unansweredSlideBody(question.question);
      }
    } else if (focus === "visual" && usedScreenShareFrames.length > 0) {
      vlmRawAnswer = preferSlideBodyText(vlmRawAnswer);
    }

    this.emit("qa-vlm-completed", {
      streamId,
      question: question.question,
      model: this.config.vlmModel,
      rawChars: vlmRawAnswer.length,
      elapsedMs: Date.now() - vlmStartedAt,
    });

    const skipFormatter =
      focus === "visual" &&
      usedScreenShareFrames.length > 0 &&
      /only caught the page label|只读到页码/u.test(vlmRawAnswer);
    const finalAnswer = skipFormatter
      ? this.finalizeAnswer(
          vlmRawAnswer,
          question.question,
          retrieval.record,
          streamId,
          conciseAnswerCharCap(
            this.config.answerStyle,
            "default",
            this.config.answerLlmMaxChars,
          ),
        )
      : await this.createFinalAnswer(
          question.question,
          vlmRawAnswer,
          streamId,
          retrieval.record,
          {
            hadScreenShareFrames: usedScreenShareFrames.length > 0,
            focus,
          },
        );

    return {
      answer: finalAnswer,
      vlmRawAnswer,
      finalAnswer,
      vlmModel: this.config.vlmModel,
      answerModel: this.config.answerLlmEnabled
        ? this.config.answerLlmModel
        : `${this.config.vlmModel} (single-model fallback)`,
      streamId,
      context,
      screenShareFramesUsed: usedScreenShareFrames,
      retrievalRecord: retrieval.record,
    };
  }

  private async createFinalAnswer(
    question: string,
    vlmRawAnswer: string,
    streamId: string | null,
    retrievalRecord: RetrievalRecord | null,
    options: { hadScreenShareFrames?: boolean; focus?: QuestionFocus } = {},
  ): Promise<string> {
    const isLiteratureAnswer =
      (retrievalRecord?.intent === "literature" ||
        retrievalRecord?.intent === "both") &&
      (retrievalRecord?.literature.length ?? 0) > 0;
    const isRagAnswer = hasRetrievalEvidence(retrievalRecord);
    const clinicalMode = usesClinicalAnswerMode(question, retrievalRecord);
    const wantsLiteratureBudget =
      isLiteratureAnswer ||
      retrievalRecord?.intent === "literature" ||
      retrievalRecord?.intent === "both" ||
      /\b(literature|pubmed|evidence review|mini-?review|systematic review)\b/iu.test(
        question,
      );
    const concise = this.config.answerStyle === "concise";
    const maxTokens = wantsLiteratureBudget
      ? this.config.literatureAnswerMaxTokens
      : isRagAnswer || clinicalMode
        ? this.config.ragAnswerLlmMaxTokens
      : this.config.answerLlmMaxTokens;
    const kind: "default" | "clinical" | "literature" = wantsLiteratureBudget
      ? "literature"
      : isRagAnswer || clinicalMode
        ? "clinical"
        : "default";
    const configuredChars = wantsLiteratureBudget
      ? this.config.literatureAnswerMaxChars
      : isRagAnswer || clinicalMode
        ? this.config.ragAnswerLlmMaxChars
      : this.config.answerLlmMaxChars;
    const maxChars = conciseAnswerCharCap(
      this.config.answerStyle,
      kind,
      configuredChars,
    );
    const tokenBudget = concise
      ? Math.min(
          maxTokens,
          kind === "literature" ? 220 : kind === "clinical" ? 160 : 120,
        )
      : maxTokens;
    if (!this.config.answerLlmEnabled) {
      return this.finalizeAnswer(
        vlmRawAnswer,
        question,
        retrievalRecord,
        streamId,
        maxChars,
      );
    }

    const permittedCitations = Array.from(
      allowedEvidenceCitations(retrievalRecord),
    );
    this.emit("qa-answer-llm-started", {
      streamId,
      question,
      model: this.config.answerLlmModel,
      maxTokens: tokenBudget,
      maxChars,
      answerStyle: this.config.answerStyle,
      clinicalMode,
      vlmRawChars: vlmRawAnswer.length,
    });

    const formatterStartedAt = Date.now();
    try {
      const lengthRule = concise
        ? clinicalMode || isLiteratureAnswer
          ? "Hard length limit for live Zoom chat: at most 3-4 short sentences in one bubble. Prefer the single most useful teaching point; omit secondary detail."
          : "Hard length limit for live Zoom chat: 1-3 short sentences only."
        : clinicalMode
          ? "Allow more than 1-3 sentences when needed for clarity and safety hedging."
          : "Keep it short: normally 1-3 sentences.";
      const formatterAnswer = await this.callAnswerLlm([
        {
          role: "system",
          content:
            [
              "You are ECHO's final Zoom chat formatter.",
              clinicalMode
                ? "Convert the internal candidate into a professional educational Zoom chat answer for clinicians in an ECHO session."
                : "Your job is to convert an internal multimodal model response into a concise answer suitable for a live Zoom meeting chat.",
              "Use the same language as the user's question when possible.",
              "Output only the final answer. Do not include Thinking Process, Reasoning, Analysis, chain-of-thought, markdown headings, section labels, or internal notes.",
              "Do not start lines with labels such as Bottom line, Evidence, Caveats, Summary, or Analysis.",
              "Do not mention that another model produced the candidate answer.",
              permittedCitations.length > 0
                ? `Preserve only these supplied citation IDs exactly: ${permittedCitations.join(", ")}. Never create any other [ECHO:*], [Case:*], or [PMID:*] citation.`
                : "No evidence citations were supplied. Do not output any [ECHO:*], [Case:*], or [PMID:*] citation.",
              isLiteratureAnswer
                ? [
                    "This is a literature-supported clinical education answer.",
                    "Write naturally in short Zoom chat paragraphs: state the educational point, mention study design/year/population when available, keep PMID citations, and note what remains uncertain.",
                    "Do not claim a systematic review, guideline authority, or standard of care. Hedge with language such as evidence suggests, may, or associated with.",
                  ].join(" ")
                : clinicalMode
                  ? [
                      "This is a clinical ECHO education answer.",
                      "Write naturally in short Zoom chat paragraphs. Prefer precise clinical wording from the candidate answer. Do not invent doses, drug names, or diagnoses.",
                      "Do not issue patient-specific treatment orders.",
                    ].join(" ")
                  : "",
              lengthRule,
              "Always finish complete sentences. Never stop mid-word or mid-sentence because of length; if space is tight, omit a later point instead of truncating a word.",
              "The user's question may be casual or contain typos; answer it as written and never comment on its phrasing.",
              "Never turn a substantive candidate answer into a request for clarification. Only when the candidate answer itself says the context is insufficient, state that briefly and ask for the missing detail.",
              options.hadScreenShareFrames
                ? "A screenshot of the shared slide was provided. Never say you do not have access, cannot see the slide, or ask the participant to describe it. Report the visible title and on-screen text from the candidate. Never reduce the answer to only a slide number such as Slide 25 of 28. If the candidate already transcribed bullets or a title, keep them."
                : "",
              clinicalMode
                ? "Do not append any disclaimer yourself; a fixed educational disclaimer is added automatically after formatting."
                : "",
            ]
              .filter(Boolean)
              .join(" "),
        },
        {
          role: "user",
          content:
            [
              `User question:\n${question}`,
              `Internal multimodal candidate answer:\n${vlmRawAnswer}`,
              "Return only the polished Zoom chat answer.",
            ].join("\n\n"),
        },
      ], tokenBudget);

      let chosen =
        options.hadScreenShareFrames &&
        looksLikeDeniedSlideAccess(formatterAnswer) &&
        !looksLikeDeniedSlideAccess(vlmRawAnswer)
          ? vlmRawAnswer
          : formatterAnswer;
      if (options.hadScreenShareFrames && options.focus === "visual") {
        chosen = preferSlideBodyText(chosen);
        if (looksLikeThinSlideAnswer(chosen)) {
          const fromVlm = preferSlideBodyText(vlmRawAnswer);
          chosen = looksLikeThinSlideAnswer(fromVlm)
            ? unansweredSlideBody(question)
            : fromVlm;
        }
      }
      const finalAnswer = this.finalizeAnswer(
        chosen,
        question,
        retrievalRecord,
        streamId,
        maxChars,
      );
      this.emit("qa-answer-llm-completed", {
        streamId,
        question,
        model: this.config.answerLlmModel,
        rawChars: formatterAnswer.length,
        finalChars: finalAnswer.length,
        elapsedMs: Date.now() - formatterStartedAt,
      });
      return finalAnswer;
    } catch (error) {
      this.emit("qa-answer-llm-error", {
        streamId,
        question,
        model: this.config.answerLlmModel,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private finalizeAnswer(
    answer: string,
    question: string,
    retrievalRecord: RetrievalRecord | null,
    streamId: string | null,
    maxChars: number,
  ): string {
    const clinicalMode = usesClinicalAnswerMode(question, retrievalRecord);
    const disclaimer = clinicalMode
      ? clinicalDisclaimerForQuestion(question)
      : "";
    const reservedChars = disclaimer
      ? disclaimer.length + 2
      : 0;
    const citationChecked = enforceEvidenceCitationWhitelist(
      cleanFinalAnswer(answer, question),
      retrievalRecord,
    );
    if (citationChecked.removed.length > 0) {
      this.emit("qa-invalid-citations-removed", {
        streamId,
        question,
        removed: citationChecked.removed,
        retrievalId: retrievalRecord?.retrievalId ?? null,
      });
    }
    const displayAnswer = renderEvidenceSourceReferences(
      citationChecked.answer,
      retrievalRecord,
    );
    const bodyBudget = Math.max(120, maxChars - reservedChars);
    // Keep full [n]: PMID/ECHO footnote lines; only trim prose (website-synced).
    const cleaned = trimAnswerPreservingFootnotes(
      displayAnswer,
      bodyBudget,
    );
    const withDisclaimer = clinicalMode
      ? appendClinicalDisclaimer(cleaned, question)
      : cleaned;

    if (withDisclaimer) {
      return withDisclaimer;
    }

    return looksChinese(question)
      ? "我目前还没有足够清晰的会议上下文来给出简洁答案。"
      : "I do not have enough clear meeting context to answer concisely yet.";
  }

  private async answerAndSend(question: AiQuestion): Promise<void> {
    const answerStartedAt = Date.now();
    let chatAnswer = "";
    try {
      this.emit("qa-llm-started", {
        question: question.question,
        streamId: question.streamId ?? this.latestStreamId,
      });
      const result = await this.ask(question);
      chatAnswer = formatZoomChatReply(
        result.answer,
        question,
        this.config.botName,
      );
      const sendResult = await this.sendChat(
        chatAnswer,
        question.replyToUserId,
        question.replyToMessage,
      );
      await this.persistQa({
        ...question,
        streamId: result.streamId ?? undefined,
        answer: chatAnswer,
        vlmRawAnswer: result.vlmRawAnswer,
        finalAnswer: result.finalAnswer,
        vlmModel: result.vlmModel,
        answerModel: result.answerModel,
        contextChars: result.context.length,
        screenShareFramesUsed: result.screenShareFramesUsed,
        retrieval: result.retrievalRecord
          ? {
              retrievalId: result.retrievalRecord.retrievalId,
              status: result.retrievalRecord.status,
              intent: result.retrievalRecord.intent,
              transcriptChunks: result.retrievalRecord.transcriptChunks.length,
              historicalCases: result.retrievalRecord.historicalCases.length,
              literature: result.retrievalRecord.literature.length,
              warnings: result.retrievalRecord.warnings,
            }
          : null,
      });
      this.emit("qa-answer-sent", {
        streamId: result.streamId,
        question: question.question,
        answer: chatAnswer,
        vlmModel: result.vlmModel,
        answerModel: result.answerModel,
        retrievalId: result.retrievalRecord?.retrievalId ?? null,
        retrievalStatus: result.retrievalRecord?.status ?? null,
        replyToUserId: question.replyToUserId,
        replyToMessageId: question.replyToMessage?.messageId ?? null,
        replyType: question.replyType ?? null,
        screenShareFramesUsed: result.screenShareFramesUsed.map((frame) => ({
          uniqueFrameId: frame.uniqueFrameId,
          frameId: frame.frameId,
          timestamp: frame.timestamp,
          filePath: frame.filePath,
        })),
        result: sendResult,
        answerPipelineMs: Date.now() - answerStartedAt,
        questionEndToAnswerMs:
          typeof question.askedAt === "number"
            ? Math.max(0, Date.now() - question.askedAt)
            : null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit("qa-error", {
        question: question.question,
        streamId: question.streamId ?? this.latestStreamId,
        message,
      });
      // Do not post to Everyone — text Q&A must stay a nested reply.
    }
  }

  private scheduleIdleFlush(state: AsrBufferState): void {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
    }

    state.idleTimer = setTimeout(() => {
      state.idleTimer = null;
      void this.handleSpeakerIdle(state);
    }, this.config.asrIdleFlushMs);
  }

  private appendPreRoll(state: AsrBufferState, frame: AudioFrame): void {
    const maxSeconds = this.config.asrSpeechPrerollMs / 1_000;
    if (maxSeconds <= 0) {
      return;
    }

    state.preRoll.push(frame);
    state.preRollSeconds += frame.durationSeconds;
    while (state.preRoll.length > 0 && state.preRollSeconds > maxSeconds) {
      const removed = state.preRoll.shift();
      state.preRollSeconds = Math.max(
        0,
        state.preRollSeconds - (removed?.durationSeconds ?? 0),
      );
    }
  }

  private async handleSpeakerIdle(state: AsrBufferState): Promise<void> {
    state.speechActive = false;

    if (state.inFlight) {
      state.pendingBoundary = "speaker-idle";
      await state.inFlightPromise?.catch(() => undefined);
      return;
    }

    if (state.pending.length > 0) {
      await this.submitAsr(state, true, "speaker-idle");
      return;
    }

    state.overlap = [];
    state.lastText = "";
    this.voiceInvocation.ingest({
      streamId: state.streamId,
      meetingUuid: state.meetingUuid,
      userId: state.userId,
      userName: state.userName,
      text: "",
      startTimestamp: Date.now(),
      endTimestamp: Date.now(),
      boundary: "speaker-idle",
    });
  }

  private async drainAsrState(
    state: AsrBufferState,
    boundary: Extract<VoiceTranscriptBoundary, "stream-flush">,
  ): Promise<void> {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
    state.speechActive = false;
    state.preRoll = [];
    state.preRollSeconds = 0;

    if (state.inFlight) {
      state.pendingBoundary = boundary;
      while (state.inFlight) {
        const current = state.inFlightPromise;
        if (!current) {
          break;
        }
        await current.catch(() => undefined);
      }
      return;
    }

    if (state.pending.length > 0) {
      await this.submitAsr(state, true, boundary);
      while (state.inFlight) {
        const current = state.inFlightPromise;
        if (!current) {
          break;
        }
        await current.catch(() => undefined);
      }
      return;
    }

    state.overlap = [];
    state.lastText = "";
    this.voiceInvocation.ingest({
      streamId: state.streamId,
      meetingUuid: state.meetingUuid,
      userId: state.userId,
      userName: state.userName,
      text: "",
      startTimestamp: Date.now(),
      endTimestamp: Date.now(),
      boundary,
    });
  }

  private submitAsr(
    state: AsrBufferState,
    force = false,
    boundary: VoiceTranscriptBoundary = "max-window",
  ): Promise<void> {
    if (state.inFlight) {
      if (boundary !== "max-window") {
        state.pendingBoundary = boundary;
      }
      return state.inFlightPromise ?? Promise.resolve();
    }

    if (!force && state.pendingSeconds < this.config.asrChunkSeconds) {
      return Promise.resolve();
    }

    if (force && state.pending.length === 0) {
      return Promise.resolve();
    }

    const frames = [...state.overlap, ...state.pending];
    state.pending = [];
    state.pendingSeconds = 0;
    state.overlap =
      boundary === "max-window"
        ? tailFrames(frames, this.config.asrOverlapSeconds)
        : [];
    state.inFlight = true;

    const audio = combineFrames(frames);
    const first = frames[0];
    const last = frames[frames.length - 1];
    const startTimestamp = first?.timestamp ?? Date.now();
    const endTimestamp =
      (last?.timestamp ?? startTimestamp) + Math.round((last?.durationSeconds ?? 0) * 1000);
    const durationSeconds = audio.length / PCM_BYTES_PER_SECOND;

    const task = (async () => {
      try {
        const result = await this.transcribe(audio, durationSeconds);
        const text = normalizeText(result.text ?? "");

        state.submittedSegments += 1;
        this.emit("asr-stats", {
          streamId: state.streamId,
          userId: state.userId,
          userName: state.userName,
          audioBytes: audio.length,
          durationSeconds,
          textChars: text.length,
          boundary,
          inferenceSeconds: result.inferenceSeconds ?? null,
        });

        if (text && compactForCompare(text) !== compactForCompare(state.lastText)) {
          state.lastText = text;
          const segment: AsrSegment = {
            id: ++this.segmentId,
            streamId: state.streamId,
            meetingUuid: state.meetingUuid,
            userId: state.userId,
            userName: state.userName,
            startTimestamp,
            endTimestamp,
            text,
            language: result.language ?? null,
            durationSeconds,
            createdAt: new Date().toISOString(),
          };
          await this.addAsrSegment(segment);
          this.voiceInvocation.ingest({
            ...segment,
            boundary,
          });
        } else if (boundary !== "max-window") {
          this.voiceInvocation.ingest({
            streamId: state.streamId,
            meetingUuid: state.meetingUuid,
            userId: state.userId,
            userName: state.userName,
            text: "",
            startTimestamp,
            endTimestamp,
            boundary,
          });
        }
        if (boundary !== "max-window") {
          state.lastText = "";
        }
      } catch (error) {
        this.emit("asr-error", {
          streamId: state.streamId,
          userId: state.userId,
          userName: state.userName,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        state.inFlight = false;
        state.inFlightPromise = null;
        const requestedBoundary = state.pendingBoundary;
        state.pendingBoundary = null;

        if (requestedBoundary) {
          if (state.pending.length > 0) {
            void this.submitAsr(state, true, requestedBoundary);
          } else {
            state.overlap = [];
            state.lastText = "";
            this.voiceInvocation.ingest({
              streamId: state.streamId,
              meetingUuid: state.meetingUuid,
              userId: state.userId,
              userName: state.userName,
              text: "",
              startTimestamp: Date.now(),
              endTimestamp: Date.now(),
              boundary: requestedBoundary,
            });
          }
        } else if (state.pendingSeconds >= this.config.asrChunkSeconds) {
          void this.submitAsr(state, false, "max-window");
        }
      }
    })();

    state.inFlightPromise = task;
    return task;
  }

  private async transcribe(audio: Buffer, durationSeconds: number): Promise<AsrResponse> {
    const response = await fetch(`${this.config.asrServiceUrl.replace(/\/$/, "")}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        sampleRate: 16_000,
        channels: 1,
        sampleWidthBytes: 2,
        durationSeconds,
      }),
    });

    const body = (await response.json().catch(() => ({}))) as AsrResponse & {
      error?: string;
      detail?: string;
    };

    if (!response.ok) {
      throw new Error(body.error || body.detail || `ASR request failed with HTTP ${response.status}`);
    }

    return body;
  }

  private async checkService(url: string): Promise<{
    ok: boolean;
    url: string;
    status?: number;
    body?: unknown;
    error?: string;
  }> {
    try {
      const response = await fetch(url, { method: "GET" });
      const body = await response.json().catch(() => undefined);
      return {
        ok: response.ok,
        url,
        status: response.status,
        body,
      };
    } catch (error) {
      return {
        ok: false,
        url,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async addAsrSegment(segment: AsrSegment): Promise<void> {
    const memory = this.ensureMemory(segment.streamId, segment.meetingUuid);
    memory.segments.push(segment);
    memory.summaryCharsSinceUpdate += segment.text.length;
    this.latestStreamId = segment.streamId;

    const filePath = await this.asrPath(segment.streamId);
    await appendFile(filePath, `${JSON.stringify(segment)}\n`);
    this.emit("asr-segment", segment);
    void this.maybeUpdateSummary(memory);
  }

  private ensureMemory(streamId: string, meetingUuid: string | null): MeetingMemory {
    const existing = this.memories.get(streamId);

    if (existing) {
      if (!existing.meetingUuid && meetingUuid) {
        existing.meetingUuid = meetingUuid;
      }
      return existing;
    }

    const memory: MeetingMemory = {
      streamId,
      meetingUuid,
      segments: [],
      screenShareFrames: [],
      summary: "",
      summaryInFlight: false,
      summaryUpdatedAt: null,
      summaryCharsSinceUpdate: 0,
      lastSummaryAttemptAt: 0,
    };
    this.memories.set(streamId, memory);
    return memory;
  }

  private memoryFor(streamId?: string | null): MeetingMemory | null {
    if (streamId && this.memories.has(streamId)) {
      return this.memories.get(streamId) ?? null;
    }

    if (this.latestStreamId && this.memories.has(this.latestStreamId)) {
      return this.memories.get(this.latestStreamId) ?? null;
    }

    return Array.from(this.memories.values()).at(-1) ?? null;
  }

  private buildContext(
    streamId: string | null | undefined,
    question: string,
    cutoffAt?: number,
  ): string {
    const memory = this.memoryFor(streamId);
    if (!memory || memory.segments.length === 0) {
      return "";
    }

    const eligibleSegments =
      typeof cutoffAt === "number"
        ? memory.segments.filter((segment) => segment.endTimestamp <= cutoffAt)
        : memory.segments;
    if (eligibleSegments.length === 0) {
      return "";
    }

    const lines = eligibleSegments.map(transcriptLine);
    const full = lines.join("\n");

    if (full.length <= this.config.fullContextMaxChars) {
      return full;
    }

    const recent = takeTailChars(lines, this.config.recentContextMaxChars);
    const queryTerms = keywords(question);
    const relevantLines = queryTerms.length
      ? lines.filter((line) => {
          const lower = line.toLowerCase();
          return queryTerms.some((term) => lower.includes(term));
        })
      : [];
    const relevant = takeTailChars(relevantLines, this.config.relevantContextMaxChars);

    return [
      memory.summary ? `Rolling meeting summary:\n${memory.summary}` : "",
      relevant ? `Relevant earlier transcript:\n${relevant}` : "",
      recent ? `Recent transcript:\n${recent}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private screenShareFramesForQuestion(
    streamId: string | null | undefined,
    askedAt: number,
  ): AiScreenShareFrame[] {
    if (!this.config.screenShareEnabled || this.config.screenShareMaxImages <= 0) {
      return [];
    }

    const memory = this.memoryFor(streamId);
    if (!memory || memory.screenShareFrames.length === 0) {
      return [];
    }

    return memory.screenShareFrames
      .filter((frame) => {
        const frameTime = frame.timestamp > 0 ? frame.timestamp : Date.parse(frame.receivedAt);
        return Number.isFinite(frameTime) && frameTime <= askedAt;
      })
      .slice(-this.config.screenShareMaxImages);
  }

  private async questionContentWithImages(
    question: AiQuestion,
    context: string,
    frames: AiScreenShareFrame[],
    evidencePacket: string,
    focus: QuestionFocus = "general",
    availableFrameCount: number = frames.length,
  ): Promise<{ content: LlmMessageContent; frames: AiScreenShareFrame[] }> {
    const hasImages = frames.length > 0 && this.config.vlmMultimodal;
    const clippedContext = clipTail(
      context,
      hasImages ? VLM_CONTEXT_CHARS_WITH_IMAGE : VLM_CONTEXT_CHARS_TEXT_ONLY,
    );
    const clippedEvidence = clipTail(
      evidencePacket,
      hasImages ? VLM_EVIDENCE_CHARS_WITH_IMAGE : VLM_EVIDENCE_CHARS_TEXT_ONLY,
    );
    const withheldForSpeech =
      (focus === "speech" || looksLikeSelfIdentityQuestion(question.question)) &&
      availableFrameCount > 0 &&
      frames.length === 0;
    const visualRead =
      focus === "visual" && frames.length > 0
        ? "Read the attached full screenshot. Quote the visible title and body bullets. A PowerPoint page label is chrome, not the slide content. Never answer with only Slide N of M."
        : "";
    const text = [
      [
        "Instruction:\nAnswer the participant's question directly and concisely. Do not show your reasoning process. Do not start with \"Thinking Process\", \"Reasoning\", \"Analysis\", or similar labels.",
        visualRead,
      ]
        .filter(Boolean)
        .join(" "),
      `Meeting transcript context:\n${clippedContext || "(No ASR transcript has been captured yet.)"}`,
      frames.length
        ? `Screen share context:\nThe following ${frames.length} image(s) are the latest unique screen share frames captured before the question, ordered from oldest to newest.\n${frames.map(frameLine).join("\n")}`
        : withheldForSpeech
          ? `Screen share context:\n(A screen is being shared, but its ${availableFrameCount} frame(s) are withheld because this question is about spoken words. Answer from the transcript above only.)`
          : "Screen share context:\n(No screen share frames are available for this question.)",
      clippedEvidence
        ? clippedEvidence
        : "Evidence Packet:\n(No historical-case or PubMed retrieval was requested for this question.)",
      `Question from ${question.senderName ?? "a meeting participant"}:\n${question.question}`,
    ].join("\n\n");

    if (frames.length === 0) {
      return { content: text, frames: [] };
    }

    // Text-only VLM backends (e.g. Qwen3-Instruct) reject image_url parts with HTTP 400.
    if (!this.config.vlmMultimodal) {
      this.emit("qa-vision-skipped", {
        streamId: frames[0]?.streamId ?? null,
        reason: "VLM_MULTIMODAL=false; using screen-share text metadata only",
        frameCount: frames.length,
        model: this.config.vlmModel,
      });
      return { content: text, frames: [] };
    }

    const content: Exclude<LlmMessageContent, string> = [{ type: "text", text }];
    const includedFrames: AiScreenShareFrame[] = [];

    for (const frame of frames) {
      try {
        const image = await readFile(frame.filePath);
        if (image.length > this.config.screenShareMaxImageBytes) {
          this.emit("vlm-error", {
            streamId: frame.streamId,
            uniqueFrameId: frame.uniqueFrameId,
            filePath: frame.filePath,
            message: `screen share frame is too large (${image.length} bytes)`,
          });
          continue;
        }

        content.push({
          type: "image_url",
          image_url: {
            url: `data:${screenShareMimeType(frame)};base64,${image.toString("base64")}`,
          },
        });
        includedFrames.push(frame);
      } catch (error) {
        this.emit("vlm-error", {
          streamId: frame.streamId,
          uniqueFrameId: frame.uniqueFrameId,
          filePath: frame.filePath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return includedFrames.length > 0 ? { content, frames: includedFrames } : { content: text, frames: [] };
  }

  private async maybeUpdateSummary(memory: MeetingMemory): Promise<void> {
    const now = Date.now();
    const enoughTime = now - memory.lastSummaryAttemptAt >= this.config.summaryUpdateSeconds * 1000;
    const enoughText = memory.summaryCharsSinceUpdate >= this.config.summaryUpdateChars;

    if (memory.summaryInFlight || (!enoughTime && !enoughText)) {
      return;
    }

    memory.summaryInFlight = true;
    memory.lastSummaryAttemptAt = now;

    try {
      const recent = takeTailChars(memory.segments.map(transcriptLine), 8_000);
      const summary = await this.callSummaryLlm([
        {
          role: "system",
          content:
            "Update a concise running meeting summary. Preserve decisions, action items, names, unresolved questions, and important facts. Do not invent details.",
        },
        {
          role: "user",
          content: `Previous summary:\n${memory.summary || "(none)"}\n\nNew transcript excerpts:\n${recent}`,
        },
      ], 500);

      memory.summary = normalizeText(summary);
      memory.summaryUpdatedAt = new Date().toISOString();
      memory.summaryCharsSinceUpdate = 0;
      this.emit("ai-summary-updated", {
        streamId: memory.streamId,
        summaryChars: memory.summary.length,
      });
    } catch (error) {
      this.emit("ai-summary-error", {
        streamId: memory.streamId,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      memory.summaryInFlight = false;
    }
  }

  private async callVlm(messages: LlmMessage[], maxTokens: number): Promise<string> {
    return this.callLlm(
      {
        baseUrl: this.config.vlmBaseUrl,
        model: this.config.vlmModel,
        apiKey: this.config.vlmApiKey,
        enableThinking: this.config.vlmEnableThinking,
      },
      messages,
      maxTokens,
    );
  }

  private async callAnswerLlm(messages: LlmMessage[], maxTokens: number): Promise<string> {
    return this.callLlm(
      {
        baseUrl: this.config.answerLlmBaseUrl,
        model: this.config.answerLlmModel,
        apiKey: this.config.answerLlmApiKey,
        enableThinking: this.config.answerLlmEnableThinking,
      },
      messages,
      maxTokens,
    );
  }

  private async callSummaryLlm(messages: LlmMessage[], maxTokens: number): Promise<string> {
    if (this.config.answerLlmEnabled) {
      return this.callAnswerLlm(messages, maxTokens);
    }

    return this.callVlm(messages, maxTokens);
  }

  private async callLlm(
    client: LlmClientConfig,
    messages: LlmMessage[],
    maxTokens = 900,
  ): Promise<string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (client.apiKey) {
      headers.Authorization = `Bearer ${client.apiKey}`;
    }

    const response = await fetch(
      `${client.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: client.model,
          messages,
          temperature: 0.2,
          max_tokens: maxTokens,
          chat_template_kwargs: {
            enable_thinking: client.enableThinking,
          },
        }),
      },
    );

    const body = (await response.json().catch(() => ({}))) as ChatCompletionResponse & {
      error?: { message?: string } | string;
    };

    if (!response.ok) {
      const message =
        typeof body.error === "string"
          ? body.error
          : body.error?.message || `LLM request failed with HTTP ${response.status}`;
      throw new Error(message);
    }

    const content = body.choices?.[0]?.message?.content ?? body.choices?.[0]?.text ?? "";
    if (!content.trim()) {
      throw new Error("LLM returned an empty response");
    }

    return content;
  }

  private async asrPath(streamId: string): Promise<string> {
    const dir = path.join(this.config.dataDir, "asr");
    await mkdir(dir, { recursive: true });
    return path.join(dir, `${sanitizePathPart(streamId)}.ndjson`);
  }

  private async qaPath(streamId: string): Promise<string> {
    const dir = path.join(this.config.dataDir, "qa");
    await mkdir(dir, { recursive: true });
    return path.join(dir, `${sanitizePathPart(streamId)}.ndjson`);
  }

  private async persistQa(
    question: AiQuestion & {
      answer: string;
      vlmRawAnswer: string;
      finalAnswer: string;
      vlmModel: string;
      answerModel: string;
      contextChars: number;
      screenShareFramesUsed: AiScreenShareFrame[];
      retrieval?: unknown;
    },
  ): Promise<void> {
    const streamId = question.streamId ?? this.latestStreamId ?? "unknown";
    const filePath = await this.qaPath(streamId);
    await appendFile(
      filePath,
      `${JSON.stringify({
        ...question,
        streamId,
        createdAt: new Date().toISOString(),
      })}\n`,
    );
  }
}
