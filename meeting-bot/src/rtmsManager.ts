import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isUniqueScreenShare,
  screenShareFingerprintFromJpeg,
  type ScreenShareFingerprint,
} from "./screenShareFingerprint.js";

export type RtmsManagerConfig = {
  enabled: boolean;
  webhookPath: string;
  dataDir: string;
  transcriptEnabled: boolean;
  transcriptMemoryLimit: number;
  audioPersist: boolean;
  audioMaxBytesPerStream: number;
  audioFlushIntervalMs: number;
  screenShareEnabled: boolean;
  screenShareCodec: string;
  screenShareResolution: string;
  screenShareFps: number;
  screenShareMaxBytesPerStream: number;
  screenShareStoreAllFrames: boolean;
  screenShareUniqueDiffThreshold: number;
  screenShareContentDiffThreshold: number;
  screenShareContentChangedFrac: number;
};

export type RtmsEventEmitter = (type: string, payload?: unknown) => void;

export type RtmsAudioDataEvent = {
  streamId: string;
  meetingUuid: string | null;
  userId: number | null;
  userName: string | null;
  timestamp: number;
  receivedAt: string;
  size: number;
  buffer: Buffer;
};

export type RtmsManagerHooks = {
  onAudioData?: (event: RtmsAudioDataEvent) => void;
  onScreenShareFrame?: (event: RtmsScreenShareFrameEvent) => void;
  onSessionClosed?: (event: {
    streamId: string;
    meetingUuid: string | null;
    reason: string;
    startedAt: string;
    closedAt: string;
  }) => void | Promise<void>;
};

export type RtmsScreenShareFrameEvent = {
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
  fullMeanAbs?: number | null;
  contentMeanAbs?: number | null;
  contentChangedFrac?: number | null;
  userId: number | null;
  userName: string | null;
  startTs: number | null;
  endTs: number | null;
};

type RtmsWebhookPayload = {
  event?: string;
  event_ts?: number;
  payload?: Record<string, unknown>;
};

type RtmsMetadata = {
  userName?: string;
  userId?: number;
  startTs?: number;
  endTs?: number;
};

type RtmsClientLike = {
  join(options: Record<string, unknown>): boolean;
  leave(): boolean;
  setAudioParams?(params: Record<string, unknown>): boolean;
  setDeskshareParams?(params: Record<string, unknown>): boolean;
  setTranscriptParams?(params: Record<string, unknown>): boolean;
  onJoinConfirm?(callback: (reason: number) => void): boolean;
  onLeave?(callback: (reason: number) => void): boolean;
  onSessionUpdate?(callback: (op: number, sessionInfo: unknown) => void): boolean;
  onParticipantEvent?(
    callback: (event: string, timestamp: number, participants: unknown[]) => void,
  ): boolean;
  onActiveSpeakerEvent?(
    callback: (timestamp: number, userId: number, userName: string) => void,
  ): boolean;
  onMediaConnectionInterrupted?(callback: (timestamp: number) => void): boolean;
  onSharingEvent?(
    callback: (
      event: "start" | "stop" | string,
      timestamp: number,
      userId?: number,
      userName?: string,
    ) => void,
  ): boolean;
  onAudioData?(
    callback: (
      buffer: Buffer,
      size: number,
      timestamp: number,
      metadata: RtmsMetadata,
    ) => void,
  ): boolean;
  onTranscriptData?(
    callback: (
      buffer: Buffer,
      size: number,
      timestamp: number,
      metadata: RtmsMetadata,
    ) => void,
  ): boolean;
  onDeskshareData?(
    callback: (
      buffer: Buffer,
      size: number,
      timestamp: number,
      metadata: RtmsMetadata,
    ) => void,
  ): boolean;
};

type RtmsModuleLike = {
  Client: new () => RtmsClientLike;
  AudioContentType?: Record<string, number>;
  AudioCodec?: Record<string, number>;
  AudioSampleRate?: Record<string, number>;
  AudioChannel?: Record<string, number>;
  AudioDataOption?: Record<string, number>;
  VideoContentType?: Record<string, number>;
  VideoCodec?: Record<string, number>;
  VideoResolution?: Record<string, number>;
  TranscriptLanguage?: Record<string, number>;
};

type RtmsSession = {
  streamId: string;
  safeStreamId: string;
  meetingUuid: string | null;
  status: "starting" | "joining" | "joined" | "join-failed" | "closed";
  client: RtmsClientLike;
  startedAt: string;
  joinedAt: string | null;
  closedAt: string | null;
  joinReason: number | null;
  lastAudioAt: string | null;
  lastTranscriptAt: string | null;
  lastScreenShareAt: string | null;
  audioBytes: number;
  audioLimitReached: boolean;
  audioDir: string | null;
  transcriptPath: string;
  metadataPath: string | null;
  screenShareDir: string | null;
  screenShareFramesDir: string | null;
  screenShareMetadataPath: string | null;
  screenShareMetadataStream: WriteStream | null;
  screenShareUniqueDir: string | null;
  screenShareUniqueFramesDir: string | null;
  screenShareUniqueMetadataPath: string | null;
  screenShareUniqueMetadataStream: WriteStream | null;
  screenShareTimelinePath: string | null;
  screenShareTimelineStream: WriteStream | null;
  screenShareBytes: number;
  screenShareReceivedBytes: number;
  screenShareFrames: number;
  screenShareUniqueFrames: number;
  screenShareDuplicateFrames: number;
  screenShareLimitReached: boolean;
  lastUniqueScreenShareFingerprint: ScreenShareFingerprint | null;
  audioStreams: Map<string, BufferedAudioStream>;
  metadataStream: WriteStream | null;
  pendingMetadataLines: string[];
  flushTimer: NodeJS.Timeout | null;
  transcriptStream: WriteStream;
  lastAudioStatsAtByUser: Map<string, number>;
  lastScreenShareStatsAt: number;
};

type BufferedAudioStream = {
  stream: WriteStream;
  pending: Buffer[];
  pendingBytes: number;
};

export type RtmsTranscriptEntry = {
  id: number;
  streamId: string;
  meetingUuid: string | null;
  userId: number | null;
  userName: string | null;
  text: string;
  timestamp: number;
  size: number;
  createdAt: string;
};

let rtmsImportPromise: Promise<RtmsModuleLike> | null = null;

const VIDEO_CONTENT_TYPE_FALLBACKS: Record<string, number> = {
  RAW_VIDEO: 3,
};

const VIDEO_CODEC_FALLBACKS: Record<string, number> = {
  JPG: 5,
  PNG: 6,
  H264: 7,
};

const VIDEO_RESOLUTION_FALLBACKS: Record<string, number> = {
  SD: 1,
  HD: 2,
  FHD: 3,
  QHD: 4,
};

function sanitizePathPart(value: unknown): string {
  const text = String(value ?? "unknown").trim();
  const safe = text.replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe || "unknown";
}

function metadataPayload(metadata: RtmsMetadata | undefined) {
  return {
    userId: typeof metadata?.userId === "number" ? metadata.userId : null,
    userName: metadata?.userName ?? null,
    startTs: typeof metadata?.startTs === "number" ? metadata.startTs : null,
    endTs: typeof metadata?.endTs === "number" ? metadata.endTs : null,
  };
}

function bufferFrom(value: Buffer): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function constantValue(
  values: Record<string, number> | undefined,
  key: string,
  fallback: number,
): number {
  const value = values?.[key];
  return typeof value === "number" ? value : fallback;
}

function screenShareFileExtension(codec: string): string {
  const normalized = codec.trim().toUpperCase();
  if (normalized === "PNG") {
    return "png";
  }
  if (normalized === "H264") {
    return "h264";
  }
  return "jpg";
}

function screenShareMimeType(codec: string): string {
  const normalized = codec.trim().toUpperCase();
  if (normalized === "PNG") {
    return "image/png";
  }
  return "image/jpeg";
}

async function loadRtmsModule(): Promise<RtmsModuleLike> {
  rtmsImportPromise ??= import("@zoom/rtms").then(
    (module) => (module.default ?? module) as unknown as RtmsModuleLike,
  );

  return rtmsImportPromise;
}

export class RtmsManager {
  private readonly sessions = new Map<string, RtmsSession>();
  private readonly transcriptMemory: RtmsTranscriptEntry[] = [];
  private transcriptId = 0;

  constructor(
    private readonly config: RtmsManagerConfig,
    private readonly emit: RtmsEventEmitter,
    private readonly hooks: RtmsManagerHooks = {},
  ) {}

  health() {
    return {
      enabled: this.config.enabled,
      webhookPath: this.config.webhookPath,
      dataDir: this.config.dataDir,
      activeStreams: this.sessions.size,
      transcriptEnabled: this.config.transcriptEnabled,
      transcriptMemoryItems: this.transcriptMemory.length,
      audioPersist: this.config.audioPersist,
      audioMaxBytesPerStream: this.config.audioMaxBytesPerStream,
      audioFlushIntervalMs: this.config.audioFlushIntervalMs,
      screenShareEnabled: this.config.screenShareEnabled,
      screenShareCodec: this.config.screenShareCodec,
      screenShareResolution: this.config.screenShareResolution,
      screenShareFps: this.config.screenShareFps,
      screenShareMaxBytesPerStream: this.config.screenShareMaxBytesPerStream,
      screenShareStoreAllFrames: this.config.screenShareStoreAllFrames,
      screenShareUniqueDiffThreshold: this.config.screenShareUniqueDiffThreshold,
      screenShareContentDiffThreshold: this.config.screenShareContentDiffThreshold,
      screenShareContentChangedFrac: this.config.screenShareContentChangedFrac,
      sessions: this.sessionsSummary(),
    };
  }

  sessionsSummary() {
    return Array.from(this.sessions.values()).map((session) => ({
      streamId: session.streamId,
      meetingUuid: session.meetingUuid,
      status: session.status,
      startedAt: session.startedAt,
      joinedAt: session.joinedAt,
      closedAt: session.closedAt,
      joinReason: session.joinReason,
      lastAudioAt: session.lastAudioAt,
      lastTranscriptAt: session.lastTranscriptAt,
      lastScreenShareAt: session.lastScreenShareAt,
      audioBytes: session.audioBytes,
      audioLimitReached: session.audioLimitReached,
      audioDir: session.audioDir,
      transcriptPath: session.transcriptPath,
      metadataPath: session.metadataPath,
      screenShareEnabled: this.config.screenShareEnabled,
      screenShareStoreAllFrames: this.config.screenShareStoreAllFrames,
      screenShareUniqueDiffThreshold: this.config.screenShareUniqueDiffThreshold,
      screenShareContentDiffThreshold: this.config.screenShareContentDiffThreshold,
      screenShareContentChangedFrac: this.config.screenShareContentChangedFrac,
      screenShareBytes: session.screenShareBytes,
      screenShareReceivedBytes: session.screenShareReceivedBytes,
      screenShareFrames: session.screenShareFrames,
      screenShareUniqueFrames: session.screenShareUniqueFrames,
      screenShareDuplicateFrames: session.screenShareDuplicateFrames,
      screenShareLimitReached: session.screenShareLimitReached,
      screenShareDir: session.screenShareDir,
      screenShareUniqueDir: session.screenShareUniqueDir,
      screenShareMetadataPath: session.screenShareMetadataPath,
      screenShareUniqueMetadataPath: session.screenShareUniqueMetadataPath,
      screenShareTimelinePath: session.screenShareTimelinePath,
    }));
  }

  transcripts(options: { streamId?: string; limit?: number } = {}) {
    const limit = Math.max(1, Math.min(options.limit ?? 100, this.config.transcriptMemoryLimit));
    const source = options.streamId
      ? this.transcriptMemory.filter((entry) => entry.streamId === options.streamId)
      : this.transcriptMemory;

    return source.slice(-limit);
  }

  async handleWebhook(webhook: RtmsWebhookPayload): Promise<void> {
    if (!this.config.enabled) {
      this.emit("rtms-disabled-webhook-ignored", { event: webhook.event });
      return;
    }

    try {
      this.emit("rtms-webhook-received", {
        event: webhook.event,
        eventTs: webhook.event_ts,
        streamId: this.streamIdFromWebhook(webhook),
      });

      if (webhook.event === "meeting.rtms_started") {
        await this.handleStarted(webhook);
        return;
      }

      if (webhook.event === "meeting.rtms_stopped") {
        this.handleStopped(webhook);
        return;
      }

      if (webhook.event === "meeting.rtms_interrupted") {
        this.emit("rtms-interrupted", {
          eventTs: webhook.event_ts,
          streamId: this.streamIdFromWebhook(webhook),
          payload: webhook.payload ?? {},
        });
        return;
      }

      this.emit("rtms-webhook-ignored", { event: webhook.event });
    } catch (error) {
      this.emit("rtms-error", {
        event: webhook.event,
        streamId: this.streamIdFromWebhook(webhook),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async shutdown(): Promise<void> {
    for (const streamId of Array.from(this.sessions.keys())) {
      this.closeSession(streamId, "shutdown", true);
    }
  }

  private async handleStarted(webhook: RtmsWebhookPayload): Promise<void> {
    const payload = webhook.payload ?? {};
    const streamId = this.streamIdFromWebhook(webhook);

    if (!streamId) {
      this.emit("rtms-error", {
        event: webhook.event,
        message: "meeting.rtms_started webhook is missing payload.rtms_stream_id",
      });
      return;
    }

    if (this.sessions.has(streamId)) {
      this.emit("rtms-stream-duplicate", { streamId });
      return;
    }

    const rtms = await loadRtmsModule();
    const safeStreamId = sanitizePathPart(streamId);
    const audioDir = this.config.audioPersist
      ? path.join(this.config.dataDir, "audio", safeStreamId)
      : null;
    const transcriptDir = path.join(this.config.dataDir, "transcripts");
    const screenShareDir = this.config.screenShareEnabled
      ? path.join(this.config.dataDir, "screenshare", safeStreamId)
      : null;
    const screenShareFramesDir =
      screenShareDir && this.config.screenShareStoreAllFrames
        ? path.join(screenShareDir, "frames")
        : null;
    const screenShareUniqueDir = screenShareDir ? path.join(screenShareDir, "unique") : null;
    const screenShareUniqueFramesDir = screenShareUniqueDir
      ? path.join(screenShareUniqueDir, "frames")
      : null;

    if (audioDir) {
      await mkdir(audioDir, { recursive: true });
    }
    if (screenShareFramesDir) {
      await mkdir(screenShareFramesDir, { recursive: true });
    }
    if (screenShareUniqueFramesDir) {
      await mkdir(screenShareUniqueFramesDir, { recursive: true });
    }
    await mkdir(transcriptDir, { recursive: true });

    const transcriptPath = path.join(transcriptDir, `${safeStreamId}.ndjson`);
    const metadataPath = audioDir ? path.join(audioDir, "metadata.ndjson") : null;
    const screenShareMetadataPath = screenShareDir
      && this.config.screenShareStoreAllFrames
      ? path.join(screenShareDir, "metadata.ndjson")
      : null;
    const screenShareUniqueMetadataPath = screenShareUniqueDir
      ? path.join(screenShareUniqueDir, "unique_metadata.ndjson")
      : null;
    const screenShareTimelinePath = screenShareDir
      ? path.join(screenShareDir, "timeline.ndjson")
      : null;
    const client = new rtms.Client();
    const session: RtmsSession = {
      streamId,
      safeStreamId,
      meetingUuid: typeof payload.meeting_uuid === "string" ? payload.meeting_uuid : null,
      status: "starting",
      client,
      startedAt: new Date().toISOString(),
      joinedAt: null,
      closedAt: null,
      joinReason: null,
      lastAudioAt: null,
      lastTranscriptAt: null,
      lastScreenShareAt: null,
      audioBytes: 0,
      audioLimitReached: false,
      audioDir,
      transcriptPath,
      metadataPath,
      screenShareDir,
      screenShareFramesDir,
      screenShareMetadataPath,
      screenShareMetadataStream: screenShareMetadataPath
        ? createWriteStream(screenShareMetadataPath, { flags: "a" })
        : null,
      screenShareUniqueDir,
      screenShareUniqueFramesDir,
      screenShareUniqueMetadataPath,
      screenShareUniqueMetadataStream: screenShareUniqueMetadataPath
        ? createWriteStream(screenShareUniqueMetadataPath, { flags: "a" })
        : null,
      screenShareTimelinePath,
      screenShareTimelineStream: screenShareTimelinePath
        ? createWriteStream(screenShareTimelinePath, { flags: "a" })
        : null,
      screenShareBytes: 0,
      screenShareReceivedBytes: 0,
      screenShareFrames: 0,
      screenShareUniqueFrames: 0,
      screenShareDuplicateFrames: 0,
      screenShareLimitReached: false,
      lastUniqueScreenShareFingerprint: null,
      audioStreams: new Map(),
      metadataStream: metadataPath ? createWriteStream(metadataPath, { flags: "a" }) : null,
      pendingMetadataLines: [],
      flushTimer: null,
      transcriptStream: createWriteStream(transcriptPath, { flags: "a" }),
      lastAudioStatsAtByUser: new Map(),
      lastScreenShareStatsAt: 0,
    };

    this.sessions.set(streamId, session);
    this.configureClient(rtms, session);

    try {
      const joined = client.join(payload);
      session.status = joined ? "joining" : "join-failed";
      this.emit("rtms-stream-started", {
        streamId,
        meetingUuid: session.meetingUuid,
        joined,
        transcriptPath,
        audioDir,
        screenShareDir,
        screenShareUniqueDir,
      });

      if (!joined) {
        this.closeSession(streamId, "join-returned-false", false);
      }
    } catch (error) {
      this.emit("rtms-error", {
        streamId,
        message: error instanceof Error ? error.message : String(error),
      });
      this.closeSession(streamId, "join-error", false);
    }
  }

  private handleStopped(webhook: RtmsWebhookPayload): void {
    const streamId = this.streamIdFromWebhook(webhook);

    if (!streamId) {
      this.emit("rtms-error", {
        event: webhook.event,
        message: "meeting.rtms_stopped webhook is missing payload.rtms_stream_id",
      });
      return;
    }

    this.emit("rtms-stream-stopped", { streamId, eventTs: webhook.event_ts });
    this.closeSession(streamId, "webhook-stopped", true);
  }

  private configureClient(rtms: RtmsModuleLike, session: RtmsSession): void {
    session.client.setAudioParams?.({
      contentType: rtms.AudioContentType?.RAW_AUDIO ?? 2,
      codec: rtms.AudioCodec?.L16 ?? 1,
      sampleRate: rtms.AudioSampleRate?.SR_16K ?? 1,
      channel: rtms.AudioChannel?.MONO ?? 1,
      dataOpt: rtms.AudioDataOption?.AUDIO_MULTI_STREAMS ?? 2,
      duration: 20,
      frameSize: 320,
    });

    if (this.config.transcriptEnabled) {
      session.client.setTranscriptParams?.({
        srcLanguage: rtms.TranscriptLanguage?.NONE ?? -1,
        enableLid: true,
      });
    }

    if (this.config.screenShareEnabled) {
      const params = this.screenShareParams(rtms);
      try {
        const configured = session.client.setDeskshareParams?.(params) ?? false;
        this.emit("rtms-screen-share-configured", {
          streamId: session.streamId,
          params,
          configured,
          screenShareDir: session.screenShareDir,
        });
      } catch (error) {
        this.emit("rtms-screen-share-error", {
          streamId: session.streamId,
          stage: "configure",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    session.client.onJoinConfirm?.((reason) => {
      session.status = reason === 0 ? "joined" : "join-failed";
      session.joinReason = reason;
      session.joinedAt = new Date().toISOString();
      this.emit("rtms-join-confirm", {
        streamId: session.streamId,
        meetingUuid: session.meetingUuid,
        reason,
      });
    });

    session.client.onLeave?.((reason) => {
      this.emit("rtms-sdk-left", {
        streamId: session.streamId,
        meetingUuid: session.meetingUuid,
        reason,
      });
      this.closeSession(session.streamId, `sdk-left:${reason}`, false);
    });

    session.client.onSessionUpdate?.((op, sessionInfo) => {
      this.emit("rtms-session-update", {
        streamId: session.streamId,
        op,
        sessionInfo,
      });
    });

    session.client.onParticipantEvent?.((event, timestamp, participants) => {
      this.emit("rtms-participant-event", {
        streamId: session.streamId,
        event,
        timestamp,
        participants,
      });
    });

    session.client.onActiveSpeakerEvent?.((timestamp, userId, userName) => {
      this.emit("rtms-active-speaker", {
        streamId: session.streamId,
        timestamp,
        userId,
        userName,
      });
    });

    if (this.config.screenShareEnabled) {
      session.client.onSharingEvent?.((event, timestamp, userId, userName) => {
        this.emit("rtms-screen-share-event", {
          streamId: session.streamId,
          meetingUuid: session.meetingUuid,
          event,
          timestamp,
          userId: typeof userId === "number" ? userId : null,
          userName: userName ?? null,
        });
      });
    }

    session.client.onMediaConnectionInterrupted?.((timestamp) => {
      this.emit("rtms-media-interrupted", {
        streamId: session.streamId,
        timestamp,
      });
    });

    session.client.onAudioData?.((buffer, size, timestamp, metadata) => {
      this.handleAudioData(session, bufferFrom(buffer), size, timestamp, metadata);
    });

    if (this.config.screenShareEnabled) {
      session.client.onDeskshareData?.((buffer, size, timestamp, metadata) => {
        this.handleScreenShareData(session, bufferFrom(buffer), size, timestamp, metadata);
      });
    }

    if (this.config.transcriptEnabled) {
      session.client.onTranscriptData?.((buffer, size, timestamp, metadata) => {
        this.handleTranscriptData(session, bufferFrom(buffer), size, timestamp, metadata);
      });
    }
  }

  private screenShareParams(rtms: RtmsModuleLike): Record<string, unknown> {
    const codec = this.config.screenShareCodec.trim().toUpperCase();
    const resolution = this.config.screenShareResolution.trim().toUpperCase();

    return {
      contentType: constantValue(
        rtms.VideoContentType,
        "RAW_VIDEO",
        VIDEO_CONTENT_TYPE_FALLBACKS.RAW_VIDEO,
      ),
      codec: constantValue(
        rtms.VideoCodec,
        codec,
        VIDEO_CODEC_FALLBACKS[codec] ?? VIDEO_CODEC_FALLBACKS.JPG,
      ),
      resolution: constantValue(
        rtms.VideoResolution,
        resolution,
        VIDEO_RESOLUTION_FALLBACKS[resolution] ?? VIDEO_RESOLUTION_FALLBACKS.FHD,
      ),
      fps: this.config.screenShareFps,
    };
  }

  private handleAudioData(
    session: RtmsSession,
    buffer: Buffer,
    size: number,
    timestamp: number,
    metadata: RtmsMetadata,
  ): void {
    const receivedAt = new Date().toISOString();
    const actualSize = Number.isFinite(size) ? size : buffer.length;
    session.lastAudioAt = receivedAt;

    if (this.config.audioPersist && session.audioDir && session.metadataStream) {
      if (session.audioBytes + actualSize <= this.config.audioMaxBytesPerStream) {
        const userKey = sanitizePathPart(metadata.userId ?? metadata.userName ?? "unknown");
        const audioStream = this.audioStreamFor(session, userKey);
        const audioBuffer = Buffer.from(buffer.subarray(0, actualSize));
        audioStream.pending.push(audioBuffer);
        audioStream.pendingBytes += audioBuffer.length;
        session.audioBytes += actualSize;
        session.pendingMetadataLines.push(
          JSON.stringify({
            streamId: session.streamId,
            userKey,
            timestamp,
            size: actualSize,
            receivedAt,
            ...metadataPayload(metadata),
          }),
        );
        this.scheduleAudioFlush(session);
      } else if (!session.audioLimitReached) {
        session.audioLimitReached = true;
        this.emit("rtms-audio-limit-reached", {
          streamId: session.streamId,
          maxBytes: this.config.audioMaxBytesPerStream,
          currentBytes: session.audioBytes,
        });
      }
    }

    this.hooks.onAudioData?.({
      streamId: session.streamId,
      meetingUuid: session.meetingUuid,
      timestamp,
      size: actualSize,
      receivedAt,
      buffer: Buffer.from(buffer.subarray(0, actualSize)),
      userId: typeof metadata.userId === "number" ? metadata.userId : null,
      userName: metadata.userName ?? null,
    });
    this.emitAudioStats(session, actualSize, timestamp, metadata);
  }

  private handleScreenShareData(
    session: RtmsSession,
    buffer: Buffer,
    size: number,
    timestamp: number,
    metadata: RtmsMetadata,
  ): void {
    const receivedAt = new Date().toISOString();
    const actualSize =
      Number.isFinite(size) && size > 0 ? Math.min(size, buffer.length) : buffer.length;

    session.lastScreenShareAt = receivedAt;
    session.screenShareFrames += 1;
    session.screenShareReceivedBytes += actualSize;

    if (!session.screenShareTimelineStream || actualSize <= 0) {
      return;
    }

    const frameId = session.screenShareFrames;
    const userKey = sanitizePathPart(metadata.userId ?? metadata.userName ?? "unknown");
    const extension = screenShareFileExtension(this.config.screenShareCodec);
    const frame = Buffer.from(buffer.subarray(0, actualSize));
    const baseFileName = `${String(frameId).padStart(8, "0")}_${sanitizePathPart(timestamp)}_${userKey}.${extension}`;
    const metadataFields = metadataPayload(metadata);

    let fingerprint: ScreenShareFingerprint | null = null;
    let diffFromPreviousUnique: number | null = null;
    let uniqueDecision = {
      unique: true,
      diff: null as ReturnType<typeof isUniqueScreenShare>["diff"],
    };

    if (this.config.screenShareCodec.trim().toUpperCase() === "JPG") {
      try {
        fingerprint = screenShareFingerprintFromJpeg(frame);
        uniqueDecision = isUniqueScreenShare(
          session.lastUniqueScreenShareFingerprint,
          fingerprint,
          this.config.screenShareUniqueDiffThreshold,
          this.config.screenShareContentDiffThreshold,
          this.config.screenShareContentChangedFrac,
        );
        diffFromPreviousUnique = uniqueDecision.diff?.score ?? null;
      } catch (error) {
        this.emit("rtms-screen-share-error", {
          streamId: session.streamId,
          frameId,
          stage: "fingerprint",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const isUnique =
      !fingerprint || uniqueDecision.unique;
    const willStoreAll =
      this.config.screenShareStoreAllFrames &&
      Boolean(session.screenShareFramesDir && session.screenShareMetadataStream);
    const willStoreUnique =
      isUnique &&
      Boolean(session.screenShareUniqueFramesDir && session.screenShareUniqueMetadataStream);
    const bytesToStore =
      (willStoreAll ? actualSize : 0) + (willStoreUnique ? actualSize : 0);

    if (bytesToStore > 0 && session.screenShareBytes + bytesToStore > this.config.screenShareMaxBytesPerStream) {
      if (!session.screenShareLimitReached) {
        session.screenShareLimitReached = true;
        this.emit("rtms-screen-share-limit-reached", {
          streamId: session.streamId,
          maxBytes: this.config.screenShareMaxBytesPerStream,
          currentBytes: session.screenShareBytes,
        });
      }
      return;
    }

    const uniqueFrameId = isUnique ? session.screenShareUniqueFrames + 1 : session.screenShareUniqueFrames;
    const uniqueFileName = `${String(uniqueFrameId).padStart(8, "0")}_${sanitizePathPart(timestamp)}_${userKey}.${extension}`;
    const uniqueFilePath =
      session.screenShareUniqueFramesDir && isUnique
        ? path.join(session.screenShareUniqueFramesDir, uniqueFileName)
        : null;
    const allFilePath =
      session.screenShareFramesDir && willStoreAll
        ? path.join(session.screenShareFramesDir, baseFileName)
        : null;
    const timelineEntry = {
      streamId: session.streamId,
      meetingUuid: session.meetingUuid,
      frameId,
      uniqueFrameId: uniqueFrameId > 0 ? uniqueFrameId : null,
      isUnique,
      duplicateOfUniqueFrameId: isUnique ? null : uniqueFrameId || null,
      fileName: willStoreAll ? baseFileName : null,
      filePath: allFilePath,
      uniqueFileName: isUnique ? uniqueFileName : null,
      uniqueFilePath,
      timestamp,
      size: actualSize,
      receivedAt,
      codec: this.config.screenShareCodec,
      mimeType: screenShareMimeType(this.config.screenShareCodec),
      resolution: this.config.screenShareResolution,
      fps: this.config.screenShareFps,
      diffFromPreviousUnique,
      fullMeanAbs: uniqueDecision.diff?.fullMeanAbs ?? null,
      contentMeanAbs: uniqueDecision.diff?.contentMeanAbs ?? null,
      contentChangedFrac: uniqueDecision.diff?.contentChangedFrac ?? null,
      threshold: this.config.screenShareUniqueDiffThreshold,
      contentDiffThreshold: this.config.screenShareContentDiffThreshold,
      contentChangedFracThreshold: this.config.screenShareContentChangedFrac,
      ...metadataFields,
    };

    if (session.status !== "closed") {
      session.screenShareTimelineStream.write(`${JSON.stringify(timelineEntry)}\n`);
    }

    if (!isUnique) {
      session.screenShareDuplicateFrames += 1;
      this.emit("screen-duplicate-frame", timelineEntry);
      this.emit("rtms-screen-share-frame", timelineEntry);
      this.emitScreenShareStats(session, actualSize, timestamp, metadata);
      return;
    }

    session.screenShareUniqueFrames = uniqueFrameId;
    session.screenShareBytes += bytesToStore;
    if (fingerprint) {
      session.lastUniqueScreenShareFingerprint = fingerprint;
    }

    void (async () => {
      try {
        if (allFilePath) {
          await writeFile(allFilePath, frame);
        }
        if (!uniqueFilePath) {
          throw new Error("screen share unique frame path is not configured");
        }
        await writeFile(uniqueFilePath, frame);

        const uniqueEntry: RtmsScreenShareFrameEvent = {
          streamId: session.streamId,
          meetingUuid: session.meetingUuid,
          frameId,
          uniqueFrameId,
          fileName: uniqueFileName,
          filePath: uniqueFilePath,
          timestamp,
          size: actualSize,
          receivedAt,
          codec: this.config.screenShareCodec,
          resolution: this.config.screenShareResolution,
          fps: this.config.screenShareFps,
          diffFromPreviousUnique,
          fullMeanAbs: uniqueDecision.diff?.fullMeanAbs ?? null,
          contentMeanAbs: uniqueDecision.diff?.contentMeanAbs ?? null,
          contentChangedFrac: uniqueDecision.diff?.contentChangedFrac ?? null,
          ...metadataFields,
        };

        if (session.status !== "closed") {
          if (allFilePath) {
            session.screenShareMetadataStream?.write(
              `${JSON.stringify({ ...timelineEntry, fileName: baseFileName, filePath: allFilePath })}\n`,
            );
          }
          session.screenShareUniqueMetadataStream?.write(`${JSON.stringify(uniqueEntry)}\n`);
        }

        this.emit("screen-unique-frame", uniqueEntry);
        this.emit("rtms-screen-share-frame", uniqueEntry);
        this.hooks.onScreenShareFrame?.(uniqueEntry);
        this.emitScreenShareStats(session, actualSize, timestamp, metadata);
      } catch (error) {
        this.emit("rtms-screen-share-error", {
          streamId: session.streamId,
          frameId,
          fileName: uniqueFileName,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }

  private handleTranscriptData(
    session: RtmsSession,
    buffer: Buffer,
    size: number,
    timestamp: number,
    metadata: RtmsMetadata,
  ): void {
    const text = buffer.toString("utf8").trim();

    if (!text) {
      return;
    }

    const entry: RtmsTranscriptEntry = {
      id: ++this.transcriptId,
      streamId: session.streamId,
      meetingUuid: session.meetingUuid,
      userId: typeof metadata.userId === "number" ? metadata.userId : null,
      userName: metadata.userName ?? null,
      text,
      timestamp,
      size: Number.isFinite(size) ? size : buffer.length,
      createdAt: new Date().toISOString(),
    };

    session.lastTranscriptAt = entry.createdAt;
    this.transcriptMemory.push(entry);
    if (this.transcriptMemory.length > this.config.transcriptMemoryLimit) {
      this.transcriptMemory.splice(
        0,
        this.transcriptMemory.length - this.config.transcriptMemoryLimit,
      );
    }

    session.transcriptStream.write(`${JSON.stringify(entry)}\n`);
    this.emit("rtms-transcript", entry);
  }

  private audioStreamFor(session: RtmsSession, userKey: string): BufferedAudioStream {
    const existing = session.audioStreams.get(userKey);

    if (existing) {
      return existing;
    }

    const audioPath = path.join(session.audioDir ?? this.config.dataDir, `${userKey}.raw`);
    const stream = createWriteStream(audioPath, { flags: "a" });
    const buffered = { stream, pending: [], pendingBytes: 0 };
    session.audioStreams.set(userKey, buffered);
    return buffered;
  }

  private scheduleAudioFlush(session: RtmsSession): void {
    if (session.flushTimer) {
      return;
    }

    session.flushTimer = setTimeout(() => {
      session.flushTimer = null;
      this.flushAudio(session);
    }, this.config.audioFlushIntervalMs);
  }

  private flushAudio(session: RtmsSession): void {
    for (const audioStream of session.audioStreams.values()) {
      if (audioStream.pending.length === 0) {
        continue;
      }

      audioStream.stream.write(Buffer.concat(audioStream.pending, audioStream.pendingBytes));
      audioStream.pending = [];
      audioStream.pendingBytes = 0;
    }

    if (session.metadataStream && session.pendingMetadataLines.length > 0) {
      session.metadataStream.write(`${session.pendingMetadataLines.join("\n")}\n`);
      session.pendingMetadataLines = [];
    }
  }

  private emitAudioStats(
    session: RtmsSession,
    size: number,
    timestamp: number,
    metadata: RtmsMetadata,
  ): void {
    const userKey = sanitizePathPart(metadata.userId ?? metadata.userName ?? "unknown");
    const now = Date.now();
    const last = session.lastAudioStatsAtByUser.get(userKey) ?? 0;

    if (now - last < 5_000) {
      return;
    }

    session.lastAudioStatsAtByUser.set(userKey, now);
    this.emit("rtms-audio-stats", {
      streamId: session.streamId,
      timestamp,
      size,
      audioBytes: session.audioBytes,
      audioLimitReached: session.audioLimitReached,
      ...metadataPayload(metadata),
    });
  }

  private emitScreenShareStats(
    session: RtmsSession,
    size: number,
    timestamp: number,
    metadata: RtmsMetadata,
  ): void {
    const now = Date.now();
    if (now - session.lastScreenShareStatsAt < 5_000) {
      return;
    }

    session.lastScreenShareStatsAt = now;
    this.emit("rtms-screen-share-stats", {
      streamId: session.streamId,
      timestamp,
      size,
      screenShareBytes: session.screenShareBytes,
      screenShareReceivedBytes: session.screenShareReceivedBytes,
      screenShareFrames: session.screenShareFrames,
      screenShareUniqueFrames: session.screenShareUniqueFrames,
      screenShareDuplicateFrames: session.screenShareDuplicateFrames,
      screenShareLimitReached: session.screenShareLimitReached,
      screenShareDir: session.screenShareDir,
      screenShareUniqueDir: session.screenShareUniqueDir,
      ...metadataPayload(metadata),
    });
  }

  private closeSession(streamId: string, reason: string, leaveClient: boolean): void {
    const session = this.sessions.get(streamId);

    if (!session) {
      return;
    }

    this.sessions.delete(streamId);
    session.status = "closed";
    session.closedAt = new Date().toISOString();
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    this.flushAudio(session);

    if (leaveClient) {
      try {
        session.client.leave();
      } catch (error) {
        this.emit("rtms-error", {
          streamId,
          reason,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const audioStream of session.audioStreams.values()) {
      audioStream.stream.end();
    }
    session.metadataStream?.end();
    session.screenShareMetadataStream?.end();
    session.screenShareUniqueMetadataStream?.end();
    session.screenShareTimelineStream?.end();
    session.transcriptStream.end();
    void this.hooks.onSessionClosed?.({
      streamId,
      meetingUuid: session.meetingUuid,
      reason,
      startedAt: session.startedAt,
      closedAt: session.closedAt,
    });

    this.emit("rtms-left", {
      streamId,
      meetingUuid: session.meetingUuid,
      reason,
      closedAt: session.closedAt,
      audioBytes: session.audioBytes,
      transcriptPath: session.transcriptPath,
      audioDir: session.audioDir,
      screenShareBytes: session.screenShareBytes,
      screenShareReceivedBytes: session.screenShareReceivedBytes,
      screenShareFrames: session.screenShareFrames,
      screenShareUniqueFrames: session.screenShareUniqueFrames,
      screenShareDuplicateFrames: session.screenShareDuplicateFrames,
      screenShareDir: session.screenShareDir,
      screenShareUniqueDir: session.screenShareUniqueDir,
    });
  }

  private streamIdFromWebhook(webhook: RtmsWebhookPayload): string {
    const streamId = webhook.payload?.rtms_stream_id;
    return typeof streamId === "string" ? streamId : "";
  }
}
