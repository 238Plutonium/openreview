# Joining Zoom with the web-app bot

ECHO-AI can join meetings through the Zoom web client (`app.zoom.us`) driven by Playwright, as an alternative to the Meeting SDK embedded participant.

## Approaches

| | Meeting SDK (legacy) | Web App + Playwright (current) |
| --- | --- | --- |
| Implementation | `src/bot.ts`, `/bot.html`, `/signature` | `src/zoomWebBot.ts` |
| Join authentication | JWT Meeting SDK signature (often same-account or ZAK) | Guest join via `https://app.zoom.us/wc/join` |
| Visible identity | Embedded SDK participant | Zoom web client as `ECHO AI Assistant` |
| Chat delivery | SDK `sendChat` | DOM chat panel |
| RTMS / Zoom App | Separate Marketplace app | Unchanged; keep RTMS ownership separate from join |

Guest web join does not require the bot identity to hold host-account privileges. The meeting host still admits the bot from the waiting room when waiting-room is enabled.

## Recommended operating pattern

1. An institutional account hosts the Zoom meeting.
2. The RTMS / Marketplace app owner joins as a normal participant when RTMS capture is required.
3. The web-app bot joins through `app.zoom.us` under `BOT_NAME`.

## Configuration

```env
ZOOM_WEB_APP_URL=https://app.zoom.us/wc/join
ZOOM_WEB_DOMAIN=app.zoom.us
ZOOM_MEETING_NUMBER=...
ZOOM_MEETING_PASSWORD=
BOT_NAME=ECHO AI Assistant
```

Copy values from `.env.example` and keep secrets out of version control. The deployable join implementation lives under `web_bot_deploy/` when that directory is present in the release.
