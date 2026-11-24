import {
  chromium,
  type Browser,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
} from "playwright";
import fs from "node:fs";
import path from "node:path";

export type ZoomWebBotState =
  | "idle"
  | "launching"
  | "loading"
  | "joining"
  | "waiting-room"
  | "joined"
  | "closed"
  | "error";

export type ZoomWebBotConfig = {
  meetingNumber: string;
  meetingPassword: string;
  botName: string;
  browserHeadless: boolean;
  browserChannel: "chromium" | "chrome" | "msedge" | undefined;
  webAppUrl: string;
  webDomain?: string;
  joinTimeoutMs: number;
  pollIntervalMs: number;
  chatMaxChars?: number;
  fakeVideoPath?: string;
  showLogoVideo?: boolean;
};

export type ZoomWebBotEventEmitter = (type: string, payload?: unknown) => void;
export type ZoomWebBotStateSetter = (
  state: ZoomWebBotState,
  error?: unknown,
) => void;

export type ZoomWebChatParticipant = {
  name?: string;
  userId?: number;
};

export type ZoomWebChatReplyTarget = {
  messageId?: string;
  messageIdAttribute?: "data-message-id" | "data-id" | "id";
  senderName: string;
  receiverName: string;
  privateToBot: boolean;
  message: string;
  timeText: string;
  occurrence: number;
};

export type ZoomWebChatPayload = {
  id: string;
  message: string;
  sender: ZoomWebChatParticipant;
  receiver: ZoomWebChatParticipant;
  timestamp: number;
  transport: "zoom-web-app";
  replyTarget?: ZoomWebChatReplyTarget;
  raw?: unknown;
};

export function splitChatMessage(text: string, maxChars: number): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }
  if (normalized.length <= maxChars) {
    return [normalized];
  }

  const parts: string[] = [];
  const paragraphs = normalized.split(/\n\n+/u);
  let current = "";

  const flush = () => {
    if (current.trim()) {
      parts.push(current.trim());
    }
    current = "";
  };

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    flush();

    if (paragraph.length <= maxChars) {
      current = paragraph;
      continue;
    }

    let remaining = paragraph;
    while (remaining.length > maxChars) {
      let splitAt = remaining.lastIndexOf(" ", maxChars);
      if (splitAt < Math.floor(maxChars * 0.5)) {
        splitAt = maxChars;
      }
      parts.push(remaining.slice(0, splitAt).trim());
      remaining = remaining.slice(splitAt).trim();
    }
    current = remaining;
  }

  flush();
  return parts.length > 0 ? parts : [normalized.slice(0, maxChars)];
}

export type ZoomWebChatDomRecord = {
  key?: string;
  text?: string;
  headerText?: string;
  ariaLabel?: string;
  senderText?: string;
  receiverText?: string;
  messageText?: string;
  timeText?: string;
  directMessage?: boolean;
  messageId?: string;
  messageIdAttribute?: "data-message-id" | "data-id" | "id";
};

export type NormalizedZoomWebChatMessage = {
  key: string;
  senderName: string;
  receiverName: string;
  message: string;
  privateToBot: boolean;
  timeText: string;
  occurrence: number;
  messageId?: string;
  messageIdAttribute?: "data-message-id" | "data-id" | "id";
  raw: ZoomWebChatDomRecord;
};

type ZoomWebBotHealth = {
  transport: "zoom-web-app";
  state: ZoomWebBotState;
  browserConnected: boolean;
  pageOpen: boolean;
  frameReady: boolean;
  chatPanelReady: boolean;
  chatBaselineReady: boolean;
  chatDomRecordCount: number;
  normalizedChatMessageCount: number;
  lastChatPollAt: string | null;
  chatDomDiagnostics: ZoomWebChatDomDiagnostics | null;
  knownParticipants: Array<{ userId: number; name: string }>;
};

type ZoomWebChatDomDiagnostics = {
  inputClass: string;
  rootClass: string;
  chatItemContainers: number;
  legacyMessageContainers: number;
  newMessageContainers: number;
  roleRows: number;
};

function compactText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripHeaderFromMessage(text: string, header: string): string {
  const normalizedText = compactText(text);
  const normalizedHeader = compactText(header);
  if (!normalizedHeader || !normalizedText.startsWith(normalizedHeader)) {
    return normalizedText;
  }
  return normalizedText.slice(normalizedHeader.length).trim();
}

function parseHeader(text: string): {
  senderName: string;
  receiverName: string;
  header: string;
} | null {
  const normalized = compactText(text);
  const patterns = [
    /^(.+?)\s+to:?\s+(.+?)\s+\((?:Direct Message|Privately)\)(?:\s+\d{1,2}:\d{2}(?:\s*[AP]M)?)?(?=\s|$)/i,
    /^(.+?)\s+to:?\s+(.+?)\s+\d{1,2}:\d{2}(?:\s*[AP]M)?(?=\s|$)/i,
    /^(.+?)\s+to:?\s+(Everyone(?:\s+in\s+Meeting)?|You|Me)(?=\s|$)/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1] && match[2]) {
      return {
        senderName: compactText(match[1]),
        receiverName: compactText(match[2]),
        header: compactText(match[0]),
      };
    }
  }
  return null;
}

/**
 * Convert the loosely structured records exposed by Zoom Web App into the
 * stable payload shape already consumed by ECHO's AI pipeline.
 */
export function normalizeZoomWebChatRecords(
  records: ZoomWebChatDomRecord[],
  botName: string,
): NormalizedZoomWebChatMessage[] {
  const normalizedBotName = compactText(botName);
  const messages: NormalizedZoomWebChatMessage[] = [];
  let previousSender = "";
  const occurrences = new Map<string, number>();

  for (const record of records) {
    const headerSource = compactText(
      record.headerText || record.text || record.ariaLabel,
    );
    const parsedHeader = parseHeader(headerSource);
    let senderName =
      compactText(record.senderText).replace(/^from:?\s+/i, "") ||
      parsedHeader?.senderName ||
      previousSender;
    if (/^(?:you|me)$/i.test(senderName) && normalizedBotName) {
      senderName = normalizedBotName;
    }
    let receiverName =
      compactText(record.receiverText).replace(/^to:?\s+/i, "") ||
      parsedHeader?.receiverName ||
      "Everyone";
    const header = parsedHeader?.header ?? "";
    let message = compactText(record.messageText);

    if (!message) {
      message = stripHeaderFromMessage(
        compactText(record.text || record.ariaLabel),
        header,
      );
    }

    if (!senderName || !message || senderName === message) {
      continue;
    }

    previousSender = senderName;
    const privacyText = compactText(
      `${record.receiverText ?? ""} ${record.headerText ?? ""} ${record.text ?? ""} ${record.ariaLabel ?? ""}`,
    );
    const privateToBot = Boolean(
      record.directMessage ||
        /\b(?:direct message|privately|private message)\b/i.test(privacyText) ||
        /\bto\s+(?:you|me)\b/i.test(privacyText) ||
        (normalizedBotName &&
          new RegExp(`\\bto\\s+${escapeRegExp(normalizedBotName)}\\b`, "i").test(
            privacyText,
          )) ||
        (normalizedBotName &&
          compactText(receiverName).toLowerCase() ===
            normalizedBotName.toLowerCase()),
    );

    if (privateToBot || /^(?:you|me)$/i.test(receiverName)) {
      receiverName = normalizedBotName;
    } else if (/^everyone(?:\s+in\s+meeting)?$/i.test(receiverName)) {
      receiverName = "Everyone";
    }

    const baseKey =
      compactText(record.key) ||
      `${senderName}\u0000${receiverName}\u0000${compactText(record.timeText)}\u0000${message}`;
    const occurrence = (occurrences.get(baseKey) ?? 0) + 1;
    occurrences.set(baseKey, occurrence);

    messages.push({
      key: `${baseKey}\u0000${occurrence}`,
      senderName,
      receiverName,
      message,
      privateToBot,
      timeText: compactText(record.timeText),
      occurrence,
      messageId: compactText(record.messageId) || compactText(record.key) || undefined,
      messageIdAttribute: record.messageIdAttribute,
      raw: record,
    });
  }

  return messages;
}

export function zoomWebParticipantId(name: string): number {
  const normalized = compactText(name).toLowerCase();
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 1) || 1;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ZoomWebBot {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private frame: Frame | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private monitorRunning = false;
  private state: ZoomWebBotState = "idle";
  private chatPanelReady = false;
  private chatBaselineReady = false;
  private joinedCandidateSince: number | null = null;
  private chatDomRecordCount = 0;
  private normalizedChatMessageCount = 0;
  private lastChatPollAt: string | null = null;
  private lastChatDiagnosticsAt = 0;
  private chatDomDiagnostics: ZoomWebChatDomDiagnostics | null = null;
  private chatAutoScrollEnabled = true;
  /**
   * Set while our own nested-reply composer is being driven, so a concurrent
   * poll does not scroll the thread target out from under it. Expires on its
   * own: a stuck guard would silently disable scroll recovery for the rest of
   * the meeting, which is the failure this guard used to cause.
   */
  private nestedReplyBusyUntil = 0;
  private seenMessages = new Set<string>();
  private participantNames = new Map<number, string>();
  private joinInFlight: Promise<ZoomWebBotHealth> | null = null;

  constructor(
    private readonly config: ZoomWebBotConfig,
    private readonly emit: ZoomWebBotEventEmitter,
    private readonly setExternalState: ZoomWebBotStateSetter,
  ) {}

  health(): ZoomWebBotHealth {
    return {
      transport: "zoom-web-app",
      state: this.state,
      browserConnected: this.browser?.isConnected() ?? false,
      pageOpen: Boolean(this.page && !this.page.isClosed()),
      frameReady: Boolean(this.frame && !this.frame.isDetached()),
      chatPanelReady: this.chatPanelReady,
      chatBaselineReady: this.chatBaselineReady,
      chatDomRecordCount: this.chatDomRecordCount,
      normalizedChatMessageCount: this.normalizedChatMessageCount,
      lastChatPollAt: this.lastChatPollAt,
      chatDomDiagnostics: this.chatDomDiagnostics,
      knownParticipants: Array.from(this.participantNames, ([userId, name]) => ({
        userId,
        name,
      })),
    };
  }

  async dumpChatState(replyTarget?: ZoomWebChatReplyTarget): Promise<unknown> {
    if (!this.frame || this.frame.isDetached()) {
      return { error: "frame-not-ready" };
    }
    return this.frame.evaluate((target: ZoomWebChatReplyTarget | null) => {
      const visible = (element: Element): boolean => {
        const html = element as HTMLElement;
        const style = getComputedStyle(html);
        const bounds = html.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          bounds.width > 0 &&
          bounds.height > 0
        );
      };
      const classPath = (element: Element): string[] => {
        const parts: string[] = [];
        let node: Element | null = element;
        for (let index = 0; index < 10 && node; index += 1) {
          const className =
            typeof (node as HTMLElement).className === "string"
              ? String((node as HTMLElement).className).slice(0, 90)
              : "";
          parts.push(`${node.tagName.toLowerCase()}.${className}`);
          node = node.parentElement;
        }
        return parts;
      };
      const editors = Array.from(
        document.querySelectorAll(
          '[contenteditable="true"], textarea.chat-box__chat-textarea, textarea',
        ),
      )
        .filter(visible)
        .map((element) => {
          const html = element as HTMLElement;
          const bounds = html.getBoundingClientRect();
          return {
            placeholder:
              html.getAttribute("data-placeholder") ||
              html.getAttribute("aria-placeholder") ||
              html.getAttribute("aria-label") ||
              "",
            className: String(html.className || "").slice(0, 80),
            inFooter: Boolean(
              html.closest(
                ".chat-container__chat-footer, .chat-box, .chat-rtf-box, .new-chat-editor",
              ),
            ),
            rect: {
              x: Math.round(bounds.x),
              y: Math.round(bounds.y),
              w: Math.round(bounds.width),
              h: Math.round(bounds.height),
            },
            path: classPath(html),
          };
        });
      const replyButtons = Array.from(
        document.querySelectorAll(
          'button[aria-label="Reply"], button[aria-label*="Reply" i]',
        ),
      )
        .filter(visible)
        .map((element) => {
          const html = element as HTMLElement;
          const bounds = html.getBoundingClientRect();
          return {
            aria: html.getAttribute("aria-label") || "",
            className: String(html.className || "").slice(0, 80),
            rect: {
              x: Math.round(bounds.x),
              y: Math.round(bounds.y),
              w: Math.round(bounds.width),
              h: Math.round(bounds.height),
            },
          };
        });
      const threadish = Array.from(
        document.querySelectorAll(
          '[class*="thread" i], [class*="indent" i], [class*="nested" i], [class*="quoted" i], [class*="reply-wrap" i], [class*="reply-context" i]',
        ),
      )
        .slice(0, 25)
        .map((element) => ({
          className: String((element as HTMLElement).className || "").slice(0, 100),
          text: ((element as HTMLElement).innerText || "").slice(0, 80),
        }));
      const footer = document.querySelector(
        ".chat-container__chat-footer, .chat-box, .chat-rtf-box",
      ) as HTMLElement | null;
      const messageId = (target?.messageId ?? "").trim();
      const escape = (value: string) =>
        typeof CSS !== "undefined" && CSS.escape
          ? CSS.escape(value)
          : value.replace(/"/g, '\\"');
      let parent: Element | null = null;
      if (messageId && target?.messageIdAttribute === "id") {
        parent = document.getElementById(messageId);
      } else if (messageId && target?.messageIdAttribute) {
        parent = document.querySelector(
          `[${target.messageIdAttribute}="${escape(messageId)}"]`,
        );
      } else if (messageId) {
        parent = document.querySelector(
          `[data-id="${escape(messageId)}"], [data-message-id="${escape(messageId)}"]`,
        );
      }
      const group =
        parent?.closest(
          ".chat-item-container, .chat-item-position, .new-chat-item__chat-msg-wrap, .new-chat-item, [role='row']",
        ) || parent;
      return {
        editorCount: editors.length,
        editors,
        replyButtons,
        threadish,
        footerText: (footer?.innerText || "").slice(0, 240),
        parentText: ((group as HTMLElement | null)?.innerText || "").slice(0, 400),
        parentClass:
          group instanceof HTMLElement
            ? String(group.className || "").slice(0, 120)
            : "",
      };
    }, (replyTarget ?? null) as ZoomWebChatReplyTarget | null);
  }

  async nestedSelfTest(): Promise<unknown> {
    const stamp = Date.now();
    const parentText = `ECHO nested parent ${stamp}`;
    const childText = `ECHO nested child ${stamp}`;
    await this.sendChat(parentText);
    await this.page?.waitForTimeout(1_800).catch(() => undefined);
    const records = await this.readChatDomRecords();
    const messages = normalizeZoomWebChatRecords(records, this.config.botName);
    const parent = [...messages]
      .reverse()
      .find((message) => message.message.includes(String(stamp)));
    if (!parent) {
      throw new Error("Self-test parent chat message did not appear in Zoom DOM");
    }
    const replyTarget: ZoomWebChatReplyTarget = {
      messageId: parent.messageId,
      messageIdAttribute: parent.messageIdAttribute,
      senderName: parent.senderName,
      receiverName: parent.receiverName,
      privateToBot: parent.privateToBot,
      message: parent.message,
      timeText: parent.timeText,
      occurrence: parent.occurrence,
    };
    const beforeReply = await this.dumpChatState(replyTarget);
    await this.sendChat(childText, undefined, replyTarget);
    await this.page?.waitForTimeout(1_800).catch(() => undefined);
    const afterReply = await this.dumpChatState(replyTarget);
    const afterRecords = await this.readChatDomRecords();
    const afterMessages = normalizeZoomWebChatRecords(
      afterRecords,
      this.config.botName,
    );
    const parentAfter = afterMessages.find(
      (message) => message.messageId === parent.messageId,
    );
    const childTopLevel = afterMessages.filter(
      (message) =>
        message.message.includes(childText) &&
        message.messageId !== parent.messageId,
    );
    const parentGroupHasChild = String(
      (afterReply as { parentText?: string } | null)?.parentText || "",
    ).includes(childText);
    const screenshotPath = `/tmp/echo-nested-self-test-${stamp}.png`;
    await this.page
      ?.screenshot({ path: screenshotPath, fullPage: false })
      .catch(() => undefined);
    const result = {
      parentText,
      childText,
      parentMessageId: parent.messageId,
      beforeReply,
      afterReply,
      parentGroupHasChild,
      childTopLevelCount: childTopLevel.length,
      nestedLikely: parentGroupHasChild && childTopLevel.length === 0,
      screenshotPath,
      parentAfterText: parentAfter?.message,
    };
    this.emit("nested-self-test", result);
    return result;
  }

  async join(force = false): Promise<ZoomWebBotHealth> {
    if (this.joinInFlight) {
      return this.joinInFlight;
    }

    this.joinInFlight = this.performJoin(force).finally(() => {
      this.joinInFlight = null;
    });
    return this.joinInFlight;
  }

  async leave(): Promise<unknown> {
    this.stopMonitor();
    let result: unknown = { skipped: true, reason: "Zoom Web App page is not open" };

    if (this.frame && !this.frame.isDetached()) {
      const leaveButton = this.frame.getByRole("button", { name: /^Leave$/i }).first();
      if (await leaveButton.isVisible().catch(() => false)) {
        this.emit("leave-requested", { transport: "zoom-web-app" });
        await leaveButton.click().catch(() => undefined);
        await sleep(300);
        const confirmButton = this.frame
          .getByRole("button", { name: /^(?:Leave Meeting|Leave)$/i })
          .last();
        if (await confirmButton.isVisible().catch(() => false)) {
          await confirmButton.click().catch(() => undefined);
        }
        result = { left: true, transport: "zoom-web-app" };
      }
    }

    await this.closeResources();
    this.updateState("closed");
    this.emit("leave-result", result);
    return result;
  }

  async shutdown(): Promise<void> {
    await this.leave().catch(() => undefined);
  }

  async sendChat(
    message: string,
    userId?: number,
    replyTarget?: ZoomWebChatReplyTarget,
  ): Promise<unknown> {
    const text = message.trim();
    if (!text) {
      throw new Error("chat message must not be empty");
    }
    if (this.state !== "joined" || !this.frame || this.frame.isDetached()) {
      throw new Error("Zoom Web App bot is not joined; call POST /join first");
    }

    await this.ensureChatPanelOpen();

    const nested = Boolean(replyTarget && !replyTarget.privateToBot);
    if (replyTarget?.privateToBot && typeof userId !== "number") {
      throw new Error("Private nested reply requires sender userId");
    }

    if (nested && replyTarget) {
      await this.beginNestedReply(replyTarget);
    }

    const input = await this.findChatInput(
      nested && replyTarget ? { nested: true, replyTarget } : undefined,
    );
    if (!input) {
      throw new Error("Zoom Web App chat input is not available");
    }
    if (nested && replyTarget) {
      const nestedReady = await this.nestedComposerOpen(replyTarget);
      if (!nestedReady) {
        throw new Error(
          "Zoom nested reply composer is not active; refusing to post to Everyone",
        );
      }
    }

    let receiverName = "Everyone";
    if (typeof userId === "number") {
      const mappedName = this.participantNames.get(userId);
      if (!mappedName) {
        throw new Error(`Unknown Zoom Web App participant userId ${userId}`);
      }
      receiverName = mappedName;
    }

    const parts = splitChatMessage(text, this.config.chatMaxChars ?? 900);
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] ?? "";
      if (!nested) {
        await this.selectRecipient(receiverName, typeof userId === "number");
      } else if (index > 0) {
        // Keep typing inside the open nested-reply composer for multi-part answers.
        await this.beginNestedReply(replyTarget!);
      }
      const activeInput =
        nested && replyTarget
          ? (await this.findChatInput({ nested: true, replyTarget })) ?? input
          : input;
      await activeInput.click({ force: true, timeout: 2_000 }).catch(() => undefined);
      await activeInput.fill(part);
      if (nested) {
        await activeInput.press("Enter");
      } else {
        const sendButton = this.frame
          .locator(
            '.chat-box__send-btn, .chat-rtf-box__send, button[aria-label^="Send" i], button[title^="Send" i]',
          )
          .filter({ visible: true })
          .last();
        if (await sendButton.isVisible().catch(() => false)) {
          await sendButton.click({ force: true, timeout: 2_000 });
        } else {
          await activeInput.press("Enter");
        }
      }
      if (index + 1 < parts.length) {
        await this.page?.waitForTimeout(600).catch(() => undefined);
      }
    }

    const result = {
      sent: true,
      transport: "zoom-web-app" as const,
      receiver: nested ? `thread:${replyTarget?.messageId ?? replyTarget?.message ?? "unknown"}` : receiverName,
      parts: parts.length,
      nestedReply: nested,
      replyToMessageId: replyTarget?.messageId,
    };
    this.emit("chat-sent", { message: text, userId, replyTarget, ...result });
    // Nested replies scroll the target mid-list, and Zoom's chat list does not
    // follow inbound messages on its own, so pin back to latest or the newest
    // rows never mount for pollChatMessages to read.
    this.nestedReplyBusyUntil = 0;
    await this.ensureChatListShowsLatest().catch(() => undefined);
    return result;
  }

  private async performJoin(force: boolean): Promise<ZoomWebBotHealth> {
    if (this.page && !this.page.isClosed() && !force) {
      return this.health();
    }

    if (force || this.page || this.browser) {
      await this.closeResources();
    }

    this.resetChatState();
    this.updateState("launching");
    this.emit("browser-launching", {
      headless: this.config.browserHeadless,
      transport: "zoom-web-app",
    });

    try {
      const fakeVideoPath =
        this.config.showLogoVideo !== false &&
        this.config.fakeVideoPath &&
        fs.existsSync(this.config.fakeVideoPath)
          ? this.config.fakeVideoPath
          : undefined;
      if (fakeVideoPath) {
        this.emit("logo-video-ready", {
          path: fakeVideoPath,
          transport: "zoom-web-app",
        });
      }
      this.browser = await chromium.launch({
        channel: this.config.browserChannel,
        headless: this.config.browserHeadless,
        // Reduce Zoom's "Automated bots aren't allowed" guest-join wall.
        ignoreDefaultArgs: ["--enable-automation"],
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--autoplay-policy=no-user-gesture-required",
          "--use-fake-ui-for-media-stream",
          "--use-fake-device-for-media-stream",
          ...(fakeVideoPath
            ? [`--use-file-for-fake-video-capture=${fakeVideoPath}`]
            : []),
          "--disable-background-timer-throttling",
          "--disable-renderer-backgrounding",
          "--disable-blink-features=AutomationControlled",
          "--window-size=1280,900",
        ],
      });

      this.browser.on("disconnected", () => {
        this.stopMonitor();
        this.browser = null;
        this.context = null;
        this.page = null;
        this.frame = null;
        if (this.state !== "error") {
          this.updateState("closed");
        }
        this.emit("browser-disconnected", { transport: "zoom-web-app" });
      });

      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 900 },
        permissions: ["camera", "microphone"],
        locale: "en-US",
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      });
      this.page = await this.context.newPage();
      await this.page.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", {
          get: () => undefined,
        });
      });
      this.registerPageEvents(this.page);

      this.updateState("loading");
      const { url: entryUrl, direct } = this.buildJoinEntryUrl();
      this.emit("browser-loading", {
        url: entryUrl,
        transport: "zoom-web-app",
      });
      await this.page.goto(entryUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      if (!direct) {
        // Zoom Workplace UI sometimes labels the field without a matching placeholder.
        const meetingInput = this.page
          .getByPlaceholder("Meeting ID or Personal Link Name")
          .or(this.page.getByLabel("Meeting ID or Personal Link Name"))
          .or(
            this.page.getByRole("textbox", {
              name: /Meeting ID or Personal Link Name/i,
            }),
          )
          .or(this.page.locator('input[type="text"]').first());
        await meetingInput.first().waitFor({ state: "visible", timeout: 30_000 });
        await meetingInput.first().fill(this.config.meetingNumber);
        await this.page.getByRole("button", { name: "Join", exact: true }).click();
      }

      await this.clickJoinInBrowserIfPrompted();

      this.frame = await this.waitForWebClientFrame(60_000);
      await this.prepareAndSubmitPrejoin(this.frame);
      this.updateState("joining");
      this.startMonitor();

      const deadline = Date.now() + this.config.joinTimeoutMs;
      while (
        Date.now() < deadline &&
        this.state !== "joined" &&
        this.state !== "waiting-room" &&
        this.state !== "error"
      ) {
        await this.monitorOnce();
        await sleep(250);
      }

      if (this.state === "joining") {
        this.emit("join-pending", {
          message: "Zoom Web App is still joining or waiting for host action.",
          transport: "zoom-web-app",
        });
      }
      return this.health();
    } catch (error) {
      await this.captureJoinDebug(error);
      this.updateState("error", error);
      this.emit("error", {
        message: errorMessage(error),
        transport: "zoom-web-app",
      });
      throw error;
    }
  }

  private async captureJoinDebug(error: unknown): Promise<void> {
    try {
      const dir = path.join(process.cwd(), "data", "debug");
      fs.mkdirSync(dir, { recursive: true });
      const stamp = Date.now();
      const lines = [`error: ${errorMessage(error)}`, ""];
      if (this.page && !this.page.isClosed()) {
        await this.page.screenshot({
          path: path.join(dir, `join-${stamp}.png`),
          fullPage: true,
        });
        lines.push(`page: ${this.page.url()}`);
      }
      for (const frame of this.page?.frames() ?? []) {
        const text = compactText(
          await frame.locator("body").innerText().catch(() => ""),
        );
        lines.push(`frame: ${frame.url()}`);
        lines.push(text.slice(0, 500));
        lines.push("");
      }
      fs.writeFileSync(path.join(dir, `join-${stamp}.txt`), `${lines.join("\n")}\n`, "utf8");
      this.emit("join-debug", { stamp, dir });
    } catch {
      // best-effort debug capture
    }
  }

  private registerPageEvents(page: Page): void {
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        this.emit("browser-console", {
          type: message.type(),
          text: message.text(),
          transport: "zoom-web-app",
        });
      }
    });
    page.on("pageerror", (error) => {
      this.emit("browser-page-error", {
        message: error.message,
        stack: error.stack,
        transport: "zoom-web-app",
      });
    });
    page.on("close", () => {
      this.stopMonitor();
      this.page = null;
      this.frame = null;
      if (this.state !== "error") {
        this.updateState("closed");
      }
      this.emit("browser-page-closed", { transport: "zoom-web-app" });
    });
  }

  private async waitForWebClientFrame(timeoutMs: number): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const frame = this.page?.frames().find((candidate) => candidate.name() === "webclient");
      if (frame) {
        return frame;
      }
      await sleep(250);
    }
    throw new Error("Zoom Web App webclient frame did not load");
  }

  private buildJoinEntryUrl(): { url: string; direct: boolean } {
    const useDirect = process.env.ZOOM_WEB_DIRECT_JOIN?.trim().toLowerCase() === "true";
    if (!useDirect || !this.config.meetingNumber) {
      return { url: this.config.webAppUrl, direct: false };
    }
    const domain = (this.config.webDomain ?? "app.zoom.us")
      .replace(/^https?:\/\//u, "")
      .replace(/\/$/u, "");
    const passwordQuery = this.config.meetingPassword
      ? `?pwd=${encodeURIComponent(this.config.meetingPassword)}`
      : "";
    // Prefer /wc/join/<id> — /wc/<id>/join currently returns invalid (3,001) for some IDs.
    return {
      url: `https://${domain}/wc/join/${this.config.meetingNumber}${passwordQuery}`,
      direct: true,
    };
  }

  /** Dismiss Zoom Workplace "Join in app?" interstitial so the web client can load. */
  private async clickJoinInBrowserIfPrompted(): Promise<void> {
    if (!this.page || this.page.isClosed()) {
      return;
    }
    const browserJoin = this.page.getByRole("button", {
      name: /Join in browser/i,
    });
    try {
      await browserJoin.waitFor({ state: "visible", timeout: 8_000 });
      await browserJoin.click({ timeout: 5_000 });
      this.emit("join-in-browser-clicked", { transport: "zoom-web-app" });
    } catch {
      // Prompt not shown — continue.
    }
  }

  private async resolvePrejoinContext(): Promise<Frame | Page> {
    if (this.page && !this.page.isClosed()) {
      const onPage = await this.page
        .locator('#input-for-name, #inputname, input[aria-label*="name" i]')
        .first()
        .isVisible()
        .catch(() => false);
      if (onPage) {
        return this.page;
      }
    }
    return this.findPrejoinFrame();
  }

  private async findPrejoinFrame(): Promise<Frame> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const frames = this.page?.frames() ?? [];
      for (const candidate of frames) {
        const hasName = await candidate
          .locator('#input-for-name, #inputname, input[aria-label*="name" i]')
          .first()
          .isVisible()
          .catch(() => false);
        if (hasName) {
          return candidate;
        }
      }
      await sleep(250);
    }
    const snippets = (this.page?.frames() ?? []).map((frame) => frame.url()).join(" | ");
    throw new Error(`Zoom prejoin name field did not appear (frames: ${snippets || "none"})`);
  }

  private async prepareAndSubmitPrejoin(frame: Frame): Promise<void> {
    const activeContext = (await frame
      .locator('#input-for-name, #inputname, input[aria-label*="name" i]')
      .first()
      .isVisible()
      .catch(() => false))
      ? frame
      : await this.resolvePrejoinContext();

    const passwordInput = activeContext
      .locator('#input-for-pwd, input[type="password"]')
      .filter({ visible: true })
      .first();
    if (await passwordInput.isVisible().catch(() => false)) {
      if (!this.config.meetingPassword) {
        throw new Error("Zoom meeting requires a passcode, but ZOOM_MEETING_PASSWORD is empty");
      }
      await passwordInput.fill(this.config.meetingPassword);
    }

    const nameInput = activeContext
      .locator('#input-for-name, #inputname, input[aria-label*="name" i]')
      .first();
    await nameInput.waitFor({ state: "visible", timeout: 60_000 });
    await nameInput.fill(this.config.botName);
    const muteButton = activeContext.getByRole("button", { name: "Mute", exact: true });
    if (await muteButton.isVisible().catch(() => false)) {
      await muteButton.click();
    }
    // Keep camera on so the ECHO logo fake-video feed is visible in Zoom.
    if (this.config.showLogoVideo !== false && this.config.fakeVideoPath) {
      const startVideo = activeContext.getByRole("button", {
        name: /start video/i,
      });
      if (await startVideo.isVisible().catch(() => false)) {
        await startVideo.click().catch(() => undefined);
      }
    } else {
      const stopVideoButton = activeContext.getByRole("button", {
        name: "Stop Video",
        exact: true,
      });
      if (await stopVideoButton.isVisible().catch(() => false)) {
        await stopVideoButton.click();
      }
    }

    await activeContext.getByRole("button", { name: "Join", exact: true }).last().click();
  }

  private startMonitor(): void {
    this.stopMonitor();
    const schedule = (): void => {
      this.monitorTimer = setTimeout(async () => {
        try {
          await this.monitorOnce();
        } finally {
          if (this.page && !this.page.isClosed()) {
            schedule();
          }
        }
      }, this.config.pollIntervalMs);
    };
    schedule();
  }

  private stopMonitor(): void {
    if (this.monitorTimer) {
      clearTimeout(this.monitorTimer);
      this.monitorTimer = null;
    }
  }

  private async monitorOnce(): Promise<void> {
    if (this.monitorRunning || !this.frame || this.frame.isDetached()) {
      return;
    }
    this.monitorRunning = true;
    try {
      const bodyText = compactText(
        await this.frame.locator("body").innerText().catch(() => ""),
      );
      if (!bodyText) {
        return;
      }

      if (
        /(?:host has joined|we(?:'|’)ve let them know you(?:'|’)re here|waiting room|please wait.*host)/i.test(
          bodyText,
        )
      ) {
        this.joinedCandidateSince = null;
        if (this.state !== "waiting-room") {
          this.updateState("waiting-room");
          this.emit("waiting-room", {
            meetingNumber: this.config.meetingNumber,
            botName: this.config.botName,
            transport: "zoom-web-app",
          });
        }
        return;
      }

      const joined = await this.frame
        .locator(
          'button[aria-label*="chat panel" i], button[aria-label*="leave" i], #chat',
        )
        .first()
        .isVisible()
        .catch(() => false);

      if (joined) {
        if (this.state !== "joined") {
          if (this.joinedCandidateSince === null) {
            this.joinedCandidateSince = Date.now();
            return;
          }
          if (Date.now() - this.joinedCandidateSince < 4_000) {
            return;
          }
          this.updateState("joined");
          const botUser = {
            name: this.config.botName,
            userId: zoomWebParticipantId(this.config.botName),
          };
          this.participantNames.set(botUser.userId, this.config.botName);
          this.emit("bot-user", botUser);
          this.emit("joined", {
            meetingNumber: this.config.meetingNumber,
            botName: this.config.botName,
            transport: "zoom-web-app",
          });
        }
        try {
          await this.ensureChatPanelOpen();
          await this.pollChatMessages();
        } catch (error) {
          this.chatPanelReady = false;
          this.emit("chat-bridge-error", {
            message: errorMessage(error),
            transport: "zoom-web-app",
          });
        }
        return;
      }

      this.joinedCandidateSince = null;

      if (/(?:meeting has ended|removed from the meeting|unable to join|sign in to join)/i.test(bodyText)) {
        throw new Error(bodyText.slice(0, 500));
      }
    } catch (error) {
      this.updateState("error", error);
      this.emit("error", {
        message: errorMessage(error),
        transport: "zoom-web-app",
      });
    } finally {
      this.monitorRunning = false;
    }
  }

  private async ensureChatPanelOpen(): Promise<void> {
    if (!this.frame || this.frame.isDetached()) {
      throw new Error("Zoom Web App frame is not ready");
    }

    const existingInput = await this.findChatInput();
    if (existingInput) {
      this.chatPanelReady = true;
      return;
    }

    const openButton = this.frame
      .locator('button[aria-label*="open the chat panel" i]')
      .first();
    if ((await openButton.count()) > 0) {
      // Zoom can lay this button out just beyond Chromium's visual viewport.
      // A DOM click still follows the same React handler without Playwright's
      // viewport/actionability check timing out for 30 seconds.
      await openButton
        .evaluate((button) => (button as HTMLButtonElement).click())
        .catch(() => undefined);
    }

    let deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      if (await this.findChatInput()) {
        this.chatPanelReady = true;
        return;
      }
      await sleep(100);
    }

    const chatToolbarItem = this.frame.locator("#chat").first();
    if ((await chatToolbarItem.count()) > 0) {
      await chatToolbarItem
        .evaluate((item) => (item as HTMLElement).click())
        .catch(() => undefined);
    }
    deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      if (await this.findChatInput()) {
        this.chatPanelReady = true;
        return;
      }
      await sleep(100);
    }

    if ((await openButton.count()) > 0) {
      await openButton.dispatchEvent("click").catch(() => undefined);
    }
    deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      if (await this.findChatInput()) {
        this.chatPanelReady = true;
        return;
      }
      await sleep(100);
    }

    // Zoom also exposes Alt+H as the in-meeting chat toggle. It is a useful
    // fallback when a transient overlay swallows the toolbar click.
    await this.frame.locator("body").click({ position: { x: 20, y: 20 } }).catch(() => undefined);
    await this.page?.keyboard.press("Alt+H").catch(() => undefined);
    deadline = Date.now() + 3_500;
    while (Date.now() < deadline) {
      if (await this.findChatInput()) {
        this.chatPanelReady = true;
        return;
      }
      await sleep(100);
    }

    this.chatPanelReady = false;
    throw new Error("Zoom Web App chat panel did not expose a message input");
  }

  private async findChatInput(options?: { nested?: boolean; replyTarget?: ZoomWebChatReplyTarget }): Promise<Locator | null> {
    if (!this.frame || this.frame.isDetached()) {
      return null;
    }
    if (options?.nested && options.replyTarget) {
      const nested = await this.findNestedReplyInput(options.replyTarget);
      if (nested) {
        return nested;
      }
    }
    const selectors = [
      "textarea.chat-box__chat-textarea",
      '.chat-rtf-box__edit[contenteditable="true"]',
      '.chat-rtf-box__editor-wrapper [contenteditable="true"]',
      'textarea[placeholder*="message" i]',
      'textarea[aria-label*="chat" i]',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"][aria-label*="message" i]',
      'input[placeholder*="message" i]',
      '[contenteditable="true"]',
      "textarea",
    ];
    for (const selector of selectors) {
      const locator = this.frame.locator(selector).filter({ visible: true }).last();
      if (await locator.isVisible().catch(() => false)) {
        return locator;
      }
    }
    return null;
  }

  private async findNestedReplyInput(replyTarget: ZoomWebChatReplyTarget): Promise<Locator | null> {
    if (!this.frame || this.frame.isDetached()) {
      return null;
    }
    const marked = await this.frame.evaluate((target) => {
      document
        .querySelectorAll("[data-echo-nested-input]")
        .forEach((node) => node.removeAttribute("data-echo-nested-input"));

      const visible = (element: Element): boolean => {
        const htmlElement = element as HTMLElement;
        const style = getComputedStyle(htmlElement);
        const bounds = htmlElement.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          bounds.width > 0 &&
          bounds.height > 0
        );
      };
      const editors = () =>
        Array.from(
          document.querySelectorAll(
            'textarea.chat-box__chat-textarea, .chat-rtf-box__edit[contenteditable="true"], .chat-rtf-box__editor-wrapper [contenteditable="true"], [contenteditable="true"][role="textbox"], [contenteditable="true"], textarea',
          ),
        ).filter(visible) as HTMLElement[];

      const escape = (value: string) =>
        typeof CSS !== "undefined" && CSS.escape
          ? CSS.escape(value)
          : value.replace(/"/g, '\\"');
      const messageId = (target.messageId ?? "").trim();
      let messageNode: Element | null = null;
      if (messageId && target.messageIdAttribute) {
        messageNode =
          target.messageIdAttribute === "id"
            ? document.getElementById(messageId)
            : document.querySelector(
                `[${target.messageIdAttribute}="${escape(messageId)}"]`,
              );
      }
      if (!messageNode && messageId) {
        messageNode = document.querySelector(
          `[data-id="${escape(messageId)}"], [data-message-id="${escape(messageId)}"]`,
        );
      }

      const mark = (editor: HTMLElement, reason: string): string => {
        editor.setAttribute("data-echo-nested-input", reason);
        return reason;
      };

      const row =
        messageNode?.closest(
          ".chat-item-container, .chat-item-position, .new-chat-item__chat-msg-wrap, .new-chat-item, [role='row']",
        ) || messageNode;

      if (row) {
        for (const editor of editors()) {
          if (row.contains(editor)) {
            return mark(editor, "inline-row");
          }
        }
        let sibling: Element | null = row.nextElementSibling;
        for (let depth = 0; depth < 4 && sibling; depth += 1) {
          const isThreadSibling = sibling.matches(
            ".chat-item-container--reply, .chat-item-position__thread, [class*='container--reply']",
          );
          if (isThreadSibling) {
            for (const editor of editors()) {
              if (sibling.contains(editor)) {
                return mark(editor, "inline-follow-thread");
              }
            }
          }
          if (
            !isThreadSibling &&
            sibling.matches(
              ".chat-item-container, .chat-item-position, .new-chat-item, .new-chat-message__container",
            )
          ) {
            break;
          }
          for (const editor of editors()) {
            if (sibling.contains(editor)) {
              return mark(editor, "inline-follow");
            }
          }
          sibling = sibling.nextElementSibling;
        }
      }

      const footer = document.querySelector(
        ".chat-container__chat-footer, .chat-box, .chat-rtf-box, .new-chat-editor",
      );
      if (footer) {
        const replyBanner = footer.querySelector(
          ".chat-rtf-box__reply, .chat-rtf-box__reply-wrap, .new-chat-reply-context, [class*='reply-context'], [class*='quoted-message']",
        );
        if (replyBanner && visible(replyBanner)) {
          for (const editor of editors()) {
            if (footer.contains(editor)) {
              return mark(editor, "footer-reply-banner");
            }
          }
        }
        const footerText = (footer as HTMLElement).innerText || "";
        const snippet = (target.message ?? "").slice(0, 24);
        if (
          /replying to/i.test(footerText) ||
          (snippet && footerText.includes(snippet))
        ) {
          for (const editor of editors()) {
            if (footer.contains(editor)) {
              return mark(editor, "footer-replying-to");
            }
          }
        }
      }

      for (const editor of editors()) {
        if (
          editor.closest(
            ".chat-container__chat-footer, .chat-box, .chat-rtf-box, .new-chat-editor",
          )
        ) {
          continue;
        }
        const placeholder =
          editor.getAttribute("data-placeholder") ||
          editor.getAttribute("aria-placeholder") ||
          editor.getAttribute("aria-label") ||
          "";
        if (/replying to|reply in thread|add a reply|reply to this message/i.test(placeholder)) {
          return mark(editor, "inline-placeholder-replying");
        }
        const bounds = editor.getBoundingClientRect();
        const parentBounds = (row as HTMLElement | null)?.getBoundingClientRect();
        if (
          parentBounds &&
          bounds.y >= parentBounds.y - 4 &&
          bounds.x >= parentBounds.x + 12
        ) {
          return mark(editor, "inline-indented");
        }
      }

      return "";
    }, replyTarget);

    if (!marked) {
      return null;
    }
    const locator = this.frame.locator("[data-echo-nested-input]").first();
    if (await locator.isVisible().catch(() => false)) {
      this.emit("nested-reply-input", {
        messageId: replyTarget.messageId,
        via: marked,
      });
      return locator;
    }
    return null;
  }

  /**
   * Zoom's in-meeting chat uses a virtualized list. Nested-reply
   * scrollIntoView can leave the window pinned mid-history so brand-new
   * @mentions never mount in the DOM and pollChatMessages misses them for
   * minutes. Pin the list to the latest rows before each read (unless a
   * nested-reply composer is open).
   */
  private async ensureChatListShowsLatest(): Promise<void> {
    if (!this.chatAutoScrollEnabled) {
      return;
    }
    if (Date.now() < this.nestedReplyBusyUntil) {
      return;
    }
    if (!this.frame || this.frame.isDetached()) {
      return;
    }

    const result = await this.frame
      .evaluate(() => {
        const isVisible = (element: Element): boolean => {
          const html = element as HTMLElement;
          const style = getComputedStyle(html);
          const bounds = html.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            bounds.width > 0 &&
            bounds.height > 0
          );
        };

        const input = Array.from(
          document.querySelectorAll(
            'textarea.chat-box__chat-textarea, .chat-rtf-box__edit[contenteditable="true"], .chat-rtf-box__editor-wrapper [contenteditable="true"], [contenteditable="true"][role="textbox"], textarea',
          ),
        ).find(isVisible);
        if (!input) {
          return { scrolled: false, reason: "no-input" as const };
        }

        let root: Element =
          input.closest(".chat-container, .chat-container-one-chat") || input;
        if (root === input) {
          for (let index = 0; index < 8 && root.parentElement; index += 1) {
            root = root.parentElement;
            if (
              root.matches('.chat-container, [class*="chat-container" i]') ||
              root.querySelector(".chat-list-content, .chat-virtualized-list")
            ) {
              break;
            }
          }
        }

        const scrollables = new Set<HTMLElement>();
        const pushScrollable = (element: Element | null | undefined) => {
          if (!element || !(element instanceof HTMLElement)) {
            return;
          }
          const style = getComputedStyle(element);
          const overflowY = `${style.overflowY} ${style.overflow}`;
          if (
            element.scrollHeight > element.clientHeight + 4 &&
            /(auto|scroll)/i.test(overflowY)
          ) {
            scrollables.add(element);
          }
        };

        for (const selector of [
          ".chat-virtualized-list",
          ".chat-list-content",
          '[class*="virtualized-list" i]',
          '[class*="chat-list" i]',
          '[class*="message-list" i]',
          '[role="log"]',
        ]) {
          root.querySelectorAll(selector).forEach((node) => pushScrollable(node));
        }

        const messageNodes = root.querySelectorAll(
          ".new-chat-message__container, .chat-message__container, .chat-item-container, [role='row']",
        );
        const lastMessage = messageNodes[messageNodes.length - 1] as
          | HTMLElement
          | undefined;
        if (lastMessage) {
          let node: HTMLElement | null = lastMessage;
          for (let index = 0; index < 10 && node; index += 1) {
            pushScrollable(node);
            node = node.parentElement;
          }
          lastMessage.scrollIntoView({ block: "end", inline: "nearest" });
        }

        let moved = false;
        for (const element of scrollables) {
          const before = element.scrollTop;
          const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
          if (maxTop - before > 2) {
            element.scrollTop = element.scrollHeight;
            moved = moved || Math.abs(element.scrollTop - before) > 1;
          }
        }

        return {
          scrolled: moved || Boolean(lastMessage && scrollables.size > 0),
          reason: "ok" as const,
          scrollableCount: scrollables.size,
          messageCount: messageNodes.length,
        };
      })
      .catch(() => null);

    if (result?.reason === "ok" && result.scrolled) {
      // Virtualized rows mount after scroll settles.
      await sleep(150);
    }
  }

  setChatAutoScroll(enabled: boolean): boolean {
    this.chatAutoScrollEnabled = enabled;
    return this.chatAutoScrollEnabled;
  }

  /**
   * Diagnostic-only. Reports how the Zoom chat list is currently mounted and
   * scrolled so the virtualization/auto-follow behaviour can be measured
   * instead of inferred. `scrollTo` moves the detected scroller to stage a
   * "stranded view" without going through ensureChatListShowsLatest.
   */
  async debugChatProbe(
    scrollTo?: "top" | "bottom",
  ): Promise<Record<string, unknown> | null> {
    if (!this.frame || this.frame.isDetached()) {
      return null;
    }
    return this.frame
      .evaluate((moveTo) => {
        const isVisible = (element: Element): boolean => {
          const html = element as HTMLElement;
          const style = getComputedStyle(html);
          const bounds = html.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            bounds.width > 0 &&
            bounds.height > 0
          );
        };
        const describe = (element: Element | null | undefined) => {
          if (!element) {
            return null;
          }
          const html = element as HTMLElement;
          return {
            tag: html.tagName.toLowerCase(),
            class: html.className?.toString().slice(0, 160) ?? "",
            ariaLabel: html.getAttribute("aria-label"),
            placeholder:
              html.getAttribute("data-placeholder") ||
              html.getAttribute("placeholder"),
            scrollTop: Math.round(html.scrollTop),
            scrollHeight: Math.round(html.scrollHeight),
            clientHeight: Math.round(html.clientHeight),
            maxScrollTop: Math.round(
              Math.max(0, html.scrollHeight - html.clientHeight),
            ),
            overflowY: getComputedStyle(html).overflowY,
          };
        };
        const textOf = (element: Element | null | undefined) =>
          ((element as HTMLElement | null)?.innerText || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 90);

        // --- which element does the production code think is the composer? ---
        const input = Array.from(
          document.querySelectorAll(
            'textarea.chat-box__chat-textarea, .chat-rtf-box__edit[contenteditable="true"], .chat-rtf-box__editor-wrapper [contenteditable="true"], [contenteditable="true"][role="textbox"], textarea',
          ),
        ).find(isVisible);
        if (!input) {
          return { error: "no-visible-composer" };
        }

        // --- does the nested-reply early-return currently fire? ---
        const replyBlockers = Array.from(
          document.querySelectorAll(
            '[contenteditable="true"], textarea, [role="textbox"]',
          ),
        )
          .filter((element) => {
            if (!isVisible(element)) {
              return false;
            }
            const html = element as HTMLElement;
            const placeholder = (
              html.getAttribute("data-placeholder") ||
              html.getAttribute("aria-placeholder") ||
              html.getAttribute("placeholder") ||
              html.getAttribute("aria-label") ||
              ""
            ).toLowerCase();
            return (
              placeholder.includes("reply") ||
              Boolean(
                html.closest(
                  ".chat-item-container--reply, [class*='reply-input' i], [class*='nested-reply' i]",
                ),
              )
            );
          })
          .map(describe);

        let root: Element =
          input.closest(".chat-container, .chat-container-one-chat") || input;
        if (root === input) {
          for (let index = 0; index < 8 && root.parentElement; index += 1) {
            root = root.parentElement;
            if (
              root.matches('.chat-container, [class*="chat-container" i]') ||
              root.querySelector(".chat-list-content, .chat-virtualized-list")
            ) {
              break;
            }
          }
        }

        // --- every genuinely scrollable ancestor/descendant in the panel ---
        const scrollers: Element[] = [];
        root.querySelectorAll("*").forEach((node) => {
          const html = node as HTMLElement;
          const style = getComputedStyle(html);
          if (
            html.scrollHeight > html.clientHeight + 4 &&
            /(auto|scroll)/i.test(`${style.overflowY} ${style.overflow}`)
          ) {
            scrollers.push(html);
          }
        });

        const rows = Array.from(
          root.querySelectorAll(
            ".new-chat-message__container, .chat-message__container",
          ),
        );
        const items = Array.from(root.querySelectorAll(".chat-item-container"));

        // --- virtualization tell-tales: empty spacer boxes with real height ---
        const spacers = Array.from(root.querySelectorAll("div"))
          .filter((node) => {
            const html = node as HTMLElement;
            return (
              html.children.length === 0 &&
              !html.innerText?.trim() &&
              html.getBoundingClientRect().height > 20
            );
          })
          .slice(0, 6)
          .map((node) => Math.round((node as HTMLElement).getBoundingClientRect().height));

        // --- unread pill ("N new message(s)") ---
        const pill = Array.from(root.querySelectorAll("button, div, span"))
          .filter((node) => /new message|unread|jump to/i.test(textOf(node)))
          .slice(0, 3)
          .map(textOf);

        if (moveTo) {
          for (const element of scrollers) {
            (element as HTMLElement).scrollTop =
              moveTo === "top" ? 0 : (element as HTMLElement).scrollHeight;
          }
        }

        return {
          movedTo: moveTo ?? null,
          composer: describe(input),
          replyEarlyReturnWouldFire: replyBlockers.length > 0,
          replyBlockers,
          rootClass: (root as HTMLElement).className?.toString().slice(0, 160),
          scrollerCount: scrollers.length,
          scrollers: scrollers.slice(0, 5).map(describe),
          mountedMessageRows: rows.length,
          mountedItemContainers: items.length,
          firstMounted: textOf(rows[0]),
          lastMounted: textOf(rows[rows.length - 1]),
          emptySpacerHeights: spacers,
          unreadPill: pill,
        };
      }, scrollTo)
      .catch((error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
      }));
  }

  private async pollChatMessages(): Promise<void> {
    if (!this.frame || this.frame.isDetached()) {
      return;
    }
    await this.ensureChatListShowsLatest();
    let records = await this.readChatDomRecords();
    // Second pass after the virtualized list has a chance to mount newest rows.
    await this.ensureChatListShowsLatest();
    const again = await this.readChatDomRecords();
    if (again.length >= records.length) {
      records = again;
    }
    const messages = normalizeZoomWebChatRecords(records, this.config.botName);
    this.chatDomRecordCount = records.length;
    this.normalizedChatMessageCount = messages.length;
    this.lastChatPollAt = new Date().toISOString();
    if (Date.now() - this.lastChatDiagnosticsAt >= 5_000) {
      this.chatDomDiagnostics = await this.inspectChatDom();
      this.lastChatDiagnosticsAt = Date.now();
    }

    if (!this.chatBaselineReady) {
      for (const message of messages) {
        this.seenMessages.add(message.key);
      }
      this.chatBaselineReady = true;
      this.emit("chat-baseline-ready", { messages: messages.length });
      return;
    }

    for (const message of messages) {
      if (this.seenMessages.has(message.key)) {
        continue;
      }
      this.seenMessages.add(message.key);
      const senderUserId = zoomWebParticipantId(message.senderName);
      this.participantNames.set(senderUserId, message.senderName);
      const replyTarget: ZoomWebChatReplyTarget = {
        messageId: message.messageId,
        messageIdAttribute: message.messageIdAttribute,
        senderName: message.senderName,
        receiverName: message.receiverName,
        privateToBot: message.privateToBot,
        message: message.message,
        timeText: message.timeText,
        occurrence: message.occurrence,
      };
      const payload: ZoomWebChatPayload = {
        id: message.key,
        message: message.message,
        sender: { name: message.senderName, userId: senderUserId },
        receiver:
          message.privateToBot ||
          compactText(message.receiverName).toLowerCase() ===
            compactText(this.config.botName).toLowerCase()
            ? {
                name: this.config.botName,
                userId: zoomWebParticipantId(this.config.botName),
              }
            : { name: "Everyone", userId: 0 },
        timestamp: Date.now(),
        transport: "zoom-web-app",
        replyTarget,
        raw: message.raw,
      };
      this.emit("chat-on-message", payload);
    }

    if (this.seenMessages.size > 2_000) {
      const newest = Array.from(this.seenMessages).slice(-1_000);
      this.seenMessages = new Set(newest);
    }
  }

  private async readChatDomRecords(): Promise<ZoomWebChatDomRecord[]> {
    if (!this.frame || this.frame.isDetached()) {
      return [];
    }
    return this.frame.evaluate(() => {
      const visible = (element: Element): boolean => {
        const htmlElement = element as HTMLElement;
        const style = getComputedStyle(htmlElement);
        const bounds = htmlElement.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          bounds.width > 0 &&
          bounds.height > 0
        );
      };
      const text = (element: Element | null): string =>
        ((element as HTMLElement | null)?.innerText || element?.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
      const firstText = (root: Element, selectors: string[]): string => {
        for (const selector of selectors) {
          const value = text(root.querySelector(selector));
          if (value) {
            return value;
          }
        }
        return "";
      };

      const input = Array.from(
        document.querySelectorAll(
          'textarea.chat-box__chat-textarea, .chat-rtf-box__edit[contenteditable="true"], .chat-rtf-box__editor-wrapper [contenteditable="true"], textarea[placeholder*="message" i], textarea[aria-label*="chat" i], [contenteditable="true"][role="textbox"], [contenteditable="true"][aria-label*="message" i], input[placeholder*="message" i], [contenteditable="true"], textarea',
        ),
      ).find(visible);
      if (!input) {
        return [];
      }

      let root: Element =
        input.closest(".chat-container, .chat-container-one-chat") || input;
      if (root === input) {
        for (let index = 0; index < 8 && root.parentElement; index += 1) {
          root = root.parentElement;
          if (
            root.matches('.chat-container, [class*="chat-container" i]') ||
            root.querySelector(".chat-list-content, .chat-virtualized-list")
          ) {
            break;
          }
        }
      }

      const selectorCandidates = [
        ".chat-message__container, .new-chat-message__container",
        "[data-message-id]",
        '[data-testid*="chat-message" i]',
        '[class*="chat-message-container" i]',
        '[class*="message-item" i]',
        '[role="listitem"]',
      ];
      let messageNodes: Element[] = [];
      for (const selector of selectorCandidates) {
        const matches = Array.from(root.querySelectorAll(selector)).filter(visible);
        if (matches.length > 0) {
          messageNodes = matches;
          break;
        }
      }

      return messageNodes.map((node) => {
        const group =
          node.closest(".chat-item-container") ||
          node.closest(".chat-item-position") ||
          node.closest(".new-chat-item__chat-msg-wrap") ||
          node;
        const senderText = firstText(group, [
          ".chat-item__sender",
          '[class*="sender" i]',
          '[class*="user-name" i]',
          '[class*="username" i]',
          '[class*="display-name" i]',
          '[data-testid*="sender" i]',
        ]);
        const receiverText = firstText(group, [
          ".chat-item__receiver",
          '[class*="receiver" i]',
          '[class*="recipient" i]',
          '[class*="to-name" i]',
          '[data-testid*="receiver" i]',
        ]);
        const messageText = firstText(node, [
          ".chat-message__text-content",
          ".new-chat-message__text-content",
          ".chat-message__text-box",
          '[class*="message-content" i]',
          '[class*="message-text" i]',
          '[class*="chat-message__text" i]',
          '[data-testid*="message-content" i]',
        ]);
        const timeText = firstText(group, [
          ".chat-item__chat-info-time-stamp",
          ".new-chat-item__chat-info-time-stamp",
          "time",
          '[class*="time" i]',
          '[data-testid*="time" i]',
        ]);
        const headerText = firstText(group, [
          ".chat-item__chat-info-header",
          ".new-chat-item__chat-info-header",
        ]);
        const nodeText = text(node);
        const stableNode =
          node.closest("[data-message-id], [data-id]") ||
          group.closest("[data-message-id], [data-id]") ||
          node;
        let messageIdAttribute: "data-message-id" | "data-id" | "id" | undefined;
        let messageId = "";
        if (stableNode.getAttribute("data-message-id")) {
          messageIdAttribute = "data-message-id";
          messageId = stableNode.getAttribute("data-message-id") || "";
        } else if (stableNode.getAttribute("data-id")) {
          messageIdAttribute = "data-id";
          messageId = stableNode.getAttribute("data-id") || "";
        } else if (stableNode.id) {
          messageIdAttribute = "id";
          messageId = stableNode.id;
        }
        return {
          key: messageId,
          messageId,
          messageIdAttribute,
          text: nodeText,
          headerText,
          ariaLabel: node.getAttribute("aria-label") || "",
          senderText,
          receiverText,
          messageText,
          timeText,
          directMessage: /direct message|privately|private message/i.test(
            `${headerText} ${nodeText} ${node.getAttribute("aria-label") || ""}`,
          ),
        };
      });
    });
  }

  private async inspectChatDom(): Promise<ZoomWebChatDomDiagnostics | null> {
    if (!this.frame || this.frame.isDetached()) {
      return null;
    }
    return this.frame
      .evaluate(() => {
        const input = Array.from(
          document.querySelectorAll(
            'textarea.chat-box__chat-textarea, .chat-rtf-box__edit[contenteditable="true"], .chat-rtf-box__editor-wrapper [contenteditable="true"], [contenteditable="true"][role="textbox"], textarea',
          ),
        ).find((candidate) => {
          const element = candidate as HTMLElement;
          const bounds = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            bounds.width > 0 &&
            bounds.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        });
        if (!input) {
          return null;
        }
        const root =
          input.closest(".chat-container, .chat-container-one-chat") ||
          document.querySelector(".chat-container, .chat-container-one-chat") ||
          document;
        return {
          inputClass: (input as HTMLElement).className || "",
          rootClass:
            root instanceof HTMLElement && typeof root.className === "string"
              ? root.className
              : "",
          chatItemContainers: root.querySelectorAll(".chat-item-container").length,
          legacyMessageContainers: root.querySelectorAll(
            ".chat-message__container",
          ).length,
          newMessageContainers: root.querySelectorAll(
            ".new-chat-message__container",
          ).length,
          roleRows: root.querySelectorAll('[role="row"]').length,
        };
      })
      .catch(() => null);
  }

  private messageLocator(replyTarget: ZoomWebChatReplyTarget): Locator {
    const frame = this.frame!;
    const messageId = (replyTarget.messageId ?? "").trim();
    const attr = replyTarget.messageIdAttribute;
    if (messageId && attr === "id") {
      return frame.locator(`[id="${messageId}"]`).first();
    }
    if (messageId && attr) {
      return frame.locator(`[${attr}="${messageId}"]`).first();
    }
    if (messageId) {
      return frame
        .locator(
          `[data-id="${messageId}"], [data-message-id="${messageId}"], [id="${messageId}"]`,
        )
        .first();
    }
    const snippet = (replyTarget.message ?? "").trim();
    if (snippet) {
      return frame
        .locator(".new-chat-message__container, .chat-message__container")
        .filter({ hasText: snippet.slice(0, 80) })
        .last();
    }
    return frame.locator(".new-chat-message__container, .chat-message__container").last();
  }

  private async nestedComposerOpen(replyTarget?: ZoomWebChatReplyTarget): Promise<boolean> {
    if (!this.frame || this.frame.isDetached()) {
      return false;
    }
    if (replyTarget) {
      const nestedInput = await this.findNestedReplyInput(replyTarget);
      if (nestedInput) {
        return true;
      }
    }
    const marker = this.frame.locator(
      [
        ".chat-container__chat-footer .chat-rtf-box__reply",
        ".chat-container__chat-footer .chat-rtf-box__reply-wrap",
        ".chat-container__chat-footer .new-chat-reply-context",
        ".chat-container__chat-footer [class*='reply-context']",
        ".chat-container__chat-footer [class*='quoted-message']",
        '[class*="thread-composer" i]',
        '[aria-label*="Replying" i]',
        '[aria-label*="replying to" i]',
      ].join(", "),
    );
    if (await marker.first().isVisible().catch(() => false)) {
      return true;
    }
    return this.frame
      .evaluate(() => {
        const footer = document.querySelector(
          ".chat-container__chat-footer, .chat-box, .chat-rtf-box, .new-chat-editor",
        );
        if (!footer) {
          return false;
        }
        const footerText = (footer as HTMLElement).innerText || "";
        if (/replying to/i.test(footerText)) {
          return true;
        }
        const editor = footer.querySelector(
          '.ProseMirror, [contenteditable="true"], textarea',
        ) as HTMLElement | null;
        const ph =
          editor?.getAttribute("data-placeholder") ||
          editor?.getAttribute("aria-placeholder") ||
          editor?.getAttribute("aria-label") ||
          "";
        return /replying to|reply to this message|reply in thread/i.test(ph);
      })
      .catch(() => false);
  }

  private async beginNestedReply(replyTarget: ZoomWebChatReplyTarget): Promise<void> {
    if (!this.frame || this.frame.isDetached() || !this.page) {
      throw new Error("Zoom Web App frame is not ready for nested reply");
    }

    this.nestedReplyBusyUntil = Date.now() + 20_000;
    await this.ensureChatPanelOpen();
    const message = this.messageLocator(replyTarget);
    await message.waitFor({ state: "attached", timeout: 5_000 }).catch(() => undefined);
    await message.scrollIntoViewIfNeeded().catch(() => undefined);

    const row = message
      .locator(
        'xpath=ancestor::div[contains(@class,"chat-item-container") or contains(@class,"chat-item-position") or contains(@class,"new-chat-item")][1]',
      )
      .first();
    const hoverTarget = (await row.count().catch(() => 0)) > 0 ? row : message;

    await hoverTarget.hover({ force: true, timeout: 3_000 }).catch(() => undefined);
    const box = await hoverTarget.boundingBox().catch(() => null);
    if (box) {
      await this.page.mouse.move(
        box.x + Math.max(8, box.width - 12),
        box.y + Math.min(18, box.height / 2),
      );
      await this.page.waitForTimeout(400).catch(() => undefined);
    }

    const dump = await this.dumpChatState(replyTarget);
    this.emit("nested-reply-dom", { messageId: replyTarget.messageId, dump });

    const rowReply = hoverTarget
      .locator("button.new-chat-message__options-button[aria-label='Reply']")
      .first();
    await rowReply
      .evaluate((el) => {
        const html = el as HTMLElement;
        let node: HTMLElement | null = html;
        for (let i = 0; i < 6 && node; i += 1) {
          node.style.setProperty("display", "inline-flex", "important");
          node.style.setProperty("visibility", "visible", "important");
          node.style.setProperty("opacity", "1", "important");
          node.style.setProperty("pointer-events", "auto", "important");
          node = node.parentElement;
        }
      })
      .catch(() => undefined);

    const tryOpen = async (via: string, action: () => Promise<void>): Promise<boolean> => {
      await action();
      await this.page!.waitForTimeout(700).catch(() => undefined);
      const open = await this.nestedComposerOpen(replyTarget);
      this.emit("nested-reply-attempt", {
        messageId: replyTarget.messageId,
        via,
        open,
        state: await this.dumpChatState(replyTarget),
      });
      if (open) {
        this.emit("nested-reply-opened", {
          messageId: replyTarget.messageId,
          via,
        });
        return true;
      }
      return false;
    };

    if (
      await tryOpen("playwright-row-reply", async () => {
        if ((await rowReply.count().catch(() => 0)) > 0) {
          await rowReply.click({ timeout: 2_000 });
        } else {
          await this.frame!.locator(
            "button.new-chat-message__options-button[aria-label='Reply']",
          )
            .last()
            .click({ timeout: 2_000 });
        }
      })
    ) {
      return;
    }

    if (
      await tryOpen("dom-group-reply", async () => {
        await this.frame!.evaluate((target) => {
          const escape = (value: string) =>
            typeof CSS !== "undefined" && CSS.escape
              ? CSS.escape(value)
              : value.replace(/"/g, '\\"');
          const messageId = (target.messageId ?? "").trim();
          let node: Element | null = null;
          if (messageId && target.messageIdAttribute) {
            node =
              target.messageIdAttribute === "id"
                ? document.getElementById(messageId)
                : document.querySelector(
                    `[${target.messageIdAttribute}="${escape(messageId)}"]`,
                  );
          }
          if (!node && messageId) {
            node = document.querySelector(
              `[data-id="${escape(messageId)}"], [data-message-id="${escape(messageId)}"]`,
            );
          }
          const group =
            node?.closest(
              ".chat-item-container, .chat-item-position, .new-chat-item__chat-msg-wrap, .new-chat-item, [role='row'], .new-chat-message__container",
            ) || node;
          const buttons = Array.from(
            (group || document).querySelectorAll(
              "button.new-chat-message__options-button[aria-label='Reply']",
            ),
          ) as HTMLElement[];
          const btn =
            buttons[0] ||
            (Array.from(
              document.querySelectorAll(
                "button.new-chat-message__options-button[aria-label='Reply']",
              ),
            ).at(-1) as HTMLElement | undefined);
          if (!btn) {
            return;
          }
          const rect = btn.getBoundingClientRect();
          const opts: MouseEventInit = {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: rect.x + rect.width / 2,
            clientY: rect.y + rect.height / 2,
            buttons: 1,
          };
          btn.dispatchEvent(new PointerEvent("pointerdown", opts));
          btn.dispatchEvent(new MouseEvent("mousedown", opts));
          btn.dispatchEvent(new PointerEvent("pointerup", opts));
          btn.dispatchEvent(new MouseEvent("mouseup", opts));
          btn.dispatchEvent(new MouseEvent("click", opts));
        }, replyTarget);
      })
    ) {
      return;
    }

    const replyBox = await rowReply.boundingBox().catch(() => null);
    this.emit("nested-reply-box", {
      messageId: replyTarget.messageId,
      replyBox,
    });
    if (
      replyBox &&
      replyBox.width > 1 &&
      replyBox.height > 1 &&
      (await tryOpen("page-mouse-reply", async () => {
        await this.page!.mouse.click(
          replyBox.x + replyBox.width / 2,
          replyBox.y + replyBox.height / 2,
        );
      }))
    ) {
      return;
    }

    throw new Error(
      "Unable to open Zoom nested reply composer (reply toolbar click did not start a thread)",
    );
  }

  private async selectRecipient(receiverName: string, privateReply: boolean): Promise<void> {
    if (!this.frame || this.frame.isDetached()) {
      throw new Error("Zoom Web App frame is not ready");
    }
    const input = await this.findChatInput();
    if (!input) {
      throw new Error("Zoom Web App chat input is not available");
    }

    const recipientToggle = this.frame
      .locator(
        '.chat-receiver-list__receiver, [aria-label^="Send chat to" i], button[aria-label*="recipient" i], button[aria-label*="send to" i], button[aria-haspopup="listbox"]',
      )
      .filter({ visible: true })
      .last();

    const selectedReceiver = this.frame
      .locator(".chat-receiver-list__receiverName")
      .filter({ visible: true })
      .last();
    const selectedReceiverText = compactText(
      await selectedReceiver
        .evaluateAll((elements) => {
          const element = elements.at(-1) as HTMLElement | undefined;
          return element?.innerText || element?.textContent || "";
        })
        .catch(() => ""),
    );
    const nearbyText = compactText(
      await input
        .evaluate((element) => {
          const footer = element.closest(
            '.chat-container__chat-footer, [class*="chat-box"]',
          ) as HTMLElement | null;
          return footer?.innerText || footer?.textContent || "";
        })
        .catch(() => ""),
    );
    const alreadySelected = new RegExp(
      `^${escapeRegExp(receiverName)}(?:\\s|$)|\\b${escapeRegExp(receiverName)}\\b`,
      "i",
    ).test(selectedReceiverText || nearbyText);
    if (alreadySelected) {
      return;
    }

    if (!(await recipientToggle.isVisible().catch(() => false))) {
      if (privateReply) {
        throw new Error(
          `Cannot select private Zoom Web App chat recipient ${receiverName}`,
        );
      }
      return;
    }

    await recipientToggle
      .evaluate((toggle) => (toggle as HTMLElement).click())
      .catch(async () => recipientToggle.click({ force: true, timeout: 2_000 }));
    const exactReceiverText = new RegExp(
      `^\\s*${escapeRegExp(receiverName)}(?:\\s*\\([^)]*\\))?\\s*$`,
      "i",
    );
    const exactMenuItems = this.frame
      .locator(".chat-receiver-list__menu-item")
      .filter({ hasText: exactReceiverText })
      .filter({ visible: true });
    let exactMenuItemCount = 0;
    const optionDeadline = Date.now() + 2_000;
    while (Date.now() < optionDeadline && exactMenuItemCount === 0) {
      exactMenuItemCount = await exactMenuItems.count();
      if (exactMenuItemCount === 0) {
        await sleep(50);
      }
    }
    if (privateReply && exactMenuItemCount > 1) {
      throw new Error(
        `Zoom Web App has multiple private chat recipients named ${receiverName}`,
      );
    }
    const option =
      exactMenuItemCount > 0
        ? exactMenuItems.first()
        : this.frame
            .getByRole("option", { name: receiverName, exact: true })
            .or(
              this.frame.getByRole("menuitemradio", {
                name: exactReceiverText,
              }),
            )
            .or(this.frame.getByRole("menuitem", { name: receiverName, exact: true }))
            .filter({ visible: true })
            .last();
    const optionVisible = await option
      .waitFor({ state: "visible", timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    if (!optionVisible) {
      if (privateReply) {
        throw new Error(`Zoom Web App chat recipient ${receiverName} is not available`);
      }
      throw new Error("Zoom Web App public chat recipient Everyone is not available");
    }
    await option.click({ force: true, timeout: 2_000 });

    const verifyDeadline = Date.now() + 2_000;
    while (Date.now() < verifyDeadline) {
      const selectedText = compactText(
        await selectedReceiver
          .evaluateAll((elements) => {
            const element = elements.at(-1) as HTMLElement | undefined;
            return element?.innerText || element?.textContent || "";
          })
          .catch(() => ""),
      );
      if (
        new RegExp(`^${escapeRegExp(receiverName)}(?:\\s|$)`, "i").test(
          selectedText,
        )
      ) {
        return;
      }
      await sleep(50);
    }

    throw new Error(
      privateReply
        ? `Zoom Web App did not confirm private recipient ${receiverName}`
        : "Zoom Web App did not confirm public recipient Everyone",
    );
  }

  private resetChatState(): void {
    this.chatPanelReady = false;
    this.chatBaselineReady = false;
    this.joinedCandidateSince = null;
    this.chatDomRecordCount = 0;
    this.normalizedChatMessageCount = 0;
    this.lastChatPollAt = null;
    this.lastChatDiagnosticsAt = 0;
    this.chatDomDiagnostics = null;
    // Never carry a diagnostic override into a new meeting: with auto-scroll
    // off the chat list stays wherever it was left and the bot reads a stale
    // slice of the DOM, which looks identical to "nobody is talking".
    this.chatAutoScrollEnabled = true;
    this.nestedReplyBusyUntil = 0;
    this.seenMessages.clear();
    this.participantNames.clear();
  }

  private updateState(state: ZoomWebBotState, error?: unknown): void {
    this.state = state;
    this.setExternalState(state, error);
  }

  private async closeResources(): Promise<void> {
    this.stopMonitor();
    this.frame = null;
    if (this.page && !this.page.isClosed()) {
      await this.page.close({ runBeforeUnload: true }).catch(() => undefined);
    }
    this.page = null;
    if (this.context) {
      await this.context.close().catch(() => undefined);
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
  }
}
