# Design notes

All code in this repository is original. It only calls the public, documented-by-community
Spicetify APIs (`Spicetify.Platform.PlayerAPI`, `PlaylistAPI`, `Player`, `LocalStorage`,
`Playbar`, `Menu`, `PopupModal`). Nothing from the Spotify client is copied or redistributed.

## What it does

It keeps the queue at two upcoming tracks of one chosen playlist and picks them by learned
score instead of uniformly at random. Everything is local (browser `localStorage` inside the
client); there is no network code and no telemetry.

## Learning signal

| What you do | How it is read |
|---|---|
| Listen to the end (>= 93%) | positive |
| Skip in the first 30 s | strong negative |
| Skip before 50% | mild negative |
| Skip after 50% | mild positive |
| Replay / pick manually | temporary "hype" bonus that cools off (~5 day half-life) |
| Heart button | strong positive (+5) |

Three or more skips in the last five plays are treated as a bad mood and weigh much less.

## Selection

- Each track has a Beta(a, b) belief about "how much I like it" (prior Beta(2,2); new tracks Beta(3,2)).
- Thompson sampling: draw theta from each Beta, then rank the draws among eligible tracks (0 = worst, 1 = best) and pick proportionally to `rank^k * (1 + hype)`. Only the order matters, never the absolute level, so a listener who skips a lot does not push every score towards the bottom.
- `k` is the aggressiveness (4 gentle, 12 default, 20 radical).
- Counts decay slowly towards the prior (half-life 120 days) because taste drifts.
- Safety nets: 5% uniform picks, a 30-play anti-repeat gap, forced revival of anything unplayed
  for 60 days, and a probation period so new tracks get a fair chance.

## Offline simulation (`sim/`)

A synthetic listener (365 tracks, 100 added mid-run, bad-mood sessions, occasional replays)
compares strategies. Average over 5 seeds, share of plays from the listener's true top 30%:

| Strategy | Top 30% share | Skip rate |
|---|---|---|
| Random shuffle | 0.30 | 0.54 |
| Always best score (greedy) | 0.82 | 0.32, but plays only a quarter of the playlist |
| Smart (default, k=12) | ~0.56 | 0.43 |

The synthetic listener is an assumption of mine, so real numbers will differ. Run
`python sim/sim.py` (needs numpy) to reproduce, `node extension/test.js` for the unit tests.

## Known limits

- Picks are made two tracks ahead, so a skip only influences the third track onwards.
- Notes are global per track (not per playlist): a song you skip in any playlist loses score everywhere. Queue control and the ranking view only cover the chosen playlist.
- LocalStorage is flushed to disk with a delay: use "export backup" now and then, and wait a
  few seconds before closing the client after a long session.
