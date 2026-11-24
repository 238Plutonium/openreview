# Zoom Web App join (new method)

## Old vs new

| | Old Meeting SDK Embedded | New Zoom Web App + Playwright |
|---|---|---|
| Code | `src/bot.ts` + `/bot.html` + `/signature` | `src/zoomWebBot.ts` |
| Join auth | JWT Meeting SDK signature (often needs same-account / ZAK for PSU) | Guest join via `https://app.zoom.us/wc/join` — **no PSU Zoom account required for the bot** |
| Visible bot | Embedded SDK participant | Official Zoom web client as `ECHO AI Assistant` |
| Chat | SDK `sendChat` | DOM chat panel |
| RTMS / Zoom App | Separate (Gmail app owner) | Unchanged — keep separate from join |

## Proven setup (handoff test)

1. **PSU account** hosts a PSU Zoom meeting  
2. **Gmail account** (Zoom Marketplace / RTMS app) joins as a normal participant  
3. **Web App bot** joins through `app.zoom.us` (Playwright) — no PSU host privileges on the bot identity  

Host still admits the bot from the waiting room when enabled.

## Config

```env
ZOOM_WEB_APP_URL=https://app.zoom.us/wc/join
ZOOM_WEB_DOMAIN=app.zoom.us
ZOOM_MEETING_NUMBER=...
ZOOM_MEETING_PASSWORD=
BOT_NAME=ECHO AI Assistant
```

Active deploy directory: `web_bot_deploy/` (same join implementation + AI/voice fixes).
