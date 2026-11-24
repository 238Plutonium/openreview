# Demo follow-ups (Rui) — avatar, PSU Zoom, replies, voice

## 1. Logo / avatar for ECHO

- In-bot brand mark: `public/echo-avatar.svg` (shown in `public/bot.html`).
- Zoom roster avatar for participants: Meeting SDK guest joins **cannot** set a custom profile picture via `client.join()`.
  To show ECHO’s face in the Zoom participant list, upload `echo-avatar.svg` (or a PNG export) as the **profile picture of the Zoom user** used when joining with ZAK, then join with that user’s ZAK.
- Marketplace app icon: set the same asset on the Zoom App Marketplace listing.

## 2. How to use PSU Zoom (`psu.zoom.us`)

Same-account meetings (original bot, port **3000**) work with JWT only.

External / other-host PSU meetings (for example **4954771701**) need Marketplace scope **`user:read:token`**, re-OAuth, and a ZAK join. The separate `:3010` sibling worktree used for that experiment was **removed** (join kept failing with SDK error 200 without that scope). Recreate a dedicated instance only after the scope is granted.

## 3. Reply under each question

**Not available on Zoom Web Meeting SDK.** Native “Reply” under a public chat message (`threadId` / `setThreadId`) exists on Android / iOS / Windows / Linux Meeting SDKs only. Web Component View `sendChat(message, userId?)` has no thread parameter (SDK 4.0.7; still undocumented on web as of 2026).

What ECHO does instead in **Everyone** chat for `@mention` and voice answers:

```text
Re @Alice: "what's on the slide"

<answer>
```

Private DMs to the bot stay private (1:1). True nested public replies would require migrating the bot off the Web Meeting SDK.

## 4. Post-session summary outside chat

Auto-DM / public chat of meeting minutes is intentionally **not** used (demo feedback: summaries outside chat).

When `MEETING_MINUTES_ENABLED=true`, minutes generate on **RTMS session close** and on **bot leave**:

- Files: `data/rtms/minutes/<streamId>/summary.md`
- JSON: `GET /meeting-minutes/latest`
- Download: `GET /meeting-minutes/summary.md`

ICDS / Laura can pull or forward the markdown after the session. Nothing is posted into Zoom chat.

## 5. Voice support

```env
VOICE_INVOCATION_ENABLED=true
ASR_ENABLED=true
RTMS_ENABLED=true
AI_ENABLED=true
VOICE_WAKE_PHRASES=hello echo ai assistant,hello echo ai,hi echo ai assistant,hi echo ai
```

Say a wake phrase, then the question. Answers go to Everyone chat with the soft `Re @…` prefix when a speaker name is available. Requires ASR on `:7001` and live RTMS audio.
