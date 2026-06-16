# Pip & Bruno — AI cartoon pipeline

Original slapstick cartoon series in a vintage 1940s rubber-hose / Technicolor style,
generated with Higgsfield (image + video + audio) and assembled with ffmpeg.

> **Original work.** Pip & Bruno, the stories, music and SFX are all original creations
> for this channel — *inspired by* the classic theatrical-cartoon comedy formula, not
> copied from any existing studio's characters, episodes, music or branding.

## Cast (reusable Higgsfield Elements)
| Character | Element ID | Notes |
|-----------|-----------|-------|
| **Pip**   | `cfc14f47-d281-4423-9410-85f1b61aa7b8` | small, round, calm, innocent protagonist |
| **Bruno** | `f39e2a9e-7084-4940-b377-95f1a295047c` | chunky bulldog, mischievous schemer |

Reference these IDs (as `<<<id>>>` inside an image/video prompt) in every new shot so the
characters stay identical across episodes.

---

## Episode 1 — "Lunchpauze" (~70s, dialogue-free)

Classic 3-act build-up, rule of three (Bruno's schemes all backfire on himself):

1. Pip strolls in with a sandwich and sits to eat
2. Pip takes a blissful bite
3. Bruno spots the sandwich over the fence
4. Bruno tiptoes up with a mallet
5. Pip ducks for a crumb — mallet smashes the empty crate
6. Bruno hops in pain, stars circling
7. Bruno rigs a rope-and-crate trap
8. Pip sniffs a flower — Bruno steps in his own snare
9. The crate slams down onto Bruno
10. Bruno loads a giant catapult
11. The catapult flings Bruno instead of the boulder
12. Bruno smacks flat into the fence
13. Pip notices and offers him half the sandwich
14. They eat together as friends — iris-out

Music: one continuous original cartoon-orchestral bed. SFX: 6 timed cartoon hits.

---

## How to render the finished MP4

The shots/music/SFX live on the Higgsfield CDN. To download + assemble them, this
environment needs network access to that host.

1. On **claude.ai/code** → click the **cloud icon** (environment name) → hover the
   environment → click the **gear** → set **Network access = Full**
   *(or Custom + add `d8j0ntlcm91z4.cloudfront.net`).*
2. **Start a new session** on this repo/branch (the setting only applies to new sessions).
3. Run:
   ```bash
   bash cartoon-pipeline/assemble_episode.sh
   ```
4. Output: **`pip_bruno_lunchpauze.mp4`** (1920×1080, music + synced SFX) — ready to upload.

No editing software needed. ffmpeg is auto-fetched if missing.

---

## Roadmap
- [ ] Render & review Episode 1 final cut
- [ ] Upscale to 4K (Higgsfield `upscale_video`, optional)
- [ ] YouTube auto-upload (YouTube Data API v3 + weekly GitHub Action)
- [ ] Dutch audio variant (swap only the voice track; music/SFX are language-neutral)
- [ ] Episode 2 (reuse the Pip & Bruno Elements above)
