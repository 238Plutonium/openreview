import assert from "node:assert/strict";
import test from "node:test";
import {
  VoiceInvocationManager,
  mergeVoiceTranscripts,
  normalizeVoiceText,
} from "../dist/voiceInvocation.js";

class FakeRuntime {
  nowValue = 1_000;
  nextId = 1;
  timers = new Map();

  now = () => this.nowValue;

  setTimeout = (callback, delayMs) => {
    const id = this.nextId++;
    this.timers.set(id, {
      callback,
      dueAt: this.nowValue + delayMs,
    });
    return id;
  };

  clearTimeout = (id) => {
    this.timers.delete(id);
  };

  advance(ms) {
    const target = this.nowValue + ms;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (!next) {
        break;
      }
      const [id, timer] = next;
      this.timers.delete(id);
      this.nowValue = timer.dueAt;
      timer.callback();
    }
    this.nowValue = target;
  }
}

const defaultConfig = {
  enabled: true,
  available: true,
  unavailableReasons: [],
  wakePhrases: [
    "hello echo ai assistant",
    "hello echo ai",
    "hi echo ai assistant",
    "hi echo ai",
  ],
  followupTimeoutMs: 12_000,
  maxQuestionMs: 30_000,
  maxQuestionChars: 1_000,
  cooldownMs: 5_000,
};

function transcript({
  text,
  boundary = "speaker-idle",
  streamId = "stream-1",
  userId = 101,
  userName = "Alice",
  startTimestamp = 10_000,
  endTimestamp = 11_000,
}) {
  return {
    streamId,
    meetingUuid: "meeting-1",
    userId,
    userName,
    text,
    startTimestamp,
    endTimestamp,
    boundary,
  };
}

function harness(overrides = {}) {
  const runtime = new FakeRuntime();
  const events = [];
  const questions = [];
  const manager = new VoiceInvocationManager(
    { ...defaultConfig, ...overrides },
    (type, payload) => events.push({ type, payload }),
    (question) => questions.push(question),
    runtime,
  );
  return { runtime, events, questions, manager };
}

test("normalizes punctuation, case, and A.I.", () => {
  assert.equal(
    normalizeVoiceText("Hello, ECHO A.I. Assistant!"),
    "hello echo ai assistant",
  );
});

test("merges overlapping ASR windows", () => {
  assert.equal(
    mergeVoiceTranscripts(
      "Hello ECHO AI what is today's",
      "what is today's course outline",
    ),
    "Hello ECHO AI what is today's course outline",
  );
});

test("supports every configured wake phrase in the same utterance", () => {
  for (const phrase of defaultConfig.wakePhrases) {
    const { manager, questions } = harness();
    manager.ingest(transcript({ text: `${phrase}, what is this slide about?` }));
    assert.equal(questions.length, 1, phrase);
    assert.equal(questions[0].question, "what is this slide about");
    assert.equal(questions[0].wakePhrase, phrase);
  }
});

test("tolerates common Whisper wake-phrase transcription errors", () => {
  const variants = [
    "Hi Echo Assistant, what is this slide about?",
    "Hi, I'm Echo AI Assistant, what is this slide about?",
    "Hello Iko, what is this slide about?",
  ];
  for (const text of variants) {
    const { manager, questions } = harness();
    manager.ingest(transcript({ text }));
    assert.equal(questions.length, 1, text);
    assert.equal(questions[0].question, "what is this slide about");
  }
});

test("detects a wake phrase split across overlapping ASR windows", () => {
  const { manager, questions } = harness();
  manager.ingest(
    transcript({
      text: "Hello ECHO",
      boundary: "max-window",
      endTimestamp: 15_000,
    }),
  );
  manager.ingest(
    transcript({
      text: "ECHO AI what examples are used in the slide",
      boundary: "speaker-idle",
      startTimestamp: 14_000,
      endTimestamp: 18_000,
    }),
  );
  assert.equal(questions.length, 1);
  assert.equal(questions[0].question, "what examples are used in the slide");
  assert.equal(questions[0].rawTranscripts.length, 2);
});

test("supports a follow-up utterance from the same speaker only", () => {
  const { manager, questions } = harness();
  manager.ingest(transcript({ text: "Hello ECHO AI" }));
  assert.equal(questions.length, 0);

  manager.ingest(
    transcript({
      text: "What is the current slide about",
      userId: 202,
      userName: "Bob",
    }),
  );
  assert.equal(questions.length, 0);

  manager.ingest(
    transcript({
      text: "What is the current slide about",
      startTimestamp: 12_000,
      endTimestamp: 13_000,
    }),
  );
  assert.equal(questions.length, 1);
  assert.equal(questions[0].userId, 101);
  assert.equal(questions[0].question, "What is the current slide about");
});

test("keeps concurrent speaker invocations isolated", () => {
  const { manager, questions } = harness();
  manager.ingest(transcript({ text: "Hello ECHO AI" }));
  manager.ingest(
    transcript({
      text: "Hi ECHO AI summarize the meeting",
      userId: 202,
      userName: "Bob",
    }),
  );
  manager.ingest(
    transcript({
      text: "Explain this slide",
      startTimestamp: 12_000,
      endTimestamp: 13_000,
    }),
  );
  assert.equal(questions.length, 2);
  assert.deepEqual(
    questions.map((question) => [question.userId, question.question]),
    [
      [202, "summarize the meeting"],
      [101, "Explain this slide"],
    ],
  );
});

test("a new complete wake phrase resets an unsubmitted invocation", () => {
  const { manager, questions } = harness();
  manager.ingest(transcript({ text: "Hello ECHO AI" }));
  manager.ingest(
    transcript({
      text: "Hi ECHO AI what is the learning objective",
      startTimestamp: 12_000,
      endTimestamp: 13_000,
    }),
  );
  assert.equal(questions.length, 1);
  assert.equal(questions[0].wakePhrase, "hi echo ai");
  assert.equal(questions[0].question, "what is the learning objective");
  assert.equal(questions[0].rawTranscripts.length, 1);
});

test("does not trigger on ordinary greetings without ECHO", () => {
  const { manager, questions } = harness();
  manager.ingest(transcript({ text: "Hello everyone in today's meeting" }));
  assert.equal(questions.length, 0);
});

test("matches wake phrases after a short preamble", () => {
  const cases = [
    {
      text: "Um, hi, Echo AI assistant, are you able to hear me?",
      question: "are you able to hear me",
      wakePhrase: "hi echo ai assistant",
    },
    {
      text: "So let's ask it again. Hi, ECHO AI assistant, please summarize the meeting",
      question: "please summarize the meeting",
      wakePhrase: "hi echo ai assistant",
    },
    {
      text: "We should ask hello ECHO AI after the presentation",
      question: "after the presentation",
      wakePhrase: "hello echo ai",
    },
  ];
  for (const item of cases) {
    const { manager, questions } = harness();
    manager.ingest(transcript({ text: item.text }));
    assert.equal(questions.length, 1, item.text);
    assert.equal(questions[0].question, item.question, item.text);
    assert.equal(questions[0].wakePhrase, item.wakePhrase, item.text);
  }
});

test("wake-only after preamble still waits for a follow-up question", () => {
  const { manager, questions } = harness();
  manager.ingest(
    transcript({ text: "So let's ask it again. Hi, ECHO AI assistant." }),
  );
  assert.equal(questions.length, 0);
  manager.ingest(
    transcript({
      text: "Please summarize the meeting",
      startTimestamp: 12_000,
      endTimestamp: 13_000,
    }),
  );
  assert.equal(questions.length, 1);
  assert.equal(questions[0].question, "Please summarize the meeting");
});
test("silently expires when no follow-up question arrives", () => {
  const { manager, questions, events, runtime } = harness();
  manager.ingest(transcript({ text: "Hi ECHO AI" }));
  runtime.advance(12_001);
  assert.equal(questions.length, 0);
  assert.ok(
    events.some(
      (event) =>
        event.type === "voice-wake-expired" &&
        event.payload.reason === "followup-timeout",
    ),
  );
});

test("submits at maximum question duration during continuous speech", () => {
  const { manager, questions, runtime } = harness();
  manager.ingest(
    transcript({
      text: "Hello ECHO AI explain the main idea",
      boundary: "max-window",
    }),
  );
  runtime.advance(30_001);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].question, "explain the main idea");
});

test("enforces the character limit and cooldown", () => {
  const { manager, questions, events, runtime } = harness({
    maxQuestionChars: 18,
  });
  manager.ingest(
    transcript({
      text: "Hello ECHO AI explain the entire presentation in great detail",
      boundary: "max-window",
    }),
  );
  assert.equal(questions.length, 1);
  assert.ok(questions[0].question.length <= 18);

  manager.ingest(
    transcript({
      text: "Hello ECHO AI answer this duplicate",
      startTimestamp: 12_000,
      endTimestamp: 13_000,
    }),
  );
  assert.equal(questions.length, 1);
  assert.ok(
    events.some(
      (event) =>
        event.type === "voice-invocation-ignored" &&
        event.payload.reason === "cooldown",
    ),
  );

  runtime.advance(5_001);
  manager.ingest(
    transcript({
      text: "Hello ECHO AI answer a new question",
      startTimestamp: 18_000,
      endTimestamp: 19_000,
    }),
  );
  assert.equal(questions.length, 2);
});

test("reports unavailable dependencies without processing speech", () => {
  const { manager, questions } = harness({
    available: false,
    unavailableReasons: ["RTMS_ENABLED=false"],
  });
  manager.ingest(transcript({ text: "Hello ECHO AI what is this" }));
  assert.equal(questions.length, 0);
  assert.deepEqual(manager.health().unavailableReasons, ["RTMS_ENABLED=false"]);
});
