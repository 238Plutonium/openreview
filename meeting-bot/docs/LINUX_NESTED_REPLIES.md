# Linux nested-reply bot (second version)

Keep the **current web bot** at `/scratch1/ECHO_project` (port 3000).

A second version lives at **`/scratch1/ECHO_linux_nested`**. It is meant to join Zoom with the **Linux Meeting SDK** so answers can use true nested **Reply** (`SetThreadId`), like the Zoom chat reply UI.

## Status

- Current web bot: unchanged, still the working demo bot.
- Linux version: scaffolded (config, Docker, chat/AI bridge). **Blocked on downloading Meeting SDK for Linux** into `lib/zoomsdk/`.

## Your next step

1. Zoom Marketplace → Meeting SDK → download **Meeting SDK for Linux**
2. Unpack into `/scratch1/ECHO_linux_nested/lib/zoomsdk/`
3. `cp config.example.toml config.toml` and fill Client ID / Secret / meeting number
4. Tell me the SDK is in place — I will finish Auth/Join and live nested replies

Do not run both bots in the same meeting at once.
