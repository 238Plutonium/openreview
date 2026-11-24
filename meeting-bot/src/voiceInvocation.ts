export type VoiceInvocationConfig = {
  enabled: boolean;
  available: boolean;
  unavailableReasons: string[];
  wakePhrases: string[];
  followupTimeoutMs: number;
  maxQuestionMs: number;
  maxQuestionChars: number;
  cooldownMs: number;
};

export type VoiceTranscriptBoundary =
  | "max-window"
  | "speaker-idle"
  | "stream-flush";

export type VoiceTranscriptInput = {
  streamId: string;
  meetingUuid: string | null;
  userId: number | null;
  userName: string | null;
  text: string;
  startTimestamp: number;
  endTimestamp: number;
  boundary: VoiceTranscriptBoundary;
};

export type VoiceQuestion = {
  question: string;
  streamId: string;
  meetingUuid: string | null;
  userId: number | null;
  userName: string | null;
  wakePhrase: string;
  wakeStartedAt: number;
  questionEndedAt: number;
  rawTranscripts: VoiceTranscriptInput[];
};

export type VoiceInvocationEventEmitter = (type: string, payload?: unknown) => void;
export type VoiceQuestionHandler = (question: VoiceQuestion) => void;

type TimerHandle = ReturnType<typeof setTimeout>;

type VoiceInvocationRuntime = {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
};

type WakePhrase = {
  configured: string;
  normalized: string;
  tokens: string[];
  variants: string[][];
};

type WakeMatch = {
  phrase: WakePhrase;
  /** Matched wake tokens (after filler stripping). */
  tokenCount: number;
  /** Index of the wake phrase within wakeComparableOriginalTokens(text). */
  startIndex: number;
};

type SpeakerState = {
  key: string;
  phase: "idle" | "collecting" | "cooldown";
  streamId: string;
  meetingUuid: string | null;
  userId: number | null;
  userName: string | null;
  utteranceText: string;
  utteranceTranscripts: VoiceTranscriptInput[];
  utteranceRole: "wake" | "followup";
  wakePhrase: string;
  wakeTokenCount: number;
  wakeStartIndex: number;
  wakeStartedAt: number;
  questionText: string;
  rawTranscripts: VoiceTranscriptInput[];
  followupTimer: TimerHandle | null;
  maxQuestionTimer: TimerHandle | null;
  cooldownTimer: TimerHandle | null;
  cooldownUntil: number;
};

const WAKE_FILLER_TOKENS = new Set(["i'm", "im", "i", "am", "a", "an"]);

const defaultRuntime: VoiceInvocationRuntime = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

function canonicalAi(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\ba\s*(?:[.\-_]\s*)?i\b/giu, "AI");
}

export function voiceTokens(value: string): string[] {
  return canonicalAi(value).match(/[\p{L}\p{N}']+/gu) ?? [];
}

function normalizedToken(value: string): string {
  return value.toLocaleLowerCase();
}

function canonicalWakeToken(value: string): string {
  const normalized = normalizedToken(value);
  if (["eco", "iko"].includes(normalized)) {
    return "echo";
  }
  return normalized;
}

function wakeComparableOriginalTokens(value: string): string[] {
  const tokens = voiceTokens(value);
  // Whisper often inserts fillers after hi/hello, e.g. "Hi, I'm Echo AI…",
  // including when the wake sits after a short preamble ("Um, hi…").
  const result: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    result.push(tokens[index]!);
    const current = canonicalWakeToken(tokens[index]!);
    if (current !== "hi" && current !== "hello") {
      continue;
    }
    while (
      index + 1 < tokens.length &&
      WAKE_FILLER_TOKENS.has(canonicalWakeToken(tokens[index + 1]!))
    ) {
      index += 1;
    }
  }
  return result;
}

function wakeComparableTokens(value: string): string[] {
  return wakeComparableOriginalTokens(value).map(canonicalWakeToken);
}

function wakeVariants(tokens: string[]): string[][] {
  const variants = [tokens];
  const aiIndex = tokens.indexOf("ai");
  if (aiIndex > 0 && tokens[aiIndex + 1] === "assistant") {
    variants.push(tokens.filter((_, index) => index !== aiIndex));
    variants.push(tokens.slice(0, aiIndex));
  }
  return Array.from(
    new Map(variants.map((variant) => [variant.join("\u0000"), variant])).values(),
  ).sort((left, right) => right.length - left.length);
}

export function normalizeVoiceText(value: string): string {
  return voiceTokens(value).map(normalizedToken).join(" ");
}

export function mergeVoiceTranscripts(previous: string, next: string): string {
  const left = voiceTokens(previous);
  const right = voiceTokens(next);

  if (left.length === 0) {
    return right.join(" ");
  }
  if (right.length === 0) {
    return left.join(" ");
  }

  const leftNormalized = left.map(normalizedToken);
  const rightNormalized = right.map(normalizedToken);
  const maxOverlap = Math.min(left.length, right.length);
  let overlap = 0;

  for (let size = maxOverlap; size > 0; size -= 1) {
    const leftStart = leftNormalized.length - size;
    let matches = true;
    for (let index = 0; index < size; index += 1) {
      if (leftNormalized[leftStart + index] !== rightNormalized[index]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      overlap = size;
      break;
    }
  }

  return [...left, ...right.slice(overlap)].join(" ");
}

function speakerKey(input: Pick<VoiceTranscriptInput, "streamId" | "userId" | "userName">): string {
  return `${input.streamId}:${input.userId ?? input.userName ?? "unknown"}`;
}

function questionAfterWake(
  text: string,
  wakeStartIndex: number,
  wakeTokenCount: number,
): string {
  return wakeComparableOriginalTokens(text)
    .slice(wakeStartIndex + wakeTokenCount)
    .join(" ")
    .trim();
}

function isBetterWake(candidate: WakeMatch, current: WakeMatch | null): boolean {
  if (!current) {
    return true;
  }
  if (candidate.tokenCount !== current.tokenCount) {
    return candidate.tokenCount > current.tokenCount;
  }
  // Prefer the earliest wake when lengths tie (ignore later mid-sentence echoes).
  return candidate.startIndex < current.startIndex;
}

export class VoiceInvocationManager {
  private readonly states = new Map<string, SpeakerState>();
  private readonly wakePhrases: WakePhrase[];

  constructor(
    private readonly config: VoiceInvocationConfig,
    private readonly emit: VoiceInvocationEventEmitter,
    private readonly onQuestion: VoiceQuestionHandler,
    private readonly runtime: VoiceInvocationRuntime = defaultRuntime,
  ) {
    this.wakePhrases = config.wakePhrases
      .map((configured) => ({
        configured: configured.trim(),
        normalized: normalizeVoiceText(configured),
        tokens: wakeComparableTokens(configured),
        variants: wakeVariants(wakeComparableTokens(configured)),
      }))
      .filter((phrase) => phrase.tokens.length > 0)
      .sort((left, right) => right.tokens.length - left.tokens.length);
  }

  health() {
    const values = Array.from(this.states.values());
    return {
      enabled: this.config.enabled,
      available: this.config.available,
      unavailableReasons: this.config.unavailableReasons,
      wakePhrases: this.wakePhrases.map((phrase) => phrase.configured),
      followupTimeoutMs: this.config.followupTimeoutMs,
      maxQuestionMs: this.config.maxQuestionMs,
      maxQuestionChars: this.config.maxQuestionChars,
      cooldownMs: this.config.cooldownMs,
      activeInvocations: values.filter((state) => state.phase === "collecting").length,
      cooldownSpeakers: values.filter((state) => state.phase === "cooldown").length,
    };
  }

  ingest(input: VoiceTranscriptInput): void {
    if (!this.config.enabled || !this.config.available) {
      return;
    }

    const key = speakerKey(input);
    const state = this.states.get(key) ?? this.createState(key, input);
    this.refreshSpeaker(state, input);

    if (state.phase === "cooldown") {
      if (this.runtime.now() < state.cooldownUntil) {
        this.emit("voice-invocation-ignored", {
          reason: "cooldown",
          streamId: input.streamId,
          userId: input.userId,
          userName: input.userName,
          boundary: input.boundary,
        });
        return;
      }
      this.resetToIdle(state);
    }

    state.utteranceText = mergeVoiceTranscripts(state.utteranceText, input.text);
    if (input.text.trim()) {
      state.utteranceTranscripts.push(input);
      state.rawTranscripts.push(input);
    }

    if (state.phase === "idle") {
      const wake = this.matchWake(state.utteranceText);
      if (wake) {
        this.startCollection(state, wake, input);
      } else if (input.boundary !== "max-window") {
        state.utteranceText = "";
        state.utteranceTranscripts = [];
        state.rawTranscripts = [];
      }
      return;
    }

    if (state.utteranceRole === "followup") {
      const replacementWake = this.matchWake(state.utteranceText);
      if (replacementWake) {
        this.startCollection(state, replacementWake, input);
        return;
      }
      state.questionText = state.utteranceText.trim();
    } else {
      const extendedWake = this.matchWake(state.utteranceText);
      if (
        extendedWake &&
        isBetterWake(extendedWake, {
          phrase: extendedWake.phrase,
          tokenCount: state.wakeTokenCount,
          startIndex: state.wakeStartIndex,
        })
      ) {
        state.wakePhrase = extendedWake.phrase.configured;
        state.wakeTokenCount = extendedWake.tokenCount;
        state.wakeStartIndex = extendedWake.startIndex;
      }
      state.questionText = questionAfterWake(
        state.utteranceText,
        state.wakeStartIndex,
        state.wakeTokenCount,
      );
    }

    this.emit("voice-question-collecting", {
      streamId: state.streamId,
      userId: state.userId,
      userName: state.userName,
      wakePhrase: state.wakePhrase,
      question: state.questionText,
      boundary: input.boundary,
    });

    if (state.questionText.length >= this.config.maxQuestionChars) {
      state.questionText = state.questionText.slice(0, this.config.maxQuestionChars).trim();
      this.submit(state, input.endTimestamp, "max-characters");
      return;
    }

    if (input.boundary !== "max-window") {
      if (state.questionText) {
        this.submit(state, input.endTimestamp, "speaker-idle");
      } else {
        this.waitForFollowup(state);
      }
    }
  }

  closeStream(streamId: string): void {
    for (const [key, state] of this.states) {
      if (state.streamId !== streamId) {
        continue;
      }
      this.clearTimers(state);
      this.states.delete(key);
    }
  }

  shutdown(): void {
    for (const state of this.states.values()) {
      this.clearTimers(state);
    }
    this.states.clear();
  }

  private createState(key: string, input: VoiceTranscriptInput): SpeakerState {
    const state: SpeakerState = {
      key,
      phase: "idle",
      streamId: input.streamId,
      meetingUuid: input.meetingUuid,
      userId: input.userId,
      userName: input.userName,
      utteranceText: "",
      utteranceTranscripts: [],
      utteranceRole: "wake",
      wakePhrase: "",
      wakeTokenCount: 0,
      wakeStartIndex: 0,
      wakeStartedAt: 0,
      questionText: "",
      rawTranscripts: [],
      followupTimer: null,
      maxQuestionTimer: null,
      cooldownTimer: null,
      cooldownUntil: 0,
    };
    this.states.set(key, state);
    return state;
  }

  private refreshSpeaker(state: SpeakerState, input: VoiceTranscriptInput): void {
    state.meetingUuid = input.meetingUuid;
    state.userId = input.userId;
    state.userName = input.userName;
  }

  private matchWake(text: string): WakeMatch | null {
    const tokens = wakeComparableTokens(text);
    let best: WakeMatch | null = null;
    for (const wake of this.wakePhrases) {
      for (const variant of wake.variants) {
        if (variant.length === 0 || tokens.length < variant.length) {
          continue;
        }
        for (let start = 0; start <= tokens.length - variant.length; start += 1) {
          if (variant.every((token, index) => tokens[start + index] === token)) {
            const candidate = {
              phrase: wake,
              tokenCount: variant.length,
              startIndex: start,
            };
            if (isBetterWake(candidate, best)) {
              best = candidate;
            }
          }
        }
      }
    }
    return best;
  }

  private startCollection(
    state: SpeakerState,
    wake: WakeMatch,
    input: VoiceTranscriptInput,
  ): void {
    this.clearTimers(state);
    state.phase = "collecting";
    state.utteranceRole = "wake";
    state.wakePhrase = wake.phrase.configured;
    state.wakeTokenCount = wake.tokenCount;
    state.wakeStartIndex = wake.startIndex;
    state.wakeStartedAt = input.startTimestamp || input.endTimestamp || this.runtime.now();
    state.questionText = questionAfterWake(
      state.utteranceText,
      state.wakeStartIndex,
      state.wakeTokenCount,
    );
    state.rawTranscripts = [...state.utteranceTranscripts];

    this.emit("voice-wake-detected", {
      streamId: state.streamId,
      meetingUuid: state.meetingUuid,
      userId: state.userId,
      userName: state.userName,
      wakePhrase: state.wakePhrase,
      wakeStartedAt: state.wakeStartedAt,
      question: state.questionText,
    });
    this.emit("voice-question-collecting", {
      streamId: state.streamId,
      userId: state.userId,
      userName: state.userName,
      wakePhrase: state.wakePhrase,
      question: state.questionText,
      boundary: input.boundary,
    });

    if (state.questionText.length >= this.config.maxQuestionChars) {
      state.questionText = state.questionText.slice(0, this.config.maxQuestionChars).trim();
      this.submit(state, input.endTimestamp, "max-characters");
      return;
    }

    state.maxQuestionTimer = this.runtime.setTimeout(() => {
      state.maxQuestionTimer = null;
      if (state.phase !== "collecting") {
        return;
      }
      if (state.questionText) {
        this.submit(state, this.runtime.now(), "max-duration");
      } else {
        this.expire(state, "max-duration");
      }
    }, this.config.maxQuestionMs);

    if (input.boundary !== "max-window") {
      if (state.questionText) {
        this.submit(state, input.endTimestamp, "speaker-idle");
      } else {
        this.waitForFollowup(state);
      }
    }
  }

  private waitForFollowup(state: SpeakerState): void {
    state.utteranceText = "";
    state.utteranceTranscripts = [];
    state.utteranceRole = "followup";
    if (state.followupTimer) {
      this.runtime.clearTimeout(state.followupTimer);
    }
    state.followupTimer = this.runtime.setTimeout(() => {
      state.followupTimer = null;
      if (state.phase === "collecting" && !state.questionText) {
        this.expire(state, "followup-timeout");
      }
    }, this.config.followupTimeoutMs);
  }

  private submit(state: SpeakerState, questionEndedAt: number, reason: string): void {
    const question = state.questionText.trim();
    if (!question) {
      this.expire(state, "empty-question");
      return;
    }

    const payload: VoiceQuestion = {
      question,
      streamId: state.streamId,
      meetingUuid: state.meetingUuid,
      userId: state.userId,
      userName: state.userName,
      wakePhrase: state.wakePhrase,
      wakeStartedAt: state.wakeStartedAt,
      questionEndedAt: questionEndedAt || this.runtime.now(),
      rawTranscripts: [...state.rawTranscripts],
    };

    this.emit("voice-question-submitted", {
      ...payload,
      reason,
      wakeToSubmitMs: Math.max(0, payload.questionEndedAt - payload.wakeStartedAt),
      rawTranscripts: payload.rawTranscripts.map((item) => ({
        text: item.text,
        startTimestamp: item.startTimestamp,
        endTimestamp: item.endTimestamp,
        boundary: item.boundary,
      })),
    });
    this.onQuestion(payload);
    this.enterCooldown(state);
  }

  private expire(state: SpeakerState, reason: string): void {
    this.emit("voice-wake-expired", {
      reason,
      streamId: state.streamId,
      userId: state.userId,
      userName: state.userName,
      wakePhrase: state.wakePhrase,
      wakeStartedAt: state.wakeStartedAt,
    });
    this.resetToIdle(state);
  }

  private enterCooldown(state: SpeakerState): void {
    this.clearTimers(state);
    state.phase = "cooldown";
    state.cooldownUntil = this.runtime.now() + this.config.cooldownMs;
    state.utteranceText = "";
    state.utteranceTranscripts = [];
    state.questionText = "";
    state.rawTranscripts = [];
    state.cooldownTimer = this.runtime.setTimeout(() => {
      state.cooldownTimer = null;
      if (state.phase === "cooldown") {
        this.resetToIdle(state);
      }
    }, this.config.cooldownMs);
  }

  private resetToIdle(state: SpeakerState): void {
    this.clearTimers(state);
    state.phase = "idle";
    state.utteranceText = "";
    state.utteranceTranscripts = [];
    state.utteranceRole = "wake";
    state.wakePhrase = "";
    state.wakeTokenCount = 0;
    state.wakeStartIndex = 0;
    state.wakeStartedAt = 0;
    state.questionText = "";
    state.rawTranscripts = [];
    state.cooldownUntil = 0;
  }

  private clearTimers(state: SpeakerState): void {
    for (const timer of [
      state.followupTimer,
      state.maxQuestionTimer,
      state.cooldownTimer,
    ]) {
      if (timer) {
        this.runtime.clearTimeout(timer);
      }
    }
    state.followupTimer = null;
    state.maxQuestionTimer = null;
    state.cooldownTimer = null;
  }
}
