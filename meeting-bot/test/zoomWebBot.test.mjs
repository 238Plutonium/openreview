import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeZoomWebChatRecords,
  zoomWebParticipantId,
} from "../dist/zoomWebBot.js";

test("normalizes public Zoom Web App chat records", () => {
  const messages = normalizeZoomWebChatRecords(
    [
      {
        key: "message-1",
        messageId: "message-1",
        messageIdAttribute: "data-message-id",
        senderText: "Alice",
        receiverText: "Everyone in Meeting",
        messageText: "@ECHO AI Assistant what did we decide?",
        timeText: "10:31 AM",
      },
    ],
    "ECHO AI Assistant",
  );

  assert.deepEqual(
    messages.map(
      ({
        senderName,
        receiverName,
        message,
        privateToBot,
        messageId,
        occurrence,
      }) => ({
        senderName,
        receiverName,
        message,
        privateToBot,
        messageId,
        occurrence,
      }),
    ),
    [
      {
        senderName: "Alice",
        receiverName: "Everyone",
        message: "@ECHO AI Assistant what did we decide?",
        privateToBot: false,
        messageId: "message-1",
        occurrence: 1,
      },
    ],
  );
});

test("normalizes direct messages as private messages to the bot", () => {
  const [message] = normalizeZoomWebChatRecords(
    [
      {
        key: "message-2",
        text: "Bob to You (Direct Message) 10:32 AM What is the latest recommendation?",
        senderText: "Bob",
        receiverText: "You",
        messageText: "What is the latest recommendation?",
        directMessage: true,
      },
    ],
    "ECHO AI Assistant",
  );

  assert.equal(message.senderName, "Bob");
  assert.equal(message.receiverName, "ECHO AI Assistant");
  assert.equal(message.message, "What is the latest recommendation?");
  assert.equal(message.privateToBot, true);
});

test("parses Zoom headers with multi-word private recipients", () => {
  const [message] = normalizeZoomWebChatRecords(
    [
      {
        headerText:
          "Carol to ECHO AI Assistant (Direct Message) 10:33 AM",
        text: "Can you summarize that?",
        messageText: "Can you summarize that?",
      },
    ],
    "ECHO AI Assistant",
  );

  assert.equal(message.senderName, "Carol");
  assert.equal(message.receiverName, "ECHO AI Assistant");
  assert.equal(message.privateToBot, true);
});

test("maps Zoom's own-message sender label back to the bot name", () => {
  const [message] = normalizeZoomWebChatRecords(
    [
      {
        senderText: "Me",
        receiverText: "to Everyone",
        messageText: "test reply",
      },
    ],
    "ECHO AI Assistant",
  );

  assert.equal(message.senderName, "ECHO AI Assistant");
  assert.equal(message.receiverName, "Everyone");
});

test("creates distinct keys for repeated identical rendered messages", () => {
  const messages = normalizeZoomWebChatRecords(
    [
      { senderText: "Alice", messageText: "hello", receiverText: "Everyone" },
      { senderText: "Alice", messageText: "hello", receiverText: "Everyone" },
    ],
    "ECHO AI Assistant",
  );

  assert.equal(messages.length, 2);
  assert.notEqual(messages[0].key, messages[1].key);
  assert.equal(messages[0].occurrence, 1);
  assert.equal(messages[1].occurrence, 2);
});

test("participant IDs are stable across case and whitespace variants", () => {
  assert.equal(
    zoomWebParticipantId(" Alice  Smith "),
    zoomWebParticipantId("alice smith"),
  );
  assert.notEqual(
    zoomWebParticipantId("Alice Smith"),
    zoomWebParticipantId("Bob Smith"),
  );
});
