# InstaToolkit 📊

**Instagram utility bot: public profile snapshots + hashtag sets.** Public data only — no login, no scraping of private content.

## Commands

| Command | Result |
|---|---|
| `/profile <handle>` | followers/following/posts, verification, bio, engagement estimate |
| `/tags cafe, business` | balanced hashtag set (40% broad / 40% mid / 20% niche), deterministic |

Free: 5 commands/day · Pro via Telegram Stars.

## Design notes

- Profile reader uses the same public hydration-blob strategy as the ClipGrab
  Instagram resolver; failures are honest ("private or doesn't exist" vs "failed").
- The hashtag engine is **pure and deterministic** (no network): morphology rules +
  static popularity tiers, so results are stable and unit-testable.

Part of [ForgeKit Bots](../../README.md).
