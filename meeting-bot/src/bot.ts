import * as ZoomMtgEmbeddedModule from "@zoom/meetingsdk/embedded.js";

type EmbeddedClient = {
  init(args: Record<string, unknown>): Promise<unknown>;
  join(args: Record<string, unknown>): Promise<unknown>;
  sendChat(message: string, userId?: number): Promise<unknown>;
  getCurrentUser(): { userId: number; userName?: string; displayName?: string } | null;
  leaveMeeting(userId?: number): Promise<unknown>;
  on(event: string, callback: (payload: unknown) => void): void;
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
};

type SignatureResponse = {
  signature: string;
  meetingNumber: string;
  password: string;
  userName: string;
};

type BotStatus =
  | "booting"
  | "initializing"
  | "joining"
  | "joined"
  | "closed"
  | "error";

declare global {
  interface Window {
    zoomBotReady?: boolean;
    zoomBotState?: {
      status: BotStatus;
      detail?: unknown;
      updatedAt: string;
    };
    zoomBotSendChat?: (
      message: string,
      userId?: number,
    ) => Promise<unknown>;
    zoomBotLeaveMeeting?: () => Promise<unknown>;
  }
}

const ZoomMtgEmbedded = (
  "default" in ZoomMtgEmbeddedModule
    ? ZoomMtgEmbeddedModule.default
    : ZoomMtgEmbeddedModule
) as unknown as { createClient(): EmbeddedClient };

const client = ZoomMtgEmbedded.createClient();
const statusText = document.getElementById("statusText");
const AUTO_REPLY_TEXT = "Hello, I'm ECHO AI meeting bot. What can I do for you?";

let botDisplayName = "";
let currentUser: ChatParticipant | null = null;

function safeClone(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function errorPayload(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }

  return { message: String(error) };
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function chatMessageText(payload: ChatPayload): string {
  if (Array.isArray(payload.message)) {
    return payload.message.join(" ");
  }

  return payload.message ?? "";
}

function refreshCurrentUser(): ChatParticipant | null {
  try {
    const user = client.getCurrentUser();

    if (user) {
      currentUser = {
        name: user.userName || user.displayName,
        userId: user.userId,
      };
    }
  } catch (error) {
    console.warn("Failed to get current Zoom user", error);
  }

  return currentUser;
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

  return Boolean(left.name && right.name && normalizeText(left.name) === normalizeText(right.name));
}

function isFromBot(payload: ChatPayload): boolean {
  if (sameParticipant(payload.sender, currentUser ?? refreshCurrentUser())) {
    return true;
  }

  return Boolean(
    payload.sender?.name &&
      botDisplayName &&
      normalizeText(payload.sender.name) === normalizeText(botDisplayName),
  );
}

function isPrivateToBot(payload: ChatPayload): boolean {
  if (sameParticipant(payload.receiver, currentUser ?? refreshCurrentUser())) {
    return true;
  }

  return Boolean(
    payload.receiver?.name &&
      botDisplayName &&
      normalizeText(payload.receiver.name) === normalizeText(botDisplayName),
  );
}

function isPublicChat(payload: ChatPayload): boolean {
  const receiverName = normalizeText(payload.receiver?.name);

  return (
    payload.receiver?.userId === 0 ||
    receiverName === "everyone" ||
    receiverName.includes("everyone")
  );
}

function isMentioningBot(payload: ChatPayload): boolean {
  const message = normalizeText(chatMessageText(payload));

  if (!message) {
    return false;
  }

  const names = new Set(
    [
      "bot",
      "echo",
      "echo ai assistant",
      botDisplayName,
      currentUser?.name,
    ]
      .map(normalizeText)
      .filter(Boolean),
  );

  for (const name of names) {
    if (message.includes(`@${name}`)) {
      return true;
    }
  }

  return false;
}

function classifyAutoReply(payload: unknown): "private" | "public-mention" | null {
  const chat = payload as ChatPayload;

  if (!chat.sender || isFromBot(chat)) {
    return null;
  }

  if (isPrivateToBot(chat)) {
    return "private";
  }

  if (isPublicChat(chat) && isMentioningBot(chat)) {
    return "public-mention";
  }

  return null;
}

async function maybeAutoReply(payload: unknown): Promise<void> {
  const chat = payload as ChatPayload;
  const replyType = classifyAutoReply(chat);

  if (!replyType) {
    return;
  }

  try {
    const replyToUserId = replyType === "private" ? chat.sender?.userId : undefined;

    if (replyType === "private" && typeof replyToUserId !== "number") {
      await postBotEvent("auto-reply-error", {
        replyType,
        trigger: safeClone(chat),
        error: { message: "Cannot reply privately because sender.userId is missing" },
      });
      return;
    }

    const result =
      typeof replyToUserId === "number"
        ? await client.sendChat(AUTO_REPLY_TEXT, replyToUserId)
        : await client.sendChat(AUTO_REPLY_TEXT);

    await postBotEvent("auto-reply-sent", {
      replyType,
      message: AUTO_REPLY_TEXT,
      replyToUserId,
      trigger: safeClone(chat),
      result: safeClone(result),
    });
  } catch (error) {
    await postBotEvent("auto-reply-error", {
      replyType,
      trigger: safeClone(chat),
      error: errorPayload(error),
    });
  }
}

async function postBotEvent(type: string, payload: unknown = {}): Promise<void> {
  try {
    await fetch("/bot/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type,
        payload: safeClone(payload),
        sentAt: new Date().toISOString(),
      }),
    });
  } catch (error) {
    console.warn("Failed to post bot event", error);
  }
}

function setStatus(status: BotStatus, detail?: unknown): void {
  window.zoomBotState = {
    status,
    detail: safeClone(detail),
    updatedAt: new Date().toISOString(),
  };

  if (statusText) {
    statusText.textContent = detail
      ? `${status}: ${JSON.stringify(safeClone(detail)).slice(0, 180)}`
      : status;
  }
}

async function fetchSignature(): Promise<SignatureResponse> {
  const response = await fetch("/signature");

  if (!response.ok) {
    throw new Error(`Signature request failed: HTTP ${response.status}`);
  }

  return (await response.json()) as SignatureResponse;
}

function registerZoomEvents(userName: string): void {
  botDisplayName = userName;

  client.on("connection-change", (payload: unknown) => {
    const state = (payload as { state?: string } | undefined)?.state;

    if (state === "Connected") {
      setStatus("joined", payload);
      const user = refreshCurrentUser();
      if (user) {
        void postBotEvent("bot-user", user);
      }
    } else if (state === "Closed") {
      setStatus("closed", payload);
    }

    void postBotEvent("connection-change", payload);
  });

  client.on("chat-on-message", (payload: unknown) => {
    void postBotEvent("chat-on-message", payload);
  });

  client.on("join-speed", (payload: unknown) => {
    void postBotEvent("join-speed", payload);
  });
}

async function boot(): Promise<void> {
  try {
    setStatus("booting");
    await postBotEvent("booting");

    const signature = await fetchSignature();
    const zoomRoot = document.getElementById("meetingSDKElement");

    if (!zoomRoot) {
      throw new Error("Missing #meetingSDKElement container");
    }

    setStatus("initializing");
    await client.init({
      zoomAppRoot: zoomRoot,
      language: "en-US",
      patchJsMedia: true,
      leaveOnPageUnload: true,
    });

    registerZoomEvents(signature.userName);

    window.zoomBotSendChat = async (
      message: string,
      userId?: number,
    ): Promise<unknown> => {
      const result =
        typeof userId === "number"
          ? await client.sendChat(message, userId)
          : await client.sendChat(message);

      const cloned = safeClone(result);
      await postBotEvent("chat-sent", { message, userId, result: cloned });
      return cloned;
    };

    window.zoomBotLeaveMeeting = async (): Promise<unknown> => {
      const result = await client.leaveMeeting();
      const cloned = safeClone(result);
      await postBotEvent("leave-requested", { result: cloned });
      return cloned;
    };

    setStatus("joining", {
      meetingNumber: signature.meetingNumber,
      userName: signature.userName,
    });

    const joinResult = await client.join({
      signature: signature.signature,
      meetingNumber: signature.meetingNumber,
      password: signature.password,
      userName: signature.userName,
    });

    setStatus("joined", joinResult);
    const user = refreshCurrentUser();
    window.zoomBotReady = true;
    await postBotEvent("bot-user", user);
    await postBotEvent("joined", joinResult);
  } catch (error) {
    const payload = errorPayload(error);
    setStatus("error", payload);
    window.zoomBotReady = true;
    await postBotEvent("error", payload);
    throw error;
  }
}

void boot();
