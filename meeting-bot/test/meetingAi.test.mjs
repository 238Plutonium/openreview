import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MeetingAiManager,
  pcm16Rms,
  questionFocus,
  privateIndexAllowed,
  looksLikeSelfIdentityQuestion,
  selfIdentityAnswer,
  looksLikeThinSlideAnswer,
  preferSlideBodyText,
  formatZoomChatReply,
  looksLikeDeniedSlideAccess,
  usesClinicalAnswerMode,
  appendClinicalDisclaimer,
  CLINICAL_ZOOM_DISCLAIMER_EN,
  renderEvidenceSourceReferences,
  trimAtSentenceBoundary,
  trimAnswerPreservingFootnotes,
  conciseAnswerCharCap,
} from "../dist/meetingAi.js";
import { looksLikeClinicalQuestion } from "../dist/retrieval.js";

test("conciseAnswerCharCap enforces demo-feedback Zoom ceilings", () => {
  assert.equal(conciseAnswerCharCap("concise", "default", 800), 450);
  assert.equal(conciseAnswerCharCap("concise", "clinical", 2800), 600);
  assert.equal(conciseAnswerCharCap("concise", "literature", 3500), 900);
  assert.equal(conciseAnswerCharCap("concise", "default", 300), 300);
  assert.equal(conciseAnswerCharCap("standard", "clinical", 2800), 2800);
});

function pcmFrame(amplitude, samples = 320) {
  const buffer = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    buffer.writeInt16LE(index % 2 === 0 ? amplitude : -amplitude, index * 2);
  }
  return buffer;
}

test("computes PCM16 RMS for silence and voiced audio", () => {
  assert.equal(pcm16Rms(Buffer.alloc(640)), 0);
  assert.equal(pcm16Rms(pcmFrame(1_000)), 1_000);
});

test("continuous RTMS silence does not postpone the speech idle boundary", async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }
    requests.push({ url: req.url, body: body ? JSON.parse(body) : null });
    res.setHeader("content-type", "application/json");
    if (req.url === "/transcribe") {
      res.end(
        JSON.stringify({
          text: "Hi Echo AI Assistant what is opioid use disorder",
          language: "en",
          durationSeconds: 0.06,
          inferenceSeconds: 0.01,
          segments: [],
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({
        choices: [{ message: { content: "Opioid use disorder is treatable." } }],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "echo-meeting-ai-"));
  const events = [];
  const sent = [];
  const manager = new MeetingAiManager(
    {
      enabled: true,
      dataDir,
      asrEnabled: true,
      asrServiceUrl: `http://127.0.0.1:${port}`,
      asrChunkSeconds: 5,
      asrOverlapSeconds: 1,
      asrSpeechRmsThreshold: 200,
      asrSpeechPrerollMs: 20,
      vlmBaseUrl: `http://127.0.0.1:${port}/v1`,
      vlmModel: "vlm",
      vlmApiKey: "",
      vlmMaxTokens: 100,
      ragVlmMaxTokens: 150,
      vlmEnableThinking: false,
      answerLlmEnabled: true,
      answerLlmBaseUrl: `http://127.0.0.1:${port}/v1`,
      answerLlmModel: "formatter",
      answerLlmApiKey: "",
      answerLlmMaxTokens: 100,
      answerLlmMaxChars: 800,
      ragAnswerLlmMaxTokens: 140,
      ragAnswerLlmMaxChars: 1000,
      literatureAnswerMaxTokens: 200,
      literatureAnswerMaxChars: 1600,
      answerStyle: "concise",
      answerLlmEnableThinking: false,
      contextMode: "full-with-summary-fallback",
      screenShareEnabled: false,
      screenShareMaxImages: 0,
      screenShareMemoryLimit: 20,
      screenShareMaxImageBytes: 1_000_000,
      fullContextMaxChars: 20_000,
      recentContextMaxChars: 6_000,
      relevantContextMaxChars: 6_000,
      summaryUpdateSeconds: 4_000_000_000,
      summaryUpdateChars: 1_000_000,
      asrIdleFlushMs: 30,
      voiceInvocationEnabled: true,
      voiceInvocationAvailable: true,
      voiceInvocationUnavailableReasons: [],
      voiceWakePhrases: ["hi echo ai assistant"],
      voiceFollowupTimeoutMs: 12_000,
      voiceMaxQuestionMs: 30_000,
      voiceMaxQuestionChars: 1_000,
      voiceCooldownMs: 5_000,
    },
    (type, payload) => events.push({ type, payload }),
    async (message) => {
      sent.push(message);
      return {};
    },
  );

  const startedAt = Date.now();
  const baseChunk = {
    streamId: "stream-1",
    meetingUuid: "meeting-1",
    userId: 101,
    userName: "Alice",
    receivedAt: new Date().toISOString(),
    size: 640,
  };

  try {
    manager.ingestAudioChunk({
      ...baseChunk,
      timestamp: startedAt,
      buffer: pcmFrame(1_000),
    });
    for (let index = 1; index <= 12; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      manager.ingestAudioChunk({
        ...baseChunk,
        timestamp: startedAt + index * 20,
        buffer: pcmFrame(0),
      });
    }

    const deadline = Date.now() + 1_000;
    while (sent.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(sent.length, 1);
    assert.ok(Date.now() - startedAt < 500);
    assert.ok(
      events.some(
        (event) =>
          event.type === "voice-question-submitted" &&
          event.payload.reason === "speaker-idle",
      ),
    );
    assert.equal(
      requests.filter((request) => request.url === "/transcribe").length,
      1,
    );
    const llmRequest = requests.find((request) =>
      request.url?.endsWith("/chat/completions"),
    );
    assert.equal(
      llmRequest.body.chat_template_kwargs.enable_thinking,
      false,
    );
  } finally {
    await manager.shutdown();
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("routes questions about spoken words away from the screen share", () => {
  for (const question of [
    "@ECHO AI Assistant what did i say",
    "@ECHO AI Assistant can you hear what i juis tsaid",
    "@ECHO AI Assistant what did he say just now",
    "@ECHO AI Assistant what was he talking about juswt now",
    "@ECHO AI Assistant what did you just hear from him",
    "@ECHO AI Assistant what's the teacher discussing",
    "@ECHO AI Assistant what is he saying",
    "@ECHO AI Assistant 他刚才说了什么",
    "@ECHO AI Assistant what did he say about the slide",
  ]) {
    assert.equal(questionFocus(question), "speech", question);
  }
});

test("keeps slide-reading questions on the visual path even when they use say", () => {
  for (const question of [
    "@ECHO AI Assistant what does my slide say",
    "@ECHO AI Assistant what does the slide say",
    "@ECHO AI Assistant what does the screen say",
    "@ECHO AI Assistant read the slide",
    "@ECHO AI Assistant read the page",
    "@ECHO AI Assistant what's on the page",
  ]) {
    assert.equal(questionFocus(question), "visual", question);
  }
});

test("keeps screen share questions on the visual path", () => {
  for (const question of [
    "@ECHO AI Assistant what's on the slide",
    "@ECHO AI Assistant what's the main content on the slide",
    "@ECHO AI Assistant can you read the screen",
    "@ECHO AI Assistant 幻灯片上是什么",
  ]) {
    assert.equal(questionFocus(question), "visual", question);
  }
});

test("detects identity and capability questions that should not attach slides", () => {
  for (const question of [
    "@ECHO AI Assistant who are you?",
    "hi who are you",
    "@ECHO AI Assistant Can you introduce yourself?",
    "@ECHO AI Assistant What can you do?",
    "what can you do?",
    "你是谁",
  ]) {
    assert.equal(looksLikeSelfIdentityQuestion(question), true, question);
  }
  assert.equal(
    looksLikeSelfIdentityQuestion("@ECHO AI Assistant what does my slide say"),
    false,
  );
});

test("answers who-are-you from a template instead of the meeting VLM", () => {
  const english = selfIdentityAnswer("@ECHO AI Assistant who are you?");
  assert.match(english, /ECHO AI Assistant/);
  assert.match(english, /meeting/);
  assert.equal(english.includes("Sorry, I could not generate"), false);
  const chinese = selfIdentityAnswer("你是谁");
  assert.match(chinese, /我是ECHO AI Assistant/);
});

test("treats a slide-number-only VLM reply as too thin", () => {
  assert.equal(looksLikeThinSlideAnswer("Slide 1 of 28"), true);
  assert.equal(looksLikeThinSlideAnswer("Slide 25 of 28"), true);
  assert.equal(
    looksLikeThinSlideAnswer("The presentation is currently on Slide 25 of 28."),
    true,
  );
  assert.equal(
    looksLikeThinSlideAnswer(
      "The title slide is Opioid Addiction Treatment ECHO for providers and primary care teams.",
    ),
    false,
  );
  assert.equal(
    looksLikeThinSlideAnswer("Opioid Addiction Treatment ECHO. Slide 1 of 28."),
    false,
  );
  assert.equal(
    preferSlideBodyText("Opioid Addiction Treatment ECHO. Slide 1 of 28."),
    "Opioid Addiction Treatment ECHO.",
  );
  assert.equal(
    preferSlideBodyText(
      "Naltrexone Patient: Elective Surgery. Do not hold oral naltrexone. Slide 25 of 28.",
    ),
    "Naltrexone Patient: Elective Surgery. Do not hold oral naltrexone.",
  );
});

test("soft-quotes public Zoom replies under the question", () => {
  const publicAnswer = formatZoomChatReply(
    "The slide covers naltrexone and elective surgery.",
    {
      question: "@ECHO AI Assistant what's on the slide",
      senderName: "Rui",
      replyType: "public-mention",
    },
  );
  assert.match(publicAnswer, /^Re @Rui:/);
  assert.match(publicAnswer, /what's on the slide/);
  assert.match(publicAnswer, /naltrexone/);

  const privateAnswer = formatZoomChatReply("Private body.", {
    question: "secret question",
    senderName: "Rui",
    replyType: "private",
  });
  assert.equal(privateAnswer, "Private body.");
});

test("nested text replies keep raw body without soft-quote", () => {
  const nestedAnswer = formatZoomChatReply(
    "The slide covers naltrexone and elective surgery.",
    {
      question: "@ECHO AI Assistant what's on the slide",
      senderName: "Rui",
      replyType: "public-mention",
      replyToMessage: {
        messageId: "msg-123",
        messageIdAttribute: "data-message-id",
        senderName: "Rui",
        receiverName: "Everyone",
        privateToBot: false,
        message: "@ECHO AI Assistant what's on the slide",
        timeText: "10:31 AM",
        occurrence: 1,
      },
    },
  );
  assert.equal(
    nestedAnswer,
    "The slide covers naltrexone and elective surgery.",
  );
  assert.doesNotMatch(nestedAnswer, /^Re @/);
});

test("voice answers @ the asker", () => {
  const voiceAnswer = formatZoomChatReply("Here is what I heard.", {
    question: "what is on the slide",
    senderName: "Qianyi Li",
    replyType: "voice-public",
  });
  assert.equal(voiceAnswer, "@Qianyi Li\n\nHere is what I heard.");
});

test("Zoom replies keep a newline before each citation number", () => {
  const body =
    "A [1] and B [2].\n\n[1]: PMID 1 | First\n\n[2]: PMID 2 | Second";
  const voiceAnswer = formatZoomChatReply(body, {
    question: "what is the evidence",
    senderName: "Qianyi Li",
    replyType: "voice-public",
  });
  assert.equal(
    voiceAnswer,
    "@Qianyi Li\n\nA [1] and B [2].\n\n[1]: PMID 1 | First\n\n[2]: PMID 2 | Second",
  );

  const publicAnswer = formatZoomChatReply(body, {
    question: "@ECHO AI Assistant what is the evidence",
    senderName: "Rui",
    replyType: "public-mention",
  });
  assert.match(publicAnswer, /\n\n\[1\]: PMID 1 \| First\n\n\[2\]: PMID 2 \| Second$/u);
});

test("detects formatter refusals that deny slide access", () => {
  assert.equal(
    looksLikeDeniedSlideAccess(
      "I don't have access to the slide content or context. Could you please describe what's on the slide?",
    ),
    true,
  );
  assert.equal(
    looksLikeDeniedSlideAccess(
      "The title slide is Opioid Addiction Treatment ECHO.",
    ),
    false,
  );
});

test("the public ask route cannot open the private index", () => {
  assert.equal(privateIndexAllowed({ replyType: "manual", allowPrivateIndex: false }), false);
  assert.equal(privateIndexAllowed({ replyType: "manual" }), false);
  assert.equal(
    privateIndexAllowed({ replyType: "public-mention", allowPrivateIndex: false }),
    false,
  );
  assert.equal(privateIndexAllowed({ replyType: "public-mention" }), true);
  assert.equal(privateIndexAllowed({ replyType: "private" }), true);
  assert.equal(privateIndexAllowed({ replyType: "voice-public" }), true);
});

test("does not treat substrings inside other words as speech", () => {
  for (const question of [
    "tell me about the art of motivational interviewing",
    "what is heart failure",
    "summarize the essay on the slide",
  ]) {
    assert.notEqual(questionFocus(question), "speech", question);
  }
  assert.equal(questionFocus("summarize the essay on the slide"), "visual");
  assert.equal(questionFocus("what is heart failure"), "general");
});

test("treats colloquial catch-up questions as general", () => {
  for (const question of [
    "@ECHO AI Assistant I've just entered. where're we getting at",
    "@ECHO AI Assistant what about now",
    "@ECHO AI Assistant what did i miss",
  ]) {
    assert.equal(questionFocus(question), "general", question);
  }
});

test("detects clinical questions for professional Zoom answers", () => {
  assert.equal(
    looksLikeClinicalQuestion("what dose of buprenorphine for OUD induction"),
    true,
  );
  assert.equal(usesClinicalAnswerMode("what dose of buprenorphine?", null), true);
  assert.equal(usesClinicalAnswerMode("what's on the slide", null), false);
  assert.equal(
    usesClinicalAnswerMode("quick catch-up?", {
      intent: "literature",
      literature: [{ pmid: "1" }],
      transcriptChunks: [],
      historicalCases: [],
    }),
    true,
  );
});

test("appends the fixed educational clinical disclaimer once", () => {
  const once = appendClinicalDisclaimer(
    "Bottom line: evidence suggests benefit.",
    "what is the evidence for buprenorphine?",
  );
  assert.match(once, new RegExp(CLINICAL_ZOOM_DISCLAIMER_EN));
  assert.equal(
    appendClinicalDisclaimer(once, "what is the evidence for buprenorphine?"),
    once,
  );
});

test("renders PMID citations as readable Source references", () => {
  const rendered = renderEvidenceSourceReferences(
    "Evidence suggests benefit [PMID:12345].",
    {
      literature: [
        {
          pmid: "12345",
          title: "Buprenorphine induction outcomes",
          publicationDate: "2024 Jun",
          publicationTypes: ["Clinical Trial"],
        },
      ],
      transcriptChunks: [],
      historicalCases: [],
    },
  );
  assert.equal(
    rendered,
    "Evidence suggests benefit [1].\n\n[1]: PMID 12345 | Buprenorphine induction outcomes | 2024 Jun | Clinical Trial",
  );
});

test("puts a blank line before each citation source", () => {
  const rendered = renderEvidenceSourceReferences(
    "A [PMID:1] and B [PMID:2].",
    {
      literature: [
        {
          pmid: "1",
          title: "First",
          publicationDate: "2024",
          publicationTypes: ["Journal Article"],
        },
        {
          pmid: "2",
          title: "Second",
          publicationDate: "2025",
          publicationTypes: ["Review"],
        },
      ],
      transcriptChunks: [],
      historicalCases: [],
    },
  );
  assert.equal(
    rendered,
    "A [1] and B [2].\n\n[1]: PMID 1 | First | 2024 | Journal Article\n\n[2]: PMID 2 | Second | 2025 | Review",
  );
});

test("puts a newline before each clustered citation number", () => {
  const rendered = renderEvidenceSourceReferences(
    "Supported by evidence [PMID:1][PMID:2], [PMID:3].",
    {
      literature: [
        {
          pmid: "1",
          title: "First",
          publicationDate: "2024",
          publicationTypes: ["Journal Article"],
        },
        {
          pmid: "2",
          title: "Second",
          publicationDate: "2025",
          publicationTypes: ["Review"],
        },
        {
          pmid: "3",
          title: "Third",
          publicationDate: "2026",
          publicationTypes: ["Guideline"],
        },
      ],
      transcriptChunks: [],
      historicalCases: [],
    },
  );
  assert.equal(
    rendered,
    "Supported by evidence [1]\n[2]\n[3].\n\n[1]: PMID 1 | First | 2024 | Journal Article\n\n[2]: PMID 2 | Second | 2025 | Review\n\n[3]: PMID 3 | Third | 2026 | Guideline",
  );
});

test("trims long answers at a sentence boundary instead of mid-word", () => {
  const text =
    "First complete sentence. Second complete sentence about counseling and behavioral therapies to address underlying drivers of use.";
  const trimmed = trimAtSentenceBoundary(text, 90);
  assert.match(trimmed, /\.\.\.$/u);
  assert.doesNotMatch(trimmed, /underlyi/u);
  assert.match(trimmed, /First complete sentence\./u);
});

test("trims prose but keeps full PMID footnotes intact", () => {
  const body =
    "Evidence suggests methadone maintenance can help with chronic pain management in selected patients, though responses vary and monitoring is required. Additional caveats about dose titration and psychosocial supports follow in this longer educational summary for Zoom chat.";
  const foot =
    "[1]: PMID 35349324 | Structural Adaptations to Methadone Maintenance Treatment and Take-Home Dosing for Opioid Use Disorder in the COVID-19 Pandemic | 2022 | Journal Article";
  const answer = `${body}\n\n${foot}`;
  const trimmed = trimAnswerPreservingFootnotes(answer, 280);
  assert.match(trimmed, /PMID 35349324/u);
  assert.match(
    trimmed,
    /Structural Adaptations to Methadone Maintenance Treatment and Take-Home Dosing for Opioid Use Disorder in the COVID-19 Pandemic/u,
  );
  assert.doesNotMatch(trimmed, /PMID 35349324[^\n]*\.\.\./u);
  assert.ok(trimmed.includes(foot));
  assert.ok(trimmed.length <= 280 || trimmed.endsWith(foot));
});
