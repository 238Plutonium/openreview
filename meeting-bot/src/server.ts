import cors from "cors";
import "dotenv/config";
import express, { type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  CaseWorkspaceManager,
  type CaseSourceSnapshot,
  type CaseWorkspaceConfig,
} from "./caseWorkspace.js";
import {
  CaseOutputManager,
  type CaseOutputConfig,
  type CaseOutputFormat,
} from "./caseOutput.js";
import { MeetingAiManager, type AiQuestion, type MeetingAiConfig } from "./meetingAi.js";
import {
  MeetingMinutesManager,
  type MeetingMinutesConfig,
} from "./meetingMinutes.js";
import { RetrievalManager, type RetrievalConfig } from "./retrieval.js";
import {
  fetchZoomUserZak,
  oauthScopesIncludeZak,
  refreshOAuthAccessToken,
} from "./zoomOAuth.js";
import { RtmsManager, type RtmsManagerConfig } from "./rtmsManager.js";
import {
  DEFAULT_CONTENT_CHANGED_FRAC,
  DEFAULT_CONTENT_MEAN_ABS,
} from "./screenShareFingerprint.js";
import {
  ZoomWebBot,
  type ZoomWebBotConfig,
  type ZoomWebChatReplyTarget,
  type ZoomWebBotState,
} from "./zoomWebBot.js";

type ZoomState = ZoomWebBotState;

type BotEvent = {
  id: number;
  type: string;
  payload: unknown;
  state: ZoomState;
  createdAt: string;
};

type OAuthState = {
  installed: boolean;
  lastCallbackAt: string | null;
  lastTokenExchangeAt: string | null;
  lastError: string | null;
  tokenType: string | null;
  scope: string | null;
  expiresAt: string | null;
  accessToken: string | null;
  refreshToken: string | null;
};

type ChatParticipant = {
  name?: string;
  userId?: number;
};

type ChatPayload = {
  id?: string;
  message?: string | string[];
  sender?: ChatParticipant;
  receiver?: ChatParticipant;
  timestamp?: number;
  replyTarget?: ZoomWebChatReplyTarget;
};

type Config = {
  port: number;
  zoomClientId: string;
  zoomClientSecret: string;
  zoomMeetingNumber: string;
  zoomMeetingPassword: string;
  botName: string;
  autoJoin: boolean;
  browserHeadless: boolean;
  browserChannel: "chromium" | "chrome" | "msedge" | undefined;
  webBot: ZoomWebBotConfig;
  oauthRedirectUrl: string;
  ai: MeetingAiConfig;
  meetingMinutes: MeetingMinutesConfig;
  caseWorkspace: CaseWorkspaceConfig;
  caseOutput: CaseOutputConfig;
  retrieval: RetrievalConfig;
  rtms: RtmsManagerConfig & {
    webhookSecretToken: string;
  };
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let joinInFlight: Promise<unknown> | null = null;
let zoomState: ZoomState = "idle";
let lastError: string | null = null;
let lastJoinStartedAt: string | null = null;
let lastJoinedAt: string | null = null;
let eventId = 0;
const oauthStatePath = path.resolve(
  process.env.OAUTH_STATE_PATH?.trim() || "./data/oauth-state.json",
);

const emptyOAuthState = (): OAuthState => ({
  installed: false,
  lastCallbackAt: null,
  lastTokenExchangeAt: null,
  lastError: null,
  tokenType: null,
  scope: null,
  expiresAt: null,
  accessToken: null,
  refreshToken: null,
});

function publicOAuthState(state: OAuthState) {
  return {
    installed: state.installed,
    lastCallbackAt: state.lastCallbackAt,
    lastTokenExchangeAt: state.lastTokenExchangeAt,
    lastError: state.lastError,
    tokenType: state.tokenType,
    scope: state.scope,
    expiresAt: state.expiresAt,
  };
}

function loadOAuthState(): OAuthState {
  try {
    if (!fs.existsSync(oauthStatePath)) {
      return emptyOAuthState();
    }
    const raw = JSON.parse(fs.readFileSync(oauthStatePath, "utf8")) as Partial<OAuthState>;
    return {
      ...emptyOAuthState(),
      ...raw,
      installed: Boolean(raw.installed && raw.accessToken),
    };
  } catch {
    return emptyOAuthState();
  }
}

function saveOAuthState(state: OAuthState): void {
  try {
    fs.mkdirSync(path.dirname(oauthStatePath), { recursive: true });
    fs.writeFileSync(oauthStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch (error) {
    console.error(
      `Failed to persist OAuth state to ${oauthStatePath}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

let oauthState: OAuthState = loadOAuthState();
let botParticipant: ChatParticipant | null = null;

const sseClients = new Set<Response>();
const recentEvents: BotEvent[] = [];

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }

  return value;
}

function optionalEnv(name: string, fallback = ""): string {
  return process.env[name]?.trim() ?? fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseBrowserChannel(value: string | undefined): Config["browserChannel"] {
  if (!value) {
    return undefined;
  }

  if (value === "chromium" || value === "chrome" || value === "msedge") {
    return value;
  }

  throw new Error("BROWSER_CHANNEL must be one of: chromium, chrome, msedge");
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "3000");

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
}

function parseLoopbackHost(value: string | undefined): string {
  const host = (value ?? "127.0.0.1").trim().toLowerCase();
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error(
      "CASE_WORKSPACE_HOST must be a loopback host: 127.0.0.1, ::1, or localhost",
    );
  }
  return host;
}

function parsePositiveInteger(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value ?? String(fallback));

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseNonNegativeInteger(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value ?? String(fallback));

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return parsed;
}

function parsePositiveNumber(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value ?? String(fallback));

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }

  return parsed;
}

function parseStringChoice(
  name: string,
  value: string | undefined,
  fallback: string,
  choices: readonly string[],
): string {
  const parsed = (value ?? fallback).trim().toUpperCase();

  if (!choices.includes(parsed)) {
    throw new Error(`${name} must be one of: ${choices.join(", ")}`);
  }

  return parsed;
}

function parseAnswerStyle(
  value: string | undefined,
): "concise" | "standard" {
  const parsed = (value ?? "concise").trim().toLowerCase();
  if (parsed === "concise" || parsed === "standard") {
    return parsed;
  }
  throw new Error("ANSWER_STYLE must be one of: concise, standard");
}

function parseCsv(value: string | undefined, fallback: string[]): string[] {
  const source = value === undefined ? fallback.join(",") : value;
  const values = source
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (values.length === 0) {
    throw new Error("VOICE_WAKE_PHRASES must contain at least one phrase");
  }

  return Array.from(new Set(values));
}

function parseCaseOutputFormats(value: string | undefined): CaseOutputFormat[] {
  const formats = (value ?? "json,html,pdf")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const invalid = formats.filter(
    (format) => !["json", "html", "pdf"].includes(format),
  );
  if (formats.length === 0 || invalid.length > 0) {
    throw new Error(
      "CASE_OUTPUT_FORMATS must contain one or more of: json, html, pdf",
    );
  }
  return Array.from(new Set(formats)) as CaseOutputFormat[];
}

function loadConfig(): Config {
  const zoomMeetingNumber = optionalEnv("ZOOM_MEETING_NUMBER", "7467906158").replace(
    /\D/g,
    "",
  );

  if (!zoomMeetingNumber) {
    throw new Error("ZOOM_MEETING_NUMBER must contain digits");
  }

  const rtmsEnabled = parseBoolean(process.env.RTMS_ENABLED, false);
  const aiEnabled = parseBoolean(process.env.AI_ENABLED, false);
  const asrEnabled = parseBoolean(process.env.ASR_ENABLED, false);
  const meetingMinutesEnabled = parseBoolean(
    process.env.MEETING_MINUTES_ENABLED,
    false,
  );
  const voiceInvocationEnabled = parseBoolean(
    process.env.VOICE_INVOCATION_ENABLED,
    true,
  );
  const caseWorkspaceEnabled = parseBoolean(
    process.env.CASE_WORKSPACE_ENABLED,
    false,
  );
  const retrievalEnabled = parseBoolean(process.env.RETRIEVAL_ENABLED, false);
  const caseOutputEnabled = parseBoolean(process.env.CASE_OUTPUT_ENABLED, false);
  const voiceInvocationUnavailableReasons = [
    !rtmsEnabled ? "RTMS_ENABLED=false" : "",
    !aiEnabled ? "AI_ENABLED=false" : "",
    !asrEnabled ? "ASR_ENABLED=false" : "",
  ].filter(Boolean);
  const caseWorkspaceUnavailableReasons = [
    !rtmsEnabled ? "RTMS_ENABLED=false" : "",
    !aiEnabled ? "AI_ENABLED=false" : "",
    !asrEnabled ? "ASR_ENABLED=false" : "",
  ].filter(Boolean);
  const meetingMinutesUnavailableReasons = [
    !rtmsEnabled ? "RTMS_ENABLED=false" : "",
    !aiEnabled ? "AI_ENABLED=false" : "",
    !asrEnabled ? "ASR_ENABLED=false" : "",
  ].filter(Boolean);
  const vlmBaseUrl = optionalEnv(
    "VLM_BASE_URL",
    optionalEnv("LLM_BASE_URL", "http://127.0.0.1:8000/v1"),
  );
  const vlmModel = optionalEnv(
    "VLM_MODEL",
    optionalEnv("LLM_MODEL", "Qwen/Qwen3.5-4B"),
  );
  const vlmApiKey = optionalEnv("VLM_API_KEY", optionalEnv("LLM_API_KEY"));
  const answerLlmEnabled = parseBoolean(process.env.ANSWER_LLM_ENABLED, true);
  const answerLlmBaseUrl = optionalEnv(
    "ANSWER_LLM_BASE_URL",
    "http://127.0.0.1:8001/v1",
  );
  const answerLlmModel = optionalEnv(
    "ANSWER_LLM_MODEL",
    "Qwen/Qwen3-4B-Instruct-2507",
  );
  const answerLlmApiKey = optionalEnv(
    "ANSWER_LLM_API_KEY",
    optionalEnv("LLM_API_KEY"),
  );
  const screenShareCodec = parseStringChoice(
    "RTMS_SCREEN_SHARE_CODEC",
    process.env.RTMS_SCREEN_SHARE_CODEC,
    "JPG",
    ["JPG", "PNG", "H264"],
  );
  const screenShareResolution = parseStringChoice(
    "RTMS_SCREEN_SHARE_RESOLUTION",
    process.env.RTMS_SCREEN_SHARE_RESOLUTION,
    "FHD",
    ["SD", "HD", "FHD", "QHD"],
  );
  const screenShareFps = parsePositiveInteger(
    "RTMS_SCREEN_SHARE_FPS",
    process.env.RTMS_SCREEN_SHARE_FPS,
    1,
  );
  const screenShareUniqueDiffThreshold = parsePositiveNumber(
    "RTMS_SCREEN_SHARE_UNIQUE_DIFF_THRESHOLD",
    process.env.RTMS_SCREEN_SHARE_UNIQUE_DIFF_THRESHOLD,
    0.035,
  );
  const screenShareContentDiffThreshold = parsePositiveNumber(
    "RTMS_SCREEN_SHARE_CONTENT_DIFF_THRESHOLD",
    process.env.RTMS_SCREEN_SHARE_CONTENT_DIFF_THRESHOLD,
    DEFAULT_CONTENT_MEAN_ABS,
  );
  const screenShareContentChangedFrac = parsePositiveNumber(
    "RTMS_SCREEN_SHARE_CONTENT_CHANGED_FRAC",
    process.env.RTMS_SCREEN_SHARE_CONTENT_CHANGED_FRAC,
    DEFAULT_CONTENT_CHANGED_FRAC,
  );

  if ((screenShareCodec === "JPG" || screenShareCodec === "PNG") && screenShareFps > 5) {
    throw new Error("RTMS_SCREEN_SHARE_FPS must be <= 5 when using JPG or PNG");
  }

  if (screenShareCodec === "H264" && screenShareFps > 30) {
    throw new Error("RTMS_SCREEN_SHARE_FPS must be <= 30 when using H264");
  }

  if (screenShareUniqueDiffThreshold > 1) {
    throw new Error("RTMS_SCREEN_SHARE_UNIQUE_DIFF_THRESHOLD must be <= 1");
  }

  if (screenShareContentDiffThreshold > 1) {
    throw new Error("RTMS_SCREEN_SHARE_CONTENT_DIFF_THRESHOLD must be <= 1");
  }

  if (screenShareContentChangedFrac > 1) {
    throw new Error("RTMS_SCREEN_SHARE_CONTENT_CHANGED_FRAC must be <= 1");
  }

  if (rtmsEnabled) {
    requiredEnv("ZM_RTMS_CLIENT");
    requiredEnv("ZM_RTMS_SECRET");
    requiredEnv("ZOOM_WEBHOOK_SECRET_TOKEN");
  }

  return {
    port: parsePort(process.env.PORT),
    zoomClientId: requiredEnv("ZOOM_CLIENT_ID"),
    zoomClientSecret: requiredEnv("ZOOM_CLIENT_SECRET"),
    zoomMeetingNumber,
    zoomMeetingPassword: optionalEnv("ZOOM_MEETING_PASSWORD"),
    botName: optionalEnv("BOT_NAME", "ECHO AI Assistant"),
    autoJoin: parseBoolean(process.env.AUTO_JOIN, true),
    browserHeadless: parseBoolean(process.env.BROWSER_HEADLESS, false),
    browserChannel: parseBrowserChannel(process.env.BROWSER_CHANNEL),
    webBot: {
      meetingNumber: zoomMeetingNumber,
      meetingPassword: optionalEnv("ZOOM_MEETING_PASSWORD"),
      botName: optionalEnv("BOT_NAME", "ECHO AI Assistant"),
      browserHeadless: parseBoolean(process.env.BROWSER_HEADLESS, false),
      browserChannel: parseBrowserChannel(process.env.BROWSER_CHANNEL),
      webAppUrl: optionalEnv("ZOOM_WEB_APP_URL", "https://app.zoom.us/wc/join"),
      webDomain: optionalEnv("ZOOM_WEB_DOMAIN", "app.zoom.us"),
      joinTimeoutMs: parsePositiveInteger(
        "ZOOM_WEB_JOIN_TIMEOUT_MS",
        process.env.ZOOM_WEB_JOIN_TIMEOUT_MS,
        45_000,
      ),
      pollIntervalMs: parsePositiveInteger(
        "ZOOM_WEB_CHAT_POLL_INTERVAL_MS",
        process.env.ZOOM_WEB_CHAT_POLL_INTERVAL_MS,
        750,
      ),
      chatMaxChars: parsePositiveInteger(
        "ZOOM_WEB_CHAT_MAX_CHARS",
        process.env.ZOOM_WEB_CHAT_MAX_CHARS,
        900,
      ),
      fakeVideoPath: path.resolve(
        optionalEnv("ZOOM_FAKE_VIDEO_PATH", "./public/echo-logo.y4m"),
      ),
      showLogoVideo: parseBoolean(process.env.ZOOM_SHOW_LOGO_VIDEO, true),
    },
    oauthRedirectUrl: optionalEnv("ZOOM_OAUTH_REDIRECT_URL"),
    ai: {
      enabled: aiEnabled,
      dataDir: optionalEnv("RTMS_DATA_DIR", "./data/rtms"),
      asrEnabled,
      asrServiceUrl: optionalEnv("ASR_SERVICE_URL", "http://127.0.0.1:7001"),
      asrChunkSeconds: parsePositiveInteger(
        "ASR_CHUNK_SECONDS",
        process.env.ASR_CHUNK_SECONDS,
        5,
      ),
      asrOverlapSeconds: parseNonNegativeInteger(
        "ASR_OVERLAP_SECONDS",
        process.env.ASR_OVERLAP_SECONDS,
        1,
      ),
      asrSpeechRmsThreshold: parsePositiveNumber(
        "ASR_SPEECH_RMS_THRESHOLD",
        process.env.ASR_SPEECH_RMS_THRESHOLD,
        200,
      ),
      asrSpeechPrerollMs: parseNonNegativeInteger(
        "ASR_SPEECH_PREROLL_MS",
        process.env.ASR_SPEECH_PREROLL_MS,
        250,
      ),
      vlmBaseUrl,
      vlmModel,
      vlmApiKey,
      vlmMaxTokens: parsePositiveInteger(
        "VLM_MAX_TOKENS",
        process.env.VLM_MAX_TOKENS,
        512,
      ),
      ragVlmMaxTokens: parsePositiveInteger(
        "AI_RAG_VLM_MAX_TOKENS",
        process.env.AI_RAG_VLM_MAX_TOKENS,
        768,
      ),
      vlmEnableThinking: parseBoolean(
        process.env.VLM_ENABLE_THINKING,
        false,
      ),
      vlmMultimodal: parseBoolean(
        process.env.VLM_MULTIMODAL,
        /vl|vision/i.test(vlmModel),
      ),
      botName: optionalEnv("BOT_NAME", "ECHO AI Assistant"),
      answerLlmEnabled,
      answerLlmBaseUrl,
      answerLlmModel,
      answerLlmApiKey,
      answerLlmMaxTokens: parsePositiveInteger(
        "ANSWER_LLM_MAX_TOKENS",
        process.env.ANSWER_LLM_MAX_TOKENS ?? process.env.AI_ANSWER_MAX_TOKENS,
        120,
      ),
      answerLlmMaxChars: parsePositiveInteger(
        "ANSWER_LLM_MAX_CHARS",
        process.env.ANSWER_LLM_MAX_CHARS ?? process.env.AI_ANSWER_MAX_CHARS,
        parseBoolean(process.env.ECHO_QUIET_REPLIES, false) ? 280 : 450,
      ),
      ragAnswerLlmMaxTokens: parsePositiveInteger(
        "AI_RAG_ANSWER_MAX_TOKENS",
        process.env.AI_RAG_ANSWER_MAX_TOKENS,
        160,
      ),
      ragAnswerLlmMaxChars: parsePositiveInteger(
        "AI_RAG_ANSWER_MAX_CHARS",
        process.env.AI_RAG_ANSWER_MAX_CHARS,
        600,
      ),
      literatureAnswerMaxTokens: parsePositiveInteger(
        "AI_LITERATURE_ANSWER_MAX_TOKENS",
        process.env.AI_LITERATURE_ANSWER_MAX_TOKENS,
        220,
      ),
      literatureAnswerMaxChars: parsePositiveInteger(
        "AI_LITERATURE_ANSWER_MAX_CHARS",
        process.env.AI_LITERATURE_ANSWER_MAX_CHARS,
        900,
      ),
      answerStyle: parseBoolean(process.env.ECHO_QUIET_REPLIES, false)
        ? "concise"
        : parseAnswerStyle(process.env.ANSWER_STYLE),
      answerLlmEnableThinking: parseBoolean(
        process.env.ANSWER_LLM_ENABLE_THINKING,
        false,
      ),
      contextMode: optionalEnv("MEETING_CONTEXT_MODE", "full-with-summary-fallback"),
      screenShareEnabled: parseBoolean(process.env.AI_SCREEN_SHARE_ENABLED, true),
      noFrameFixedReply: parseBoolean(
        process.env.ECHO_NO_FRAME_FIXED_REPLY,
        true,
      ),
      speechRecallWithholdFrames: parseBoolean(
        process.env.ECHO_SPEECH_RECALL_WITHHOLD_FRAMES,
        true,
      ),
      facilitatorOnly: parseBoolean(process.env.ECHO_FACILITATOR_ONLY, false),
      allowedAskers: (process.env.ECHO_ALLOWED_ASKERS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      screenShareMaxImages: parseNonNegativeInteger(
        "AI_SCREEN_SHARE_MAX_IMAGES",
        process.env.AI_SCREEN_SHARE_MAX_IMAGES,
        3,
      ),
      screenShareMemoryLimit: parsePositiveInteger(
        "AI_SCREEN_SHARE_MEMORY_LIMIT",
        process.env.AI_SCREEN_SHARE_MEMORY_LIMIT,
        200,
      ),
      screenShareMaxImageBytes: parsePositiveInteger(
        "AI_SCREEN_SHARE_MAX_IMAGE_BYTES",
        process.env.AI_SCREEN_SHARE_MAX_IMAGE_BYTES,
        2_500_000,
      ),
      fullContextMaxChars: parsePositiveInteger(
        "AI_FULL_CONTEXT_MAX_CHARS",
        process.env.AI_FULL_CONTEXT_MAX_CHARS,
        20_000,
      ),
      recentContextMaxChars: parsePositiveInteger(
        "AI_RECENT_CONTEXT_MAX_CHARS",
        process.env.AI_RECENT_CONTEXT_MAX_CHARS,
        6_000,
      ),
      relevantContextMaxChars: parsePositiveInteger(
        "AI_RELEVANT_CONTEXT_MAX_CHARS",
        process.env.AI_RELEVANT_CONTEXT_MAX_CHARS,
        6_000,
      ),
      summaryUpdateSeconds: parsePositiveInteger(
        "AI_SUMMARY_UPDATE_SECONDS",
        process.env.AI_SUMMARY_UPDATE_SECONDS,
        60,
      ),
      summaryUpdateChars: parsePositiveInteger(
        "AI_SUMMARY_UPDATE_CHARS",
        process.env.AI_SUMMARY_UPDATE_CHARS,
        1_500,
      ),
      asrIdleFlushMs: parsePositiveInteger(
        "ASR_IDLE_FLUSH_MS",
        process.env.ASR_IDLE_FLUSH_MS,
        900,
      ),
      voiceInvocationEnabled,
      voiceInvocationAvailable:
        voiceInvocationEnabled && voiceInvocationUnavailableReasons.length === 0,
      voiceInvocationUnavailableReasons,
      voiceWakePhrases: parseCsv(process.env.VOICE_WAKE_PHRASES, [
        "hello echo ai assistant",
        "hello echo ai",
        "hi echo ai assistant",
        "hi echo ai",
      ]),
      voiceFollowupTimeoutMs: parsePositiveInteger(
        "VOICE_FOLLOWUP_TIMEOUT_MS",
        process.env.VOICE_FOLLOWUP_TIMEOUT_MS,
        12_000,
      ),
      voiceMaxQuestionMs: parsePositiveInteger(
        "VOICE_MAX_QUESTION_MS",
        process.env.VOICE_MAX_QUESTION_MS,
        30_000,
      ),
      voiceMaxQuestionChars: parsePositiveInteger(
        "VOICE_MAX_QUESTION_CHARS",
        process.env.VOICE_MAX_QUESTION_CHARS,
        1_000,
      ),
      voiceCooldownMs: parsePositiveInteger(
        "VOICE_COOLDOWN_MS",
        process.env.VOICE_COOLDOWN_MS,
        5_000,
      ),
    },
    meetingMinutes: {
      enabled: meetingMinutesEnabled,
      available:
        meetingMinutesEnabled && meetingMinutesUnavailableReasons.length === 0,
      unavailableReasons: meetingMinutesUnavailableReasons,
      dataDir: optionalEnv(
        "MEETING_MINUTES_DATA_DIR",
        path.join(optionalEnv("RTMS_DATA_DIR", "./data/rtms"), "minutes"),
      ),
      textBaseUrl: answerLlmEnabled ? answerLlmBaseUrl : vlmBaseUrl,
      textModel: answerLlmEnabled ? answerLlmModel : vlmModel,
      textApiKey: answerLlmEnabled ? answerLlmApiKey : vlmApiKey,
      textEnableThinking: answerLlmEnabled
        ? parseBoolean(process.env.ANSWER_LLM_ENABLE_THINKING, false)
        : parseBoolean(process.env.VLM_ENABLE_THINKING, false),
      maxTranscriptChars: parsePositiveInteger(
        "MEETING_MINUTES_MAX_TRANSCRIPT_CHARS",
        process.env.MEETING_MINUTES_MAX_TRANSCRIPT_CHARS,
        60_000,
      ),
      summaryMaxTokens: parsePositiveInteger(
        "MEETING_MINUTES_SUMMARY_MAX_TOKENS",
        process.env.MEETING_MINUTES_SUMMARY_MAX_TOKENS,
        1_200,
      ),
      maxSlides: parseNonNegativeInteger(
        "MEETING_MINUTES_MAX_SLIDES",
        process.env.MEETING_MINUTES_MAX_SLIDES,
        200,
      ),
      maxQaPairs: parseNonNegativeInteger(
        "MEETING_MINUTES_MAX_QA_PAIRS",
        process.env.MEETING_MINUTES_MAX_QA_PAIRS,
        100,
      ),
      llmTimeoutMs: parsePositiveInteger(
        "MEETING_MINUTES_LLM_TIMEOUT_MS",
        process.env.MEETING_MINUTES_LLM_TIMEOUT_MS,
        60_000,
      ),
    },
    caseWorkspace: {
      enabled: caseWorkspaceEnabled,
      available:
        caseWorkspaceEnabled && caseWorkspaceUnavailableReasons.length === 0,
      unavailableReasons: caseWorkspaceUnavailableReasons,
      host: parseLoopbackHost(process.env.CASE_WORKSPACE_HOST),
      port: parsePort(process.env.CASE_WORKSPACE_PORT ?? "3001"),
      dataDir: optionalEnv(
        "CASE_WORKSPACE_DATA_DIR",
        path.join(optionalEnv("RTMS_DATA_DIR", "./data/rtms"), "cases"),
      ),
      rtmsDataDir: optionalEnv("RTMS_DATA_DIR", "./data/rtms"),
      transcriptChunkChars: parsePositiveInteger(
        "CASE_WORKSPACE_TRANSCRIPT_CHUNK_CHARS",
        process.env.CASE_WORKSPACE_TRANSCRIPT_CHUNK_CHARS,
        8_000,
      ),
      maxScreenFrames: parsePositiveInteger(
        "CASE_WORKSPACE_MAX_SCREEN_FRAMES",
        process.env.CASE_WORKSPACE_MAX_SCREEN_FRAMES,
        30,
      ),
      jsonRepairAttempts: parseNonNegativeInteger(
        "CASE_WORKSPACE_JSON_REPAIR_ATTEMPTS",
        process.env.CASE_WORKSPACE_JSON_REPAIR_ATTEMPTS,
        2,
      ),
      textBaseUrl: answerLlmEnabled ? answerLlmBaseUrl : vlmBaseUrl,
      textModel: answerLlmEnabled ? answerLlmModel : vlmModel,
      textApiKey: answerLlmEnabled ? answerLlmApiKey : vlmApiKey,
      vlmBaseUrl,
      vlmModel,
      vlmApiKey,
      maxImageBytes: parsePositiveInteger(
        "AI_SCREEN_SHARE_MAX_IMAGE_BYTES",
        process.env.AI_SCREEN_SHARE_MAX_IMAGE_BYTES,
        2_500_000,
      ),
    },
    caseOutput: {
      enabled: caseOutputEnabled,
      available: caseOutputEnabled && caseWorkspaceEnabled,
      unavailableReasons: [
        caseOutputEnabled && !caseWorkspaceEnabled
          ? "CASE_WORKSPACE_ENABLED=false"
          : "",
      ].filter(Boolean),
      caseDataDir: optionalEnv(
        "CASE_WORKSPACE_DATA_DIR",
        path.join(optionalEnv("RTMS_DATA_DIR", "./data/rtms"), "cases"),
      ),
      formats: parseCaseOutputFormats(process.env.CASE_OUTPUT_FORMATS),
      templateVersion: (() => {
        const version = optionalEnv(
          "CASE_OUTPUT_TEMPLATE_VERSION",
          "echo-clinical-v1",
        );
        if (version !== "echo-clinical-v1") {
          throw new Error(
            "CASE_OUTPUT_TEMPLATE_VERSION must be echo-clinical-v1",
          );
        }
        return "echo-clinical-v1" as const;
      })(),
      language: (() => {
        const language = optionalEnv("CASE_OUTPUT_LANGUAGE", "en");
        if (language !== "en") {
          throw new Error("CASE_OUTPUT_LANGUAGE must be en");
        }
        return "en" as const;
      })(),
      pdfTimeoutMs: parsePositiveInteger(
        "CASE_OUTPUT_PDF_TIMEOUT_MS",
        process.env.CASE_OUTPUT_PDF_TIMEOUT_MS,
        30_000,
      ),
      maxConcurrent: parsePositiveInteger(
        "CASE_OUTPUT_MAX_CONCURRENT",
        process.env.CASE_OUTPUT_MAX_CONCURRENT,
        1,
      ),
    },
    retrieval: {
      enabled: retrievalEnabled,
      historicalCasesEnabled: parseBoolean(
        process.env.HISTORICAL_CASE_RETRIEVAL_ENABLED,
        true,
      ),
      pubmedEnabled: parseBoolean(process.env.PUBMED_RETRIEVAL_ENABLED, true),
      dataDir: optionalEnv("RETRIEVAL_DATA_DIR", "./data/retrieval"),
      caseDataDir: optionalEnv(
        "CASE_WORKSPACE_DATA_DIR",
        path.join(optionalEnv("RTMS_DATA_DIR", "./data/rtms"), "cases"),
      ),
      embeddingBaseUrl: optionalEnv(
        "EMBEDDING_BASE_URL",
        "http://127.0.0.1:8002/v1",
      ),
      embeddingModel: optionalEnv("EMBEDDING_MODEL", "BAAI/bge-m3"),
      embeddingApiKey: optionalEnv("EMBEDDING_API_KEY"),
      embeddingGpu: parseNonNegativeInteger(
        "EMBEDDING_GPU",
        process.env.EMBEDDING_GPU,
        4,
      ),
      caseCandidates: parsePositiveInteger(
        "RETRIEVAL_CASE_CANDIDATES",
        process.env.RETRIEVAL_CASE_CANDIDATES,
        12,
      ),
      caseTopK: parsePositiveInteger(
        "RETRIEVAL_CASE_TOP_K",
        process.env.RETRIEVAL_CASE_TOP_K,
        5,
      ),
      privateRagEnabled: parseBoolean(
        process.env.PRIVATE_RAG_RETRIEVAL_ENABLED,
        false,
      ),
      privateRagDbDir: optionalEnv("PRIVATE_RAG_DB_DIR", "./data/private_db"),
      privateRagBm25K: parsePositiveInteger(
        "PRIVATE_RAG_BM25_K",
        process.env.PRIVATE_RAG_BM25_K,
        100,
      ),
      privateRagTopK: parsePositiveInteger(
        "PRIVATE_RAG_EMBEDDING_K",
        process.env.PRIVATE_RAG_EMBEDDING_K,
        10,
      ),
      privateRagBlend: parseBoolean(process.env.PRIVATE_RAG_BLEND, false),
      privateRagSemanticWeight: (() => {
        const value = parsePositiveNumber(
          "PRIVATE_RAG_SEMANTIC_WEIGHT",
          process.env.PRIVATE_RAG_SEMANTIC_WEIGHT,
          0.8,
        );
        if (value > 1) {
          throw new Error("PRIVATE_RAG_SEMANTIC_WEIGHT must be <= 1");
        }
        return value;
      })(),
      privateRagAlwaysOn: parseBoolean(
        process.env.PRIVATE_RAG_ALWAYS_ON,
        false,
      ),
      privateRagMaxExcerptChars: parsePositiveInteger(
        "PRIVATE_RAG_MAX_EXCERPT_CHARS",
        process.env.PRIVATE_RAG_MAX_EXCERPT_CHARS,
        900,
      ),
      pubmedEmail: optionalEnv("PUBMED_EMAIL"),
      pubmedApiKey: optionalEnv("PUBMED_API_KEY"),
      pubmedTool: optionalEnv("PUBMED_TOOL", "echo-ai-assistant"),
      pubmedBestMatchCount: parsePositiveInteger(
        "PUBMED_BEST_MATCH_COUNT",
        process.env.PUBMED_BEST_MATCH_COUNT,
        10,
      ),
      pubmedRecentCount: parsePositiveInteger(
        "PUBMED_RECENT_COUNT",
        process.env.PUBMED_RECENT_COUNT,
        10,
      ),
      pubmedRecentYears: parsePositiveInteger(
        "PUBMED_RECENT_YEARS",
        process.env.PUBMED_RECENT_YEARS,
        5,
      ),
      pubmedFinalCount: parsePositiveInteger(
        "PUBMED_FINAL_COUNT",
        process.env.PUBMED_FINAL_COUNT,
        5,
      ),
      pubmedQueryConcepts: parsePositiveInteger(
        "PUBMED_QUERY_CONCEPTS",
        process.env.PUBMED_QUERY_CONCEPTS,
        6,
      ),
      pubmedRerankTimeoutMs: parsePositiveInteger(
        "PUBMED_RERANK_TIMEOUT_MS",
        process.env.PUBMED_RERANK_TIMEOUT_MS,
        2_500,
      ),
      pubmedRerankAbstractChars: parsePositiveInteger(
        "PUBMED_RERANK_ABSTRACT_CHARS",
        process.env.PUBMED_RERANK_ABSTRACT_CHARS,
        1_200,
      ),
      pubmedCacheTtlSeconds: parsePositiveInteger(
        "PUBMED_CACHE_TTL_SECONDS",
        process.env.PUBMED_CACHE_TTL_SECONDS,
        86_400,
      ),
      sourceTimeoutMs: parsePositiveInteger(
        "RETRIEVAL_SOURCE_TIMEOUT_MS",
        process.env.RETRIEVAL_SOURCE_TIMEOUT_MS,
        20_000,
      ),
      totalTimeoutMs: parsePositiveInteger(
        "RETRIEVAL_TOTAL_TIMEOUT_MS",
        process.env.RETRIEVAL_TOTAL_TIMEOUT_MS,
        23_000,
      ),
      textBaseUrl: answerLlmEnabled ? answerLlmBaseUrl : vlmBaseUrl,
      textModel: answerLlmEnabled ? answerLlmModel : vlmModel,
      textApiKey: answerLlmEnabled ? answerLlmApiKey : vlmApiKey,
    },
    rtms: {
      enabled: rtmsEnabled,
      webhookPath: optionalEnv("RTMS_WEBHOOK_PATH", "/zoom/webhooks"),
      dataDir: optionalEnv("RTMS_DATA_DIR", "./data/rtms"),
      transcriptEnabled: parseBoolean(process.env.RTMS_TRANSCRIPT_ENABLED, true),
      transcriptMemoryLimit: parsePositiveInteger(
        "RTMS_TRANSCRIPT_MEMORY_LIMIT",
        process.env.RTMS_TRANSCRIPT_MEMORY_LIMIT,
        500,
      ),
      audioPersist: parseBoolean(process.env.RTMS_AUDIO_PERSIST, true),
      audioMaxBytesPerStream: parsePositiveInteger(
        "RTMS_AUDIO_MAX_BYTES_PER_STREAM",
        process.env.RTMS_AUDIO_MAX_BYTES_PER_STREAM,
        104_857_600,
      ),
      audioFlushIntervalMs: parsePositiveInteger(
        "RTMS_AUDIO_FLUSH_INTERVAL_MS",
        process.env.RTMS_AUDIO_FLUSH_INTERVAL_MS,
        1_000,
      ),
      screenShareEnabled: parseBoolean(process.env.RTMS_SCREEN_SHARE_ENABLED, true),
      screenShareCodec,
      screenShareResolution,
      screenShareFps,
      screenShareMaxBytesPerStream: parsePositiveInteger(
        "RTMS_SCREEN_SHARE_MAX_BYTES_PER_STREAM",
        process.env.RTMS_SCREEN_SHARE_MAX_BYTES_PER_STREAM,
        524_288_000,
      ),
      screenShareStoreAllFrames: parseBoolean(
        process.env.RTMS_SCREEN_SHARE_STORE_ALL_FRAMES,
        false,
      ),
      screenShareUniqueDiffThreshold,
      screenShareContentDiffThreshold,
      screenShareContentChangedFrac,
      webhookSecretToken: optionalEnv("ZOOM_WEBHOOK_SECRET_TOKEN"),
    },
  };
}

const config = loadConfig();
const app = express();

app.use(cors());

function safeClone(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}

function setState(nextState: ZoomState, error?: unknown): void {
  zoomState = nextState;

  if (error) {
    lastError = errorMessage(error);
  } else if (nextState !== "error") {
    lastError = null;
  }
}

function emitEvent(type: string, payload: unknown = {}): BotEvent {
  const event: BotEvent = {
    id: ++eventId,
    type,
    payload: safeClone(payload),
    state: zoomState,
    createdAt: new Date().toISOString(),
  };

  recentEvents.push(event);
  if (recentEvents.length > 200) {
    recentEvents.shift();
  }

  const encoded = `id: ${event.id}\nevent: ${type}\ndata: ${JSON.stringify(
    event,
  )}\n\n`;

  for (const client of sseClients) {
    client.write(encoded);
  }

  console.log(`[${event.createdAt}] ${type}`, JSON.stringify(event.payload));
  return event;
}

const webBot = new ZoomWebBot(config.webBot, handleBotEvent, setState);
const aiManager = new MeetingAiManager(config.ai, emitEvent, sendBotChat);
const meetingMinutesManager = new MeetingMinutesManager(
  config.meetingMinutes,
  emitEvent,
  async (streamId) => {
    const source = aiManager.caseSource(streamId);
    if (!source) {
      return null;
    }

    return {
      ...source,
      qaPairs: await aiManager.qaHistory(streamId),
    };
  },
);
const caseWorkspaceManager = new CaseWorkspaceManager(
  config.caseWorkspace,
  emitEvent,
  async (
    streamId,
    caseId,
    meetingUuid,
    meetingStartedAt,
    meetingEndedAt,
  ): Promise<CaseSourceSnapshot | null> => {
    const source = aiManager.caseSource(streamId);
    if (!source) {
      return null;
    }
    const timestamps = [
      ...source.segments.flatMap((segment) => [
        segment.startTimestamp,
        segment.endTimestamp,
      ]),
      ...source.screenShareFrames.map((frame) => frame.timestamp),
    ].filter((value) => Number.isFinite(value) && value > 0);
    const safeStreamId =
      String(streamId).replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";

    return {
      schemaVersion: 1,
      caseId,
      streamId,
      meetingUuid: meetingUuid ?? source.meetingUuid,
      capturedAt: new Date().toISOString(),
      meetingStartedAt:
        meetingStartedAt ??
        (timestamps.length > 0
          ? new Date(Math.min(...timestamps)).toISOString()
          : null),
      meetingEndedAt:
        meetingEndedAt ??
        (timestamps.length > 0
          ? new Date(Math.max(...timestamps)).toISOString()
          : null),
      asrPath: path.join(config.ai.dataDir, "asr", `${safeStreamId}.ndjson`),
      screenMetadataPath: path.join(
        config.ai.dataDir,
        "screenshare",
        safeStreamId,
        "unique",
        "unique_metadata.ndjson",
      ),
      segments: source.segments,
      frames: source.screenShareFrames,
      sourceWarnings: [],
    };
  },
);
const retrievalManager = new RetrievalManager(
  config.retrieval,
  emitEvent,
  {
    get: (caseId) => caseWorkspaceManager.get(caseId),
  },
);
const caseOutputManager = new CaseOutputManager(
  config.caseOutput,
  emitEvent,
  {
    get: (caseId) => caseWorkspaceManager.get(caseId),
    revision: (caseId, revisionId) =>
      caseWorkspaceManager.revision(caseId, revisionId),
  },
  {
    recordsForCase: (caseId) => retrievalManager.recordsForCase(caseId),
  },
);
caseWorkspaceManager.setRetrievalService(retrievalManager);
caseWorkspaceManager.setOutputService(caseOutputManager);
retrievalManager.setOutputService(caseOutputManager);
aiManager.setEvidenceRetriever(retrievalManager);
const rtmsManager = new RtmsManager(config.rtms, emitEvent, {
  onAudioData: (event) => {
    aiManager.ingestAudioChunk(event);
  },
  onScreenShareFrame: (event) => {
    aiManager.ingestScreenShareFrame(event);
  },
  onSessionClosed: async (event) => {
    await aiManager.flushStream(event.streamId);
    await aiManager.waitForQaIdle();
    const minutes = await meetingMinutesManager.handleSessionClosed({
      streamId: event.streamId,
      meetingUuid: event.meetingUuid,
      startedAt: event.startedAt,
      closedAt: event.closedAt,
      reason: event.reason,
    });
    if (minutes) {
      await emitMinutesReady(minutes);
    }
    await caseWorkspaceManager.handleSessionClosed({
      streamId: event.streamId,
      meetingUuid: event.meetingUuid,
      startedAt: event.startedAt,
      closedAt: event.closedAt,
      reason: event.reason,
    });
  },
});

function createSignature(): string {
  const iat = Math.floor(Date.now() / 1000) - 30;
  const exp = iat + 60 * 60 * 2;

  return jwt.sign(
    {
      appKey: config.zoomClientId,
      mn: config.zoomMeetingNumber,
      role: 0,
      iat,
      exp,
      tokenExp: exp,
    },
    config.zoomClientSecret,
    {
      algorithm: "HS256",
      header: {
        alg: "HS256",
        typ: "JWT",
      },
    },
  );
}

const demoReplayEnabled = parseBoolean(process.env.DEMO_REPLAY_ENABLED, false);
const demoReplayRoot = path.resolve(
  process.env.DEMO_REPLAY_DIR?.trim() || "./demo_replay",
);

function healthPayload() {
  const botHealth = webBot.health();
  return {
    ok: true,
    state: zoomState,
    transport: botHealth.transport,
    meetingNumber: config.zoomMeetingNumber,
    botName: config.botName,
    autoJoin: config.autoJoin,
    browserConnected: botHealth.browserConnected,
    pageOpen: botHealth.pageOpen,
    webBot: botHealth,
    lastJoinStartedAt,
    lastJoinedAt,
    lastError,
    uptimeSeconds: Math.round(process.uptime()),
    oauth: publicOAuthState(oauthState),
    ai: aiManager.health(),
    meetingMinutes: meetingMinutesManager.health(),
    caseWorkspace: caseWorkspaceManager.health(),
    caseOutput: caseOutputManager.health(),
    retrieval: retrievalManager.health(),
    rtms: rtmsManager.health(),
    demoReplay: {
      enabled: demoReplayEnabled,
      root: demoReplayRoot,
    },
  };
}

function requireDemoReplay(_req: Request, res: Response): boolean {
  if (demoReplayEnabled) {
    return true;
  }
  res.status(403).json({
    ok: false,
    error:
      "Synthetic media replay is disabled. Set DEMO_REPLAY_ENABLED=true in the meeting package .env.",
  });
  return false;
}

function resolveDemoReplayFile(inputPath: string): string | null {
  const resolved = path.resolve(inputPath);
  const allowedRoots = [
    demoReplayRoot,
    path.resolve(optionalEnv("RTMS_DATA_DIR", "./data/rtms")),
    path.resolve("./echo-screens"),
    path.resolve("../echo-screens"),
  ];
  const ok = allowedRoots.some(
    (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`),
  );
  if (!ok || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return null;
  }
  return resolved;
}

function headerValue(req: Request, name: string): string {
  const value = req.headers[name.toLowerCase()];

  if (Array.isArray(value)) {
    return value[0] ?? "";
  }

  return value ?? "";
}

function rawBodyText(req: Request): string {
  if (Buffer.isBuffer(req.body)) {
    return req.body.toString("utf8");
  }

  if (typeof req.body === "string") {
    return req.body;
  }

  return JSON.stringify(req.body ?? {});
}

function createValidationToken(plainToken: string): string {
  return crypto
    .createHmac("sha256", config.rtms.webhookSecretToken)
    .update(plainToken)
    .digest("hex");
}

function requestBaseUrl(req: Request): string {
  const protocol = headerValue(req, "x-forwarded-proto") || req.protocol || "http";
  const host = headerValue(req, "x-forwarded-host") || headerValue(req, "host");

  return `${protocol}://${host}`;
}

function oauthRedirectUrl(req: Request): string {
  return config.oauthRedirectUrl || `${requestBaseUrl(req)}/oauth/callback`;
}

async function exchangeOAuthCode(code: string, redirectUri: string): Promise<OAuthState> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  const basicAuth = Buffer.from(
    `${config.zoomClientId}:${config.zoomClientSecret}`,
  ).toString("base64");
  const response = await fetch("https://zoom.us/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const responseBody = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
    reason?: string;
    error?: string;
  };

  if (!response.ok) {
    throw new Error(
      responseBody.reason ||
        responseBody.error ||
        `Zoom OAuth token exchange failed with HTTP ${response.status}`,
    );
  }

  const exchangedAt = new Date();
  const expiresAt =
    typeof responseBody.expires_in === "number"
      ? new Date(exchangedAt.getTime() + responseBody.expires_in * 1000).toISOString()
      : null;

  return {
    installed: Boolean(responseBody.access_token),
    lastCallbackAt: oauthState.lastCallbackAt,
    lastTokenExchangeAt: exchangedAt.toISOString(),
    lastError: null,
    tokenType: responseBody.token_type ?? null,
    scope: responseBody.scope ?? null,
    expiresAt,
    accessToken: responseBody.access_token ?? null,
    refreshToken: responseBody.refresh_token ?? null,
  };
}

async function ensureOAuthAccessToken(): Promise<string> {
  if (!oauthState.accessToken) {
    throw new Error("Zoom OAuth is not installed; authorize the app first");
  }

  const expiresAtMs = oauthState.expiresAt
    ? Date.parse(oauthState.expiresAt)
    : Number.NaN;
  const stale =
    Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now() + 60_000;

  if (!stale) {
    return oauthState.accessToken;
  }

  if (!oauthState.refreshToken) {
    throw new Error("Zoom OAuth access token expired and no refresh token is available");
  }

  const refreshed = await refreshOAuthAccessToken(
    config.zoomClientId,
    config.zoomClientSecret,
    oauthState.refreshToken,
  );
  oauthState = {
    ...oauthState,
    installed: true,
    lastTokenExchangeAt: new Date().toISOString(),
    lastError: null,
    tokenType: refreshed.tokenType,
    scope: refreshed.scope ?? oauthState.scope,
    expiresAt: refreshed.expiresAt,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
  };
  saveOAuthState(oauthState);
  emitEvent("oauth-refreshed", {
    expiresAt: oauthState.expiresAt,
    scope: oauthState.scope,
  });
  return refreshed.accessToken;
}

function oauthAuthorizeUrl(req: Request): string {
  const redirectUri = encodeURIComponent(oauthRedirectUrl(req));
  const scopes = encodeURIComponent(
    [
      "user:read:zak",
      "user:read:token",
      "meeting:read:meeting",
      "meeting:read:meeting_screenshare",
      "meeting:read:meeting_audio",
      "meeting:read:meeting_transcript",
      "meeting:read:meeting_video",
      "zoomapp:inmeeting",
      "rtms:read:rtms_started",
      "rtms:read:rtms_stopped",
      // Needed for PATCH /v2/live_meetings/{id}/rtms_app/status (backend RTMS start).
      "meeting:update:participant_rtms_app_status",
      "meeting:update:participant_rtms_app_status:admin",
    ].join(" "),
  );
  return (
    `https://zoom.us/oauth/authorize?response_type=code` +
    `&client_id=${encodeURIComponent(config.zoomClientId)}` +
    `&redirect_uri=${redirectUri}` +
    `&scope=${scopes}`
  );
}

function verifyZoomWebhookSignature(req: Request, body: string): {
  ok: boolean;
  reason?: string;
} {
  const timestamp = headerValue(req, "x-zm-request-timestamp");
  const receivedSignature = headerValue(req, "x-zm-signature");

  if (!timestamp || !receivedSignature) {
    return { ok: false, reason: "Missing x-zm-request-timestamp or x-zm-signature" };
  }

  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (
    !Number.isFinite(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) > 5 * 60
  ) {
    return { ok: false, reason: "Webhook timestamp is outside the 5 minute tolerance" };
  }

  const message = `v0:${timestamp}:${body}`;
  const expectedSignature = `v0=${crypto
    .createHmac("sha256", config.rtms.webhookSecretToken)
    .update(message)
    .digest("hex")}`;
  const expected = Buffer.from(expectedSignature);
  const received = Buffer.from(receivedSignature);

  if (expected.length !== received.length) {
    return { ok: false, reason: "Webhook signature length does not match" };
  }

  if (!crypto.timingSafeEqual(expected, received)) {
    return { ok: false, reason: "Webhook signature does not match" };
  }

  return { ok: true };
}

async function closeCurrentPage(): Promise<void> {
  if (page && !page.isClosed()) {
    await page.close({ runBeforeUnload: true }).catch(() => undefined);
  }

  page = null;

  if (context) {
    await context.close().catch(() => undefined);
    context = null;
  }
}

async function emitMinutesReady(
  manifest: NonNullable<Awaited<ReturnType<typeof meetingMinutesManager.handleSessionClosed>>>,
): Promise<void> {
  emitEvent("meeting-minutes-ready", {
    streamId: manifest.streamId,
    outputDir: manifest.outputDir,
    summaryMarkdown: manifest.files.summaryMarkdown,
    downloadPath: "/meeting-minutes/summary.md",
    // Post-session summaries stay outside Zoom chat (disk + HTTP only).
  });
}

async function maybeGenerateMinutesOnLeave(reason: string): Promise<void> {
  if (!config.meetingMinutes.enabled) {
    return;
  }
  const aiHealth = aiManager.health();
  const streamId = aiHealth.latestStreamId;
  if (!streamId) {
    emitEvent("meeting-minutes-skipped", {
      reason: "no-stream-on-leave",
      closeReason: reason,
    });
    return;
  }
  const memory = aiHealth.memories.find((item) => item.streamId === streamId);
  try {
    await aiManager.flushStream(streamId).catch(() => undefined);
    await aiManager.waitForQaIdle();
    const manifest = await meetingMinutesManager.handleSessionClosed({
      streamId,
      meetingUuid: memory?.meetingUuid ?? null,
      startedAt: null,
      closedAt: new Date().toISOString(),
      reason,
    });
    if (manifest) {
      await emitMinutesReady(manifest);
    }
  } catch (error) {
    emitEvent("meeting-minutes-error", {
      streamId,
      reason,
      message: errorMessage(error),
    });
  }
}

async function leaveBot(): Promise<unknown> {
  emitEvent("leave-requested", { transport: "zoom-web-app" });
  const result = await webBot.leave();
  // Also tear down any leftover Meeting-SDK Playwright page from older joins.
  await closeCurrentPage().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  browser = null;
  context = null;
  page = null;
  // Always try post-session minutes outside chat when the bot leaves
  // (RTMS close alone can be late or missing).
  await maybeGenerateMinutesOnLeave("bot-leave").catch(() => undefined);
  return result;
}

async function joinBot(force = false): Promise<unknown> {
  if (joinInFlight) {
    return joinInFlight;
  }

  joinInFlight = (async () => {
    lastJoinStartedAt = new Date().toISOString();
    emitEvent("join-requested", { force, transport: "zoom-web-app" });
    await webBot.join(force);
    return healthPayload();
  })().finally(() => {
    joinInFlight = null;
  });

  return joinInFlight;
}

async function sendBotChat(
  message: string,
  userId?: number,
  replyTarget?: ZoomWebChatReplyTarget,
): Promise<unknown> {
  // Text nested replies must go through the Zoom Web App composer so they can
  // attach under the source message. Linux control chat is public-only.
  const linuxChatUrl = (process.env.LINUX_CHAT_URL ?? "").trim();
  if (linuxChatUrl && !replyTarget) {
    const response = await fetch(linuxChatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, userId: userId ?? null }),
    });
    const text = await response.text();
    let result: unknown = text;
    try {
      result = JSON.parse(text);
    } catch {
      // keep raw text
    }
    if (!response.ok) {
      throw new Error(
        `LINUX_CHAT_URL send failed: HTTP ${response.status} ${text.slice(0, 200)}`,
      );
    }
    emitEvent("chat-send-requested", {
      message,
      userId,
      via: "linux-control",
      result,
    });
    return result;
  }

  const result = await webBot.sendChat(message, userId, replyTarget);
  emitEvent("chat-send-requested", {
    message,
    userId,
    replyToMessageId: replyTarget?.messageId,
    result,
  });
  return result;
}

function handleBotEvent(type: string, payload: unknown = {}): void {
  if (type === "bot-user") {
    botParticipant = payload as ChatParticipant;
  }

  if (type === "joined") {
    setState("joined");
    lastJoinedAt = new Date().toISOString();
  } else if (type === "waiting-room") {
    setState("waiting-room");
  } else if (type === "error") {
    setState("error", payload);
  } else if (type === "connection-change") {
    const connectionState = (payload as { state?: string } | undefined)?.state;

    if (connectionState === "Connected") {
      setState("joined");
      lastJoinedAt = lastJoinedAt ?? new Date().toISOString();
    } else if (connectionState === "Closed") {
      setState("closed");
    }
  }

  emitEvent(type, payload);
  if (type === "chat-on-message") {
    const question = aiQuestionFromChat(payload);
    if (question) {
      aiManager.enqueueQuestion(question);
    }
  }
}

function normalizeParticipantText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function chatMessageText(payload: ChatPayload): string {
  if (Array.isArray(payload.message)) {
    return payload.message.join(" ");
  }

  return payload.message ?? "";
}

function sameParticipant(left?: ChatParticipant, right?: ChatParticipant | null): boolean {
  if (!left || !right) {
    return false;
  }

  if (
    typeof left.userId === "number" &&
    typeof right.userId === "number" &&
    left.userId === right.userId
  ) {
    return true;
  }

  return Boolean(
    left.name &&
      right.name &&
      normalizeParticipantText(left.name) === normalizeParticipantText(right.name),
  );
}

function isFromBot(payload: ChatPayload): boolean {
  if (sameParticipant(payload.sender, botParticipant)) {
    return true;
  }

  return Boolean(
    payload.sender?.name &&
      config.botName &&
      normalizeParticipantText(payload.sender.name) === normalizeParticipantText(config.botName),
  );
}

function isPrivateToBot(payload: ChatPayload): boolean {
  if (sameParticipant(payload.receiver, botParticipant)) {
    return true;
  }

  return Boolean(
    payload.receiver?.name &&
      config.botName &&
      normalizeParticipantText(payload.receiver.name) === normalizeParticipantText(config.botName),
  );
}

function isPublicChat(payload: ChatPayload): boolean {
  const receiverName = normalizeParticipantText(payload.receiver?.name);

  return (
    payload.receiver?.userId === 0 ||
    receiverName === "everyone" ||
    receiverName.includes("everyone")
  );
}

function isMentioningBot(payload: ChatPayload): boolean {
  const message = normalizeParticipantText(chatMessageText(payload));
  if (!message) {
    return false;
  }

  const names = new Set(
    ["bot", "echo", "echo ai assistant", config.botName, botParticipant?.name]
      .map(normalizeParticipantText)
      .filter(Boolean),
  );

  for (const name of names) {
    if (message.includes(`@${name}`)) {
      return true;
    }
  }

  return false;
}

function aiQuestionFromChat(payload: unknown): AiQuestion | null {
  if (!parseBoolean(process.env.CHAT_QA_ENABLED, true)) {
    return null;
  }

  const chat = payload as ChatPayload;

  if (!chat.sender || isFromBot(chat)) {
    return null;
  }

  const message = chatMessageText(chat).trim();
  if (!message) {
    return null;
  }

  if (isPrivateToBot(chat)) {
    if (typeof chat.sender.userId !== "number") {
      emitEvent("qa-error", {
        question: message,
        message: "Cannot reply privately because sender.userId is missing",
      });
      return null;
    }
    if (!chat.replyTarget || !chat.replyTarget.privateToBot) {
      emitEvent("qa-error", {
        question: message,
        message:
          "Cannot reply in a private thread because the source chat message target is missing or not private",
      });
      return null;
    }

    return {
      question: message,
      senderUserId: chat.sender.userId,
      senderName: chat.sender.name,
      replyToUserId: chat.sender.userId,
      replyToMessage: chat.replyTarget,
      replyType: "private",
      trigger: payload,
    };
  }

  if (isPublicChat(chat) && isMentioningBot(chat)) {
    if (!chat.replyTarget || chat.replyTarget.privateToBot) {
      emitEvent("qa-error", {
        question: message,
        message:
          "Cannot reply in a public thread because the source chat message target is missing or private",
      });
      return null;
    }
    return {
      question: message,
      senderUserId: chat.sender.userId,
      senderName: chat.sender.name,
      replyToMessage: chat.replyTarget,
      replyType: "public-mention",
      trigger: payload,
    };
  }

  return null;
}

app.post(
  config.rtms.webhookPath,
  express.raw({ type: "*/*", limit: "1mb" }),
  (req, res) => {
    if (!config.rtms.enabled) {
      res.status(503).json({ ok: false, error: "RTMS is disabled" });
      return;
    }

    let webhook: unknown;
    const body = rawBodyText(req);

    try {
      webhook = JSON.parse(body);
    } catch {
      res.status(400).json({ ok: false, error: "Invalid JSON webhook payload" });
      return;
    }

    const event = (webhook as { event?: unknown }).event;
    const plainToken = (webhook as { payload?: { plainToken?: unknown } }).payload
      ?.plainToken;

    if (event === "endpoint.url_validation") {
      if (typeof plainToken !== "string" || !plainToken) {
        res.status(400).json({ ok: false, error: "payload.plainToken is required" });
        return;
      }

      res.json({
        plainToken,
        encryptedToken: createValidationToken(plainToken),
      });
      return;
    }

    const skipSignatureVerify = parseBoolean(
      process.env.ZOOM_WEBHOOK_SKIP_SIGNATURE_VERIFY,
      false,
    );
    const verification = verifyZoomWebhookSignature(req, body);
    if (!verification.ok) {
      if (!skipSignatureVerify) {
        emitEvent("rtms-webhook-verification-failed", {
          event,
          reason: verification.reason,
        });
        res.status(401).json({ ok: false, error: verification.reason });
        return;
      }

      emitEvent("rtms-webhook-verification-bypassed", {
        event,
        reason: verification.reason,
      });
    }

    res.json({ ok: true });
    void rtmsManager.handleWebhook(webhook as Parameters<typeof rtmsManager.handleWebhook>[0]);
  },
);

app.use(express.json({ limit: "1mb" }));

/**
 * Sensitive admin/meeting-data routes require either:
 * - loopback client (127.0.0.1 / ::1), or
 * - header `x-echo-admin-token` matching env ECHO_ADMIN_API_TOKEN.
 * Public literature asks use /ai/ask (and the website proxy) and stay open.
 */
function clientIsLoopback(req: { ip?: string; socket?: { remoteAddress?: string } }): boolean {
  const raw = (req.ip || req.socket?.remoteAddress || "").replace("::ffff:", "");
  return raw === "127.0.0.1" || raw === "::1" || raw === "localhost";
}

function requireAdminAccess(
  req: { ip?: string; socket?: { remoteAddress?: string }; header: (name: string) => string | undefined },
  res: { status: (code: number) => { json: (body: unknown) => void } },
  next: () => void,
): void {
  const token = process.env.ECHO_ADMIN_API_TOKEN?.trim();
  const provided = (req.header("x-echo-admin-token") || "").trim();
  if (token && provided && provided === token) {
    next();
    return;
  }
  if (clientIsLoopback(req)) {
    next();
    return;
  }
  res.status(401).json({
    ok: false,
    error: "Admin token or loopback access required for this endpoint",
  });
}

app.get("/health", (_req, res) => {
  res.json(healthPayload());
});

app.get("/oauth/status", requireAdminAccess, (_req, res) => {
  res.json({
    ok: true,
    oauth: {
      ...publicOAuthState(oauthState),
      zakScopeReady: oauthScopesIncludeZak(oauthState.scope),
    },
  });
});

app.get("/oauth/authorize-url", requireAdminAccess, (req, res) => {
  res.json({
    ok: true,
    authorizeUrl: oauthAuthorizeUrl(req),
    zakScopeReady: oauthScopesIncludeZak(oauthState.scope),
  });
});

app.get("/oauth/zak", requireAdminAccess, async (_req, res) => {
  try {
    if (!oauthScopesIncludeZak(oauthState.scope)) {
      res.status(403).json({
        ok: false,
        error:
          "OAuth scope user:read:zak or user:read:token is missing; re-authorize the Zoom app",
      });
      return;
    }
    const accessToken = await ensureOAuthAccessToken();
    const zak = await fetchZoomUserZak(accessToken);
    emitEvent("oauth-zak-issued", {
      expiresIn: zak.expiresIn,
    });
    res.json({
      ok: true,
      token: zak.token,
      expiresIn: zak.expiresIn,
    });
  } catch (error) {
    const message = errorMessage(error);
    emitEvent("oauth-zak-error", { message });
    res.status(500).json({ ok: false, error: message });
  }
});

app.get("/oauth/callback", async (req, res) => {
  const callbackAt = new Date().toISOString();
  oauthState = {
    ...oauthState,
    lastCallbackAt: callbackAt,
  };

  const error = typeof req.query.error === "string" ? req.query.error : "";
  const errorDescription =
    typeof req.query.error_description === "string"
      ? req.query.error_description
      : "";

  if (error) {
    const message = errorDescription || error;
    oauthState = {
      ...oauthState,
      installed: false,
      lastError: message,
      accessToken: null,
      refreshToken: null,
    };
    saveOAuthState(oauthState);
    emitEvent("oauth-error", { error, errorDescription });
    res.status(400).send(`<!doctype html>
<html><body>
<h1>Zoom authorization failed</h1>
<p>${escapeHtml(message)}</p>
</body></html>`);
    return;
  }

  const code = typeof req.query.code === "string" ? req.query.code : "";

  if (!code) {
    oauthState = {
      ...oauthState,
      installed: false,
      lastError: "Missing OAuth code in callback",
      accessToken: null,
      refreshToken: null,
    };
    saveOAuthState(oauthState);
    emitEvent("oauth-error", { message: oauthState.lastError });
    res.status(400).send(`<!doctype html>
<html><body>
<h1>Missing Zoom OAuth code</h1>
<p>The callback did not include a code query parameter.</p>
</body></html>`);
    return;
  }

  const redirectUri = oauthRedirectUrl(req);

  try {
    oauthState = await exchangeOAuthCode(code, redirectUri);
    oauthState.lastCallbackAt = callbackAt;
    saveOAuthState(oauthState);
    emitEvent("oauth-installed", {
      redirectUri,
      tokenType: oauthState.tokenType,
      scope: oauthState.scope,
      expiresAt: oauthState.expiresAt,
    });
    res.send(`<!doctype html>
<html><body>
<h1>Zoom app authorization complete</h1>
<p>ECHO received and exchanged the authorization code successfully.</p>
<p>You can close this tab and start the Zoom meeting.</p>
</body></html>`);
  } catch (exchangeError) {
    const message = errorMessage(exchangeError);
    oauthState = {
      ...oauthState,
      installed: false,
      lastError: message,
      accessToken: null,
      refreshToken: null,
    };
    saveOAuthState(oauthState);
    emitEvent("oauth-error", { redirectUri, message });
    res.status(500).send(`<!doctype html>
<html><body>
<h1>Zoom token exchange failed</h1>
<p>${escapeHtml(message)}</p>
<p>Check that the OAuth Redirect URL exactly matches: ${escapeHtml(redirectUri)}</p>
</body></html>`);
  }
});

app.get("/rtms/health", (_req, res) => {
  res.json({ ok: true, rtms: rtmsManager.health() });
});

app.get("/rtms/sessions", requireAdminAccess, (_req, res) => {
  res.json({ ok: true, sessions: rtmsManager.sessionsSummary() });
});

/** Start RTMS for the configured live meeting via Zoom REST API. */
app.post("/rtms/start", requireAdminAccess, async (req, res) => {
  try {
    const accessToken = await ensureOAuthAccessToken();
    const meetingId =
      (typeof req.body?.meetingNumber === "string" && req.body.meetingNumber.trim()) ||
      config.zoomMeetingNumber;
    if (!meetingId) {
      res.status(400).json({ ok: false, error: "meetingNumber is required" });
      return;
    }
    const clientId = config.zoomClientId;
    const response = await fetch(
      `https://api.zoom.us/v2/live_meetings/${encodeURIComponent(meetingId)}/rtms_app/status`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "start",
          settings: { client_id: clientId },
        }),
      },
    );
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // keep raw text
    }
    if (!response.ok) {
      emitEvent("rtms-start-api-failed", {
        meetingId,
        status: response.status,
        body,
      });
      res.status(502).json({
        ok: false,
        error: "Zoom RTMS start API failed",
        status: response.status,
        body,
      });
      return;
    }
    emitEvent("rtms-start-api-ok", { meetingId, body });
    res.json({ ok: true, meetingId, body });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitEvent("rtms-start-api-error", { message });
    res.status(500).json({ ok: false, error: message });
  }
});

app.get("/rtms/transcript", requireAdminAccess, (req, res) => {
  const streamId = typeof req.query.streamId === "string" ? req.query.streamId : undefined;
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  const limit =
    rawLimit !== undefined && Number.isInteger(rawLimit) && rawLimit > 0
      ? rawLimit
      : undefined;

  res.json({
    ok: true,
    transcripts: rtmsManager.transcripts({ streamId, limit }),
  });
});

app.get("/ai/health", async (_req, res) => {
  res.json({
    ok: true,
    ai: await aiManager.runtimeHealth(),
    retrieval: await retrievalManager.runtimeHealth(),
  });
});

app.get("/ai/memory", requireAdminAccess, (req, res) => {
  const streamId = typeof req.query.streamId === "string" ? req.query.streamId : undefined;
  res.json({ ok: true, memory: aiManager.memory(streamId) });
});

app.get("/ai/screens", requireAdminAccess, (req, res) => {
  const streamId = typeof req.query.streamId === "string" ? req.query.streamId : undefined;
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  const limit =
    rawLimit !== undefined && Number.isInteger(rawLimit) && rawLimit > 0
      ? rawLimit
      : undefined;

  res.json({ ok: true, screens: aiManager.screens(streamId, limit) });
});

app.get("/meeting-minutes/health", (_req, res) => {
  res.json({
    ok: true,
    meetingMinutes: meetingMinutesManager.health(),
  });
});

app.get("/meeting-minutes/latest", requireAdminAccess, (_req, res) => {
  res.json({
    ok: true,
    meetingMinutes: meetingMinutesManager.latest(),
  });
});

/** Download latest post-session summary.md (outside Zoom chat). */
app.get("/meeting-minutes/summary.md", requireAdminAccess, (_req, res) => {
  const latest = meetingMinutesManager.latest();
  const summaryPath = latest?.files?.summaryMarkdown;
  if (!summaryPath || !fs.existsSync(summaryPath)) {
    res.status(404).json({
      ok: false,
      error:
        "No post-session summary is available yet. Leave the meeting or wait for RTMS session close, then retry.",
    });
    return;
  }
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="echo-session-summary.md"',
  );
  res.send(fs.readFileSync(summaryPath, "utf8"));
});

app.post("/meeting-minutes/generate", requireAdminAccess, async (req, res) => {
  try {
    const streamId = typeof req.body?.streamId === "string" ? req.body.streamId.trim() : "";
    if (!streamId) {
      res.status(400).json({ ok: false, error: "streamId is required" });
      return;
    }

    const result = await meetingMinutesManager.generate({
      streamId,
      meetingUuid:
        typeof req.body?.meetingUuid === "string" ? req.body.meetingUuid : null,
      startedAt: typeof req.body?.startedAt === "string" ? req.body.startedAt : null,
      closedAt: typeof req.body?.closedAt === "string" ? req.body.closedAt : null,
      reason: "manual",
    });
    res.json({ ok: true, meetingMinutes: result });
  } catch (error) {
    emitEvent("meeting-minutes-error", { message: errorMessage(error) });
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});


app.post("/ai/ask", async (req, res) => {
  try {
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    const streamId = typeof req.body?.streamId === "string" ? req.body.streamId : undefined;

    if (!question) {
      res.status(400).json({ ok: false, error: "question is required" });
      return;
    }

    const result = await aiManager.ask({
      question,
      streamId,
      senderName: "local-debug",
      replyType: "manual",
      allowPrivateIndex: false,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    emitEvent("qa-error", { message: errorMessage(error) });
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

/** Synthetic media replay: inject recorded frames/transcript and ask without live RTMS. */
app.get("/demo/replay/health", (_req, res) => {
  res.json({
    ok: true,
    enabled: demoReplayEnabled,
    root: demoReplayRoot,
    ai: aiManager.health(),
  });
});

app.post("/demo/replay/reset", (req, res) => {
  if (!requireDemoReplay(req, res)) {
    return;
  }
  const streamId =
    typeof req.body?.streamId === "string" && req.body.streamId.trim()
      ? req.body.streamId.trim()
      : `replay-${Date.now()}`;
  aiManager.clearMemory(streamId);
  res.json({ ok: true, streamId });
});

app.post("/demo/replay/frame", (req, res) => {
  if (!requireDemoReplay(req, res)) {
    return;
  }
  try {
    const streamId =
      typeof req.body?.streamId === "string" && req.body.streamId.trim()
        ? req.body.streamId.trim()
        : "";
    const filePathRaw =
      typeof req.body?.filePath === "string" ? req.body.filePath.trim() : "";
    if (!streamId || !filePathRaw) {
      res.status(400).json({ ok: false, error: "streamId and filePath are required" });
      return;
    }
    const filePath = resolveDemoReplayFile(filePathRaw);
    if (!filePath) {
      res.status(400).json({
        ok: false,
        error: "filePath must exist under demo_replay/, data/rtms/, or echo-screens/",
      });
      return;
    }
    const now = Date.now();
    const frameId =
      typeof req.body?.frameId === "number" && Number.isFinite(req.body.frameId)
        ? Math.trunc(req.body.frameId)
        : 1;
    const uniqueFrameId =
      typeof req.body?.uniqueFrameId === "number" && Number.isFinite(req.body.uniqueFrameId)
        ? Math.trunc(req.body.uniqueFrameId)
        : frameId;
    const timestamp =
      typeof req.body?.timestamp === "number" && Number.isFinite(req.body.timestamp)
        ? req.body.timestamp
        : now;
    const stat = fs.statSync(filePath);
    aiManager.ingestScreenShareFrame({
      streamId,
      meetingUuid:
        typeof req.body?.meetingUuid === "string" ? req.body.meetingUuid : "demo-replay",
      frameId,
      uniqueFrameId,
      fileName: path.basename(filePath),
      filePath,
      timestamp,
      receivedAt: new Date(timestamp).toISOString(),
      size: stat.size,
      codec: "JPG",
      resolution: "FHD",
      fps: 1,
      diffFromPreviousUnique: null,
      userId: null,
      userName: "demo-replay",
      startTs: null,
      endTs: null,
    });
    res.json({
      ok: true,
      streamId,
      frame: { filePath, frameId, uniqueFrameId, timestamp },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.post("/demo/replay/transcript", async (req, res) => {
  if (!requireDemoReplay(req, res)) {
    return;
  }
  try {
    const streamId =
      typeof req.body?.streamId === "string" && req.body.streamId.trim()
        ? req.body.streamId.trim()
        : "";
    const segmentsIn = Array.isArray(req.body?.segments) ? req.body.segments : null;
    if (!streamId || !segmentsIn) {
      res.status(400).json({ ok: false, error: "streamId and segments[] are required" });
      return;
    }
    const baseTs =
      typeof req.body?.baseTimestamp === "number" && Number.isFinite(req.body.baseTimestamp)
        ? req.body.baseTimestamp
        : Date.now() - segmentsIn.length * 5_000;
    const ingested = [];
    for (let i = 0; i < segmentsIn.length; i += 1) {
      const item = segmentsIn[i];
      const text =
        typeof item === "string"
          ? item.trim()
          : typeof item?.text === "string"
            ? item.text.trim()
            : "";
      if (!text) {
        continue;
      }
      const startTimestamp =
        typeof item?.startTimestamp === "number" && Number.isFinite(item.startTimestamp)
          ? item.startTimestamp
          : baseTs + i * 5_000;
      const endTimestamp =
        typeof item?.endTimestamp === "number" && Number.isFinite(item.endTimestamp)
          ? item.endTimestamp
          : startTimestamp + 4_000;
      const segment = {
        id: i + 1,
        streamId,
        meetingUuid:
          typeof req.body?.meetingUuid === "string" ? req.body.meetingUuid : "demo-replay",
        userId: typeof item?.userId === "number" ? item.userId : 1,
        userName:
          typeof item?.userName === "string" && item.userName.trim()
            ? item.userName.trim()
            : "Facilitator",
        startTimestamp,
        endTimestamp,
        text,
        language: "en",
        durationSeconds: Math.max(0.1, (endTimestamp - startTimestamp) / 1000),
        createdAt: new Date(endTimestamp).toISOString(),
      };
      await aiManager.ingestAsrSegment(segment);
      ingested.push(segment);
    }
    res.json({ ok: true, streamId, count: ingested.length, segments: ingested });
  } catch (error) {
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.post("/demo/replay/ask", async (req, res) => {
  if (!requireDemoReplay(req, res)) {
    return;
  }
  try {
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    const streamId =
      typeof req.body?.streamId === "string" && req.body.streamId.trim()
        ? req.body.streamId.trim()
        : undefined;
    if (!question) {
      res.status(400).json({ ok: false, error: "question is required" });
      return;
    }
    const allowPrivateIndex = req.body?.allowPrivateIndex !== false;
    const result = await aiManager.ask({
      question,
      streamId,
      senderName:
        typeof req.body?.senderName === "string" && req.body.senderName.trim()
          ? req.body.senderName.trim()
          : "demo-reviewer",
      replyType: allowPrivateIndex ? "public-mention" : "manual",
      allowPrivateIndex,
      askedAt:
        typeof req.body?.askedAt === "number" && Number.isFinite(req.body.askedAt)
          ? req.body.askedAt
          : Date.now(),
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    emitEvent("qa-error", { message: errorMessage(error) });
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.get("/signature", (_req, res) => {
  res.json({
    signature: createSignature(),
    meetingNumber: config.zoomMeetingNumber,
    password: config.zoomMeetingPassword,
    userName: config.botName,
  });
});

app.post("/join", requireAdminAccess, async (req, res) => {
  try {
    const force = req.body?.force === true;
    const result = await joinBot(force);
    res.json(result);
  } catch (error) {
    setState("error", error);
    emitEvent("join-error", { message: errorMessage(error) });
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.post("/chat", async (req, res) => {
  try {
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    const userId = req.body?.userId;

    if (!message) {
      res.status(400).json({ ok: false, error: "message is required" });
      return;
    }

    if (userId !== undefined && typeof userId !== "number") {
      res.status(400).json({ ok: false, error: "userId must be a number when provided" });
      return;
    }

    const result = await sendBotChat(message, userId);
    res.json({ ok: true, result });
  } catch (error) {
    const status = errorMessage(error).includes("bot page is not open") ? 409 : 500;
    emitEvent("chat-send-error", { message: errorMessage(error) });
    res.status(status).json({ ok: false, error: errorMessage(error) });
  }
});

app.get("/debug/chat-snapshot", requireAdminAccess, async (_req, res) => {
  try {
    const snapshot = await webBot.dumpChatState();
    res.json({ ok: true, snapshot });
  } catch (error) {
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.post("/debug/chat-probe", requireAdminAccess, async (req, res) => {
  try {
    const body = (req.body ?? {}) as {
      scrollTo?: "top" | "bottom";
      autoScroll?: boolean;
    };
    const autoScroll =
      typeof body.autoScroll === "boolean"
        ? webBot.setChatAutoScroll(body.autoScroll)
        : undefined;
    const probe = await webBot.debugChatProbe(body.scrollTo);
    res.json({ ok: true, autoScroll, probe });
  } catch (error) {
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.post("/debug/nested-self-test", requireAdminAccess, async (_req, res) => {
  try {
    const result = await webBot.nestedSelfTest();
    res.json({ ok: true, result });
  } catch (error) {
    emitEvent("nested-self-test-error", { message: errorMessage(error) });
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.post("/leave", requireAdminAccess, async (_req, res) => {
  try {
    const result = await leaveBot();
    res.json({ ok: true, result, health: healthPayload() });
  } catch (error) {
    emitEvent("leave-error", { message: errorMessage(error) });
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  sseClients.add(res);

  res.write(
    `event: hello\ndata: ${JSON.stringify({
      state: zoomState,
      recentEvents,
      connectedAt: new Date().toISOString(),
    })}\n\n`,
  );

  const ping = setInterval(() => {
    res.write(`event: ping\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  }, 25_000);

  req.on("close", () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

app.post("/bot/events", (req, res) => {
  const type = typeof req.body?.type === "string" ? req.body.type : "bot-event";
  const payload = req.body?.payload ?? {};

  if (type === "bot-user") {
    botParticipant = payload as ChatParticipant;
  }

  if (type === "joined") {
    setState("joined");
    lastJoinedAt = new Date().toISOString();
  } else if (type === "error") {
    setState("error", payload);
  } else if (type === "connection-change") {
    const connectionState = (payload as { state?: string } | undefined)?.state;

    if (connectionState === "Connected") {
      setState("joined");
      lastJoinedAt = lastJoinedAt ?? new Date().toISOString();
    } else if (connectionState === "Closed") {
      setState("closed");
    }
  }

  emitEvent(type, payload);
  if (type === "chat-on-message") {
    const question = aiQuestionFromChat(payload);
    if (question) {
      aiManager.enqueueQuestion(question);
    }
  }
  res.json({ ok: true });
});

app.use(express.static(publicDir));

app.get("/", (_req, res) => {
  res.redirect("/health");
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Not found: ${req.method} ${req.path}` });
});

async function shutdown(signal: string): Promise<void> {
  emitEvent("shutdown", { signal });
  await rtmsManager.shutdown().catch((error) => {
    emitEvent("rtms-shutdown-error", { message: errorMessage(error) });
  });
  await aiManager.shutdown().catch((error) => {
    emitEvent("ai-shutdown-error", { message: errorMessage(error) });
  });
  await retrievalManager.shutdown().catch((error) => {
    emitEvent("retrieval-shutdown-error", { message: errorMessage(error) });
  });
  await caseOutputManager.shutdown().catch((error) => {
    emitEvent("case-output-shutdown-error", { message: errorMessage(error) });
  });
  await caseWorkspaceManager.shutdown().catch((error) => {
    emitEvent("case-workspace-shutdown-error", { message: errorMessage(error) });
  });
  await leaveBot().catch(async () => {
    await webBot.shutdown().catch(() => undefined);
    await closeCurrentPage();
    await browser?.close().catch(() => undefined);
  });
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

app.listen(config.port, () => {
  console.log(`ECHO Zoom bot server listening on http://localhost:${config.port}`);
  console.log(`Meeting ${config.zoomMeetingNumber}; bot name "${config.botName}"`);

  if (config.autoJoin) {
    setTimeout(() => {
      void joinBot().catch((error) => {
        setState("error", error);
        emitEvent("auto-join-error", { message: errorMessage(error) });
      });
    }, 1_000);
  }

  if (config.caseWorkspace.enabled) {
    void caseWorkspaceManager
      .start()
      .then(() => {
        console.log(
          `ECHO case workspace listening on http://${config.caseWorkspace.host}:${config.caseWorkspace.port}`,
        );
      })
      .catch((error) => {
        emitEvent("case-workspace-server-error", {
          message: errorMessage(error),
          host: config.caseWorkspace.host,
          port: config.caseWorkspace.port,
        });
      });
  }

  if (config.retrieval.enabled) {
    void retrievalManager.start().catch((error) => {
      emitEvent("retrieval-startup-error", {
        message: errorMessage(error),
      });
      });
  }

  if (config.caseOutput.enabled) {
    void caseOutputManager.start().catch((error) => {
      emitEvent("case-output-startup-error", {
        message: errorMessage(error),
      });
    });
  }
});
