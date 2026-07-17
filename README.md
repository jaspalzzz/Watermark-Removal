# Watermark Removal

A local browser tool that removes the Google Veo / Gemini sparkle watermark from video by **reversing the watermark's blend** rather than smearing over it — so the detail underneath is restored instead of destroyed.

Node + FFmpeg only. No ML model, no cloud service, no upload: the video never leaves your machine.

## Why not just use `delogo`?

FFmpeg's `delogo` filter throws away everything inside a box and interpolates inward from the edges. Over blurry background that looks fine. Over texture — fur, faces, wood grain — there is nothing to interpolate *from*, so you get a smeared rectangle.

It is worse than it sounds. Measured over detailed content against a clean reference, **every** interpolation method scores *worse than leaving the watermark on*:

| Method | PSNR vs. original |
| --- | --- |
| Leave the watermark alone | **19.53 dB** |
| FFmpeg `delogo` | 16.90 dB |
| OpenCV Telea inpaint | 16.96 dB |
| OpenCV NS inpaint | 16.65 dB |

Spatial reconstruction cannot invent texture that was never recorded. This is a ceiling, not a tuning problem — which is why this tool does something else.

## How it works

The Veo sparkle is **semi-transparent** (white, ~26% mean alpha peaking at 38%) and always in the same place. So the pixels underneath are not gone — they are still there, blended. That blend is invertible:

```
observed = (1 - alpha) * original + alpha * colour     ->     original = (observed - offset) / gain
```

`assets/veo-sparkle/` ships a per-pixel affine model (`gain` = 1 - alpha, `offset` = alpha * colour) solved by regressing watermarked frames against clean ones. Applying it in FFmpeg recovers the real picture:

| | PSNR over the watermark |
| --- | --- |
| Watermarked (untouched) | 12.98 dB |
| `delogo` | ~21.9 dB |
| **Un-blend** | **27.58 dB** |
| Ceiling (source's own compression) | 39.31 dB |

The remaining gap to the ceiling is the source's existing compression noise, amplified by `1/(1 - alpha)`. It is not recoverable.

### Detection

Template matching (normalised cross-correlation) against the profile's alpha matte, scored on a **multi-frame average**. This matters: the watermark is pinned to the frame while the scene moves, so averaging makes it survive while the content washes out.

| | Match score |
| --- | --- |
| Single frame | 0.51, and 20px off |
| 12-frame average | **0.98**, pixel-accurate |
| Same clip with no watermark | 0.54 |

The threshold sits at **0.75**, deliberately inside that gap. A false positive would stamp an *inverted* watermark into clean footage, so the server re-checks the score rather than trusting the browser.

Anything not confidently matched falls back to `delogo` with a feathered mask over the detected area, which the user can correct by hand.

## Requirements

- Node.js 20+
- `ffmpeg` and `ffprobe` on your `PATH`

## Usage

```bash
npm start                 # http://localhost:3100
PORT=8080 npm start       # or pick a port
```

Drop a video on the page. Detection and removal run automatically; the result lands in `outputs/`. If the watermark is not recognised, drag a box over it yourself.

**Output** — `Match uploaded quality` encodes at constant quality (CRF 16 H.264 / 18 HEVC), preserving the source pixel format and stream-copying audio. `Faster export` trades a little quality for speed.

## Adding a watermark profile

A profile lives in `assets/<name>/`:

| File | Contents |
| --- | --- |
| `gain.png` | `(1 - alpha) * 255`, per pixel |
| `offset.png` | `alpha * colour`, per pixel |
| `template.png` | alpha matte, greyscale — used for detection |
| `profile.json` | reference resolution, patch size, watermark box, anchor |

Solve `A = k*B + beta` per pixel by regressing watermarked frames (`A`) against clean ones (`B`) across the whole clip; then `alpha = 1 - k`. Fit `k` and `beta` **directly** — do not assume the colour is pure white. Assuming white produced an impossible colour value (289 on a 0–255 scale) and cost ~6 dB.

Two rules that break quality silently, with no error:

- **Snap the patch origin *and* size to even pixels.** A 1px misalignment between the maps and the crop costs **8 dB** (31 → 23). 4:2:0 chroma cannot be cropped or overlaid at an odd offset.
- **Only route the watermark patch through the RGB maths, then composite it back.** Sending the whole frame through an RGB round-trip costs ~3 dB on *every* pixel to repair one corner. Patch-only is free (27.59 vs 27.62 dB in the region) and leaves the rest of the frame at re-encode quality (45.91 dB).

Verify with PSNR **over the watermark pixels only**, and separately confirm the rest of the frame still matches a plain re-encode.

## Limitations

- **One calibrated watermark**: the Veo/Gemini sparkle at 9:16. Other marks or aspect ratios are rejected and fall back to `delogo`.
- **A blind, template-free detector was built and removed on purpose.** It fired on video containing no watermark at all, and blind un-blending made output *worse* than doing nothing (12.1 vs 16.2 dB). Estimating alpha needs the background variance *underneath* the mark, which is unobservable, and a static scene object produces the same signature as a semi-transparent watermark. Do not re-attempt it without new evidence.
- A faint outline can remain on flat, dark areas.

## Responsible use

This removes a **visual** watermark from video you generated yourself. It does not change whether the video is AI-generated, and it cannot:

- **SynthID** is embedded in the pixel values of every frame at generation time and survives cropping, compression, transcoding, and filtering. It is untouched by this tool and still present in the output.
- **C2PA Content Credentials** live in container metadata and are typically lost in any re-encode — including this one — which changes nothing, since SynthID persists.
- **YouTube** runs its own detection for photorealistic AI use and requires creators to disclose realistic synthetic content. Non-disclosure risks label enforcement, removal, or YPP suspension.

Use it for cosmetic cleanup of your own footage, and disclose AI-generated content where platforms require it. Stripping provenance signals is out of scope for this project.
