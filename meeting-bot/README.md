# ECHO meeting-bot (public reviewer snapshot)

MIT-licensed source for the Zoom RTMS in-meeting assistant used in the NAACL 2027 System Demonstration.

**Not included:** `.env` credentials, prior-session index, session media/PHI, private-db build pipelines, OAuth state.

## Quick paths
- Configure from `.env.example` (placeholders only).
- `npm install && npm run build && npm start` with local GPU AI services.
- Optional fixture multimodal path: set `DEMO_REPLAY_ENABLED=true`, then `npm run demo:replay` (see `demo_replay/README.md`).
- Public literature demo (no Zoom): see `../website/`.

Educational use only — not clinical advice.
