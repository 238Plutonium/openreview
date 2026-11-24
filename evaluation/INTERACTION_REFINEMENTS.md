# Facilitator-only + quieter replies

Optional deployment flags (default **off** so live demos keep current behavior):

| Flag | Effect |
|---|---|
| `ECHO_FACILITATOR_ONLY=true` | Non-allowlisted askers get a short deferral instead of a model answer |
| `ECHO_ALLOWED_ASKERS` | Comma-separated Zoom display names / substrings |
| `ECHO_QUIET_REPLIES=true` | Forces concise style and lowers default `ANSWER_LLM_MAX_CHARS` to 280 |

**Status:** implemented in the lab experiment checkout and mirrored into the public meeting-bot snapshot sources. These controls are available in the released bot; the September facilitator form predates enabling them as defaults.
