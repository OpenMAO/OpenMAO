# OpenMAO Brand

A short, public brand reference so contributors and the community can represent
OpenMAO consistently — in talks, posts, slides, and the product UI. It is a guide,
not marketing collateral.

The look is **infrastructure you can audit**: calm, flat, green-tinged neutrals, one
accent, a monospace voice for anything machine-addressable. The only saturated color
in the whole system is the flywheel mark.

## Logo & mark

| Asset | File | Use |
| --- | --- | --- |
| Full lockup | [`../assets/openmao-logo.png`](../assets/openmao-logo.png) | Mark + wordmark on light backgrounds. |
| Flywheel mark | [`../assets/openmao-mark-transparent.png`](../assets/openmao-mark-transparent.png) | Transparent mark for dark surfaces, favicons, loaders, empty states. |

- The flywheel mark is the **one rich graphic** — use it as logo, favicon, and loading
  motif. Don't recolor it, rotate the hues, or rebuild it in flat brand colors.
- Give the mark clear space; don't crowd it with text or other marks.
- Don't stretch, add shadows/glows, or place the mark on a busy background.

## Color

The single brand accent is a deep teal-green. Neutrals are subtly green-tinged
(not pure grey). Danger is a muted brick, never a bright alarm red. Light and dark
are both first-class. (These tokens are lifted from the operator console in
`ts/src/api/server.ts`.)

| Token | Light | Dark |
| --- | --- | --- |
| Accent (primary / approved / links) | `#0c6b58` | `#2fa98a` |
| Ink (text) | `#16201d` | `#eef2f0` |
| Surface | `#f6f8f7` | `#131b19` |
| Hairline | `#d8e0dc` | `#25302c` |
| Danger | `#9f2f2f` | `#df6f6b` |
| Terminal / log block (both themes) | `#101716` | `#101716` |

Governance states carry brand weight: `neutral` (idle/queued), `info` (running),
`pending`/amber (awaiting approval), `success`/green (approved, done), `danger`/brick
(blocked, rejected). Status is shown as a small pill with a color dot.

**The flywheel palette** (blue → indigo → violet → magenta → pink → orange) appears
**only** in the logo mark. Never use it for UI chrome, buttons, or backgrounds — that
reads as the generic "AI gradient" the brand deliberately avoids.

## Type

- **IBM Plex Sans** — UI and body text.
- **IBM Plex Mono** — code, IDs, field labels, table headers, and eyebrow kickers
  (uppercase, letter-spaced). Plex reads engineered and institutional, and the mono
  is ideal for the canonical IDs OpenMAO surfaces everywhere (`run_99999…`).

## Voice

Confident, plain, restrained. Earns authority through clarity, not adjectives. The
signature move is the contrarian thesis, often as a standalone line:

> Most autonomous-company demos hand a swarm of agents the keys and hope for the best.
> OpenMAO takes the opposite bet: **autonomy is earned, not assumed.**

- Sentence case for headings and body. Title Case only for canonical nouns
  (World Model, Work Item, Autonomy Dial, Approvals). Code identifiers verbatim.
- Concrete, operational verbs: govern, bound, enforce, approve, promote, audit,
  ratify, widen, earn, record, resume, replay. Avoid "empower", "revolutionize",
  "supercharge", "magic", "effortless".
- Plain punctuation. ASCII arrows (`->`, `<-`) and box diagrams are idiomatic.
- **No emoji** — not in product, docs, or marketing.

## Don't

- No gradients, glows, texture, or imagery behind text.
- No recoloring or rebuilding the flywheel mark; no flywheel palette in UI chrome.
- No emoji; no hype adjectives; no bright alarm-red.

---

*Questions or want to use the brand for something? Open a
[Discussion](https://github.com/aeonbilal/OpenMAO/discussions).*
