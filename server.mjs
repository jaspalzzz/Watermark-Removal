import { createServer } from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const root = process.cwd();
const publicDir = join(root, "public");
const outputDir = join(root, "outputs");
const tempDir = join(root, ".tmp");
const assetsDir = join(root, "assets");
const port = Number(process.env.PORT || 3100);

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mp4", "video/mp4"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".tiff", "image/tiff"],
  [".svg", "image/svg+xml"]
]);

await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(tempDir, { recursive: true });
await clearTempDir();

// Calibrated watermark profiles. Each carries a per-pixel affine model (gain/offset maps)
// that reverses the watermark's alpha blend instead of destroying the pixels underneath.
const watermarkProfiles = await loadWatermarkProfiles();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "POST" && url.pathname === "/api/process") {
      await handleProcess(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/outputs/")) {
      await sendFile(res, join(root, safePath(url.pathname)));
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
      await sendFile(res, join(root, safePath(url.pathname)));
      return;
    }

    if (req.method === "GET") {
      const requested = url.pathname === "/" ? "/index.html" : url.pathname;
      await sendFile(res, join(publicDir, safePath(requested)));
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Something went wrong while processing the video. Please try again." });
  }
});

server.listen(port, () => {
  console.log(`Watermark removal tool running at http://localhost:${port}`);
});

// Removes leftover job scratch (uploads, masks, partial encodes) from a previous run that
// was killed before its cleanup could finish. The temp dir only ever holds transient files.
async function clearTempDir() {
  try {
    const entries = await fs.readdir(tempDir);
    await Promise.all(entries.map((entry) => fs.rm(join(tempDir, entry), { force: true, recursive: true })));
  } catch (error) {
    console.error("Could not clear temp directory:", error.message);
  }
}

function safePath(pathname) {
  const normalized = normalize(decodeURIComponent(pathname)).replace(/^(\.\.(\/|\\|$))+/, "");
  return normalized.startsWith("/") ? normalized.slice(1) : normalized;
}

async function sendFile(res, filePath) {
  const resolved = resolve(filePath);
  const allowed =
    resolved.startsWith(resolve(publicDir)) ||
    resolved.startsWith(resolve(outputDir)) ||
    resolved.startsWith(resolve(assetsDir));

  if (!allowed) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  let stats;
  try {
    stats = await fs.stat(resolved);
  } catch {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  if (!stats.isFile()) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": mimeTypes.get(extname(resolved).toLowerCase()) || "application/octet-stream",
    "Content-Length": stats.size,
    "Cache-Control": "no-store"
  });
  createReadStream(resolved).pipe(res);
}

async function handleProcess(req, res) {
  const contentType = req.headers["content-type"] || "";
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];

  if (!boundary) {
    sendJson(res, 400, { error: "Expected multipart/form-data upload." });
    return;
  }

  const body = await readRequest(req);
  const parts = parseMultipart(body, boundary);
  const video = parts.find((part) => part.name === "video" && part.filename);
  const regionsPart = parts.find((part) => part.name === "regions");
  const modePart = parts.find((part) => part.name === "mode");
  const matchPart = parts.find((part) => part.name === "match");
  const shapePart = parts.find((part) => part.name === "shape");

  if (!video?.data?.length) {
    sendJson(res, 400, { error: "Upload a video or image first." });
    return;
  }

  let regions;
  try {
    regions = JSON.parse(regionsPart?.data?.toString("utf8") || "[]");
  } catch {
    sendJson(res, 400, { error: "Region data is not valid JSON." });
    return;
  }

  const uploadedRegions = sanitizeRegions(regions);
  if (!uploadedRegions.length) {
    sendJson(res, 400, { error: "Select at least one watermark area." });
    return;
  }

  const inputExt = video.filename && extname(video.filename) ? extname(video.filename).toLowerCase() : ".mp4";
  const jobId = randomUUID();
  const inputPath = join(tempDir, `${jobId}${inputExt}`);
  const maskPath = join(tempDir, `${jobId}-mask.png`);
  const shapePath = join(tempDir, `${jobId}-shape.png`);
  // Named once the probe says whether this is a still or a clip, since the output keeps the
  // input's own format rather than being forced into an MP4.
  let outputName = "";
  let outputPath = "";
  // Written to a temp file and only published to /outputs on success, so an interrupted
  // encode can never leave a half-written file in the outputs folder.
  let partPath = "";

  await fs.writeFile(inputPath, video.data);

  try {
    const mode = modePart?.data?.toString("utf8") || "source";
    const metadata = await probeVideo(inputPath);
    const outputExt = metadata.kind === "image" ? imageExtension(metadata, inputExt) : ".mp4";
    outputName = `${safeBaseName(video.filename || "media")}-clean-${jobId.slice(0, 8)}${outputExt}`;
    outputPath = join(outputDir, outputName);
    partPath = join(tempDir, `${jobId}-out${outputExt}`);

    const cleanRegions = clampRegionsToFrame(uploadedRegions, metadata.width, metadata.height);

    if (!cleanRegions.length) {
      sendJson(res, 422, { error: "The detected watermark area was outside the frame. Please try again." });
      return;
    }

    // A recognised watermark can be un-blended, which restores the detail underneath.
    // Anything else falls back to delogo, which can only interpolate the area away.
    const placement = resolveUnblendPlacement(matchPart, metadata);
    let method = placement ? "unblend" : "delogo";

    // Feather radius scales with the frame so the removal blends on any resolution.
    const feather = clamp(Math.round(Math.min(metadata.width, metadata.height) * 0.012), 4, 14);
    const delogoRegions = expandRegions(cleanRegions, feather + 2, metadata.width, metadata.height);

    try {
      let args;
      if (placement) {
        args = buildUnblendArgs(inputPath, partPath, placement, mode, metadata);
      } else if (await writeShapeMask(shapePart, shapePath, metadata)) {
        // A mask cut to the watermark's own outline beats a rectangle: the reconstruction only
        // has to reach across the glyph's thin arms instead of a whole box of real picture.
        method = "shaped";
        args = buildRemoveLogoArgs(inputPath, shapePath, partPath, mode, metadata);
      } else {
        await buildFeatherMask(maskPath, cleanRegions, feather, metadata);
        args = buildFfmpegArgs(inputPath, maskPath, partPath, delogoRegions, mode, metadata);
      }
      await run("ffmpeg", args);
      await assertRenderedOutput(partPath, metadata);
      await fs.rename(partPath, outputPath);
    } catch (error) {
      console.error("FFmpeg processing failed:", summarizeProcessingError(error.message));
      if (partPath) await fs.rm(partPath, { force: true });
      if (outputPath) await fs.rm(outputPath, { force: true });
      sendJson(res, 422, {
        error: "Could not remove the watermark automatically. Please try again or adjust the selected area."
      });
      return;
    }

    sendJson(res, 200, {
      outputUrl: `/outputs/${outputName}`,
      fileName: outputName,
      regions: placement ? [placement.sparkleRegion] : cleanRegions,
      method,
      quality: describeQuality(metadata, mode, method)
    });
  } finally {
    await fs.rm(inputPath, { force: true });
    await fs.rm(maskPath, { force: true });
    await fs.rm(shapePath, { force: true });
    if (partPath) await fs.rm(partPath, { force: true });
  }
}

// The client reports which calibrated watermark it matched and where. A wrong match would
// stamp an inverted watermark into clean footage, so an unknown profile or a weak match
// score is rejected outright and the job falls back to delogo. Kept in step with the
// client's MATCH_THRESHOLD; the server re-checks because it cannot trust the client.
const MIN_MATCH_SCORE = 0.75;

function resolveUnblendPlacement(matchPart, metadata) {
  if (!matchPart?.data?.length) return null;

  let match;
  try {
    match = JSON.parse(matchPart.data.toString("utf8"));
  } catch {
    return null;
  }

  const profile = watermarkProfiles.get(match?.profile);
  if (!profile) return null;

  // The score gate exists to stop an automatic run from stamping an inverted watermark into
  // clean media. A still cannot reach it (no temporal signal to average), so the UI shows the
  // proposed area and the user confirms it — an explicit choice about their own file.
  if (match.confirmed !== true && (!Number.isFinite(match.score) || match.score < MIN_MATCH_SCORE)) {
    return null;
  }

  const anchor = { x: Number(match.x), y: Number(match.y) };
  if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return null;

  const placement = resolvePlacement(profile, anchor, metadata);
  if (!placement) return null;

  const scale = placement.scale;
  return {
    ...placement,
    profile,
    sparkleRegion: {
      x: Math.round(anchor.x),
      y: Math.round(anchor.y),
      w: Math.round(profile.sparkle.width * scale),
      h: Math.round(profile.sparkle.height * scale)
    }
  };
}

async function loadWatermarkProfiles() {
  const profiles = new Map();

  let entries;
  try {
    entries = await fs.readdir(assetsDir, { withFileTypes: true });
  } catch {
    return profiles;
  }

  for (const entry of entries.filter((item) => item.isDirectory())) {
    const dir = join(assetsDir, entry.name);
    try {
      const profile = JSON.parse(await fs.readFile(join(dir, "profile.json"), "utf8"));
      profiles.set(profile.name, {
        ...profile,
        gainPath: join(dir, "gain.png"),
        offsetPath: join(dir, "offset.png")
      });
    } catch (error) {
      console.error(`Skipping watermark profile in ${entry.name}:`, error.message);
    }
  }

  console.log(`Loaded ${profiles.size} watermark profile(s): ${[...profiles.keys()].join(", ") || "none"}`);
  return profiles;
}

// Reverses the watermark's alpha blend: out = (in - offset) / gain, per pixel, recovering the
// detail underneath instead of interpolating it away.
//
// Only the watermark patch is routed through the RGB maths and composited back onto the
// untouched frame. Running the whole frame through an RGB round-trip would cost ~3dB across
// every pixel just to repair a corner of it.
function buildUnblendArgs(inputPath, outputPath, placement, mode, metadata) {
  const { x, y, width, height, profile } = placement;
  const isImage = metadata.kind === "image";
  // Stills stay in RGB end to end, so the patch never round-trips through 4:2:0 chroma.
  const patchFormat = isImage ? "gbrp" : metadata.pixelFormat || "yuv420p";

  const filterComplex =
    `[1:v]scale=${width}:${height}:flags=bicubic,format=gbrp[offset];` +
    `[2:v]scale=${width}:${height}:flags=bicubic,format=gbrp[gain];` +
    `[0:v]${isImage ? "format=gbrp," : ""}split=2[base][work];` +
    `[work]${isImage ? "" : "format=gbrp,"}crop=${width}:${height}:${x}:${y}[patch];` +
    `[patch][offset]blend=all_expr='max(A-B,0)'[shifted];` +
    `[shifted][gain]blend=all_expr='min(A*255/max(B,1),255)'[clean];` +
    `[clean]format=${patchFormat}[restored];` +
    // overlay defaults to a YUV working format, which would round-trip every pixel of a still
    // through chroma conversion; format=rgb keeps the untouched area bit-identical.
    `[base][restored]overlay=${x}:${y}${isImage ? ":format=rgb" : ""}[out]`;

  return [
    "-hide_banner",
    "-y",
    "-i",
    inputPath,
    "-i",
    profile.offsetPath,
    "-i",
    profile.gainPath,
    "-filter_complex",
    filterComplex,
    "-map",
    "[out]",
    ...outputArgs(mode, metadata),
    outputPath
  ];
}

// Stills are written back as a single frame in their own format; video keeps the audio track
// and the faststart flag it needs for streaming.
function outputArgs(mode, metadata) {
  if (metadata.kind === "image") {
    return ["-frames:v", "1", ...buildImageArgs(metadata)];
  }

  return [
    "-map",
    "0:a?",
    ...buildVideoArgs(mode, metadata),
    "-c:a",
    "copy",
    "-movflags",
    "+faststart"
  ];
}

// Keeps the still in its own format; falls back to the uploaded extension, then PNG.
function imageExtension(metadata, inputExt) {
  const byCodec = { png: ".png", mjpeg: ".jpg", webp: ".webp", bmp: ".bmp", tiff: ".tiff" };
  if (byCodec[metadata.codecName]) return byCodec[metadata.codecName];
  return [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff"].includes(inputExt) ? inputExt : ".png";
}

function buildImageArgs(metadata) {
  // PNG and WebP are written losslessly; JPEG has no lossless mode, so use its top quality.
  if (metadata.codecName === "mjpeg") return ["-q:v", "2", "-pix_fmt", "yuvj444p"];
  if (metadata.codecName === "webp") return ["-lossless", "1"];
  return ["-pix_fmt", "rgb24"];
}

// Maps a detected sparkle position onto the calibrated patch, scaling for resolution.
// Everything is snapped to even pixels: the maps are aligned per-pixel to the watermark, and
// cropping or overlaying at an odd offset in 4:2:0 shifts chroma and wrecks the alignment.
function resolvePlacement(profile, anchor, metadata) {
  const scale = metadata.height / profile.reference.height;
  // Stills stay in RGB, so they can sit on exact pixels; only 4:2:0 video needs even offsets.
  const snap = metadata.kind === "image" ? Math.round : toEven;
  const width = snap(profile.patch.width * scale);
  const height = snap(profile.patch.height * scale);
  const x = snap(anchor.x - profile.anchor.x * scale);
  const y = snap(anchor.y - profile.anchor.y * scale);

  if (width < 8 || height < 8) return null;
  if (x < 0 || y < 0 || x + width > metadata.width || y + height > metadata.height) return null;

  return { x, y, width, height, scale };
}

function toEven(value) {
  return Math.round(value / 2) * 2;
}

// ffmpeg can exit cleanly having written a file that is valid but wrong — a stream-selection
// slip once produced an audio-only MP4 that probed fine. Confirm the render actually contains
// the picture, at the size we asked for, before it is published to /outputs.
async function assertRenderedOutput(filePath, metadata) {
  const payload = await runWithOutput("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    filePath
  ]);

  const streams = JSON.parse(payload).streams || [];
  const rendered = streams.find((stream) => stream.codec_type === "video");
  if (!rendered) {
    throw new Error("output has no video stream");
  }

  if (Number(rendered.width) !== metadata.width || Number(rendered.height) !== metadata.height) {
    throw new Error(
      `output is ${rendered.width}x${rendered.height}, expected ${metadata.width}x${metadata.height}`
    );
  }
}

// The client traces the watermark's outline and uploads it. It drives an ffmpeg filter, so it
// is only trusted once the decoded PNG is confirmed to match the frame exactly.
async function writeShapeMask(shapePart, shapePath, metadata) {
  if (!shapePart?.data?.length) return false;

  await fs.writeFile(shapePath, shapePart.data);
  const size = await probeImageSize(shapePath);
  if (!size || size.width !== metadata.width || size.height !== metadata.height) {
    await fs.rm(shapePath, { force: true });
    return false;
  }

  return true;
}

async function probeImageSize(filePath) {
  try {
    const payload = await runWithOutput("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", filePath]);
    const stream = JSON.parse(payload).streams?.[0];
    return stream ? { width: Number(stream.width), height: Number(stream.height) } : null;
  } catch {
    return null;
  }
}

// removelogo rebuilds each masked pixel by interpolating from the nearest unmasked ones, so a
// mask that hugs the glyph keeps surrounding detail that a bounding box would have discarded.
function buildRemoveLogoArgs(inputPath, shapePath, outputPath, mode, metadata) {
  const outputFormat = metadata.kind === "image" ? "rgb24" : metadata.pixelFormat || "yuv420p";

  return [
    "-hide_banner",
    "-y",
    "-i",
    inputPath,
    "-vf",
    `removelogo=filename=${shapePath},format=${outputFormat}`,
    // The audio map below turns off ffmpeg's automatic stream selection, so the video has to
    // be mapped by hand too. Without this the filtered video is dropped and the file written
    // out with only its audio track.
    ...(metadata.kind === "image" ? [] : ["-map", "0:v:0"]),
    ...outputArgs(mode, metadata),
    outputPath
  ];
}

// Renders a grayscale matte: white over each watermark box, softened outward so the
// reconstructed patch dissolves into the surrounding pixels instead of leaving a rectangle.
async function buildFeatherMask(maskPath, regions, feather, metadata) {
  const boxes = regions
    .map((region) => {
      const box = clampBox(
        { x: region.x - feather, y: region.y - feather, w: region.w + feather * 2, h: region.h + feather * 2 },
        metadata.width,
        metadata.height
      );
      return `drawbox=x=${box.x}:y=${box.y}:w=${box.w}:h=${box.h}:color=white@1.0:t=fill`;
    })
    .join(",");

  const filter = `${boxes},gblur=sigma=${feather},format=gray`;

  await run("ffmpeg", [
    "-hide_banner",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=${metadata.width}x${metadata.height}:d=1`,
    "-vf",
    filter,
    "-frames:v",
    "1",
    maskPath
  ]);
}

function buildFfmpegArgs(inputPath, maskPath, outputPath, regions, mode, metadata) {
  const delogoChain = regions
    .map((region) => `delogo=x=${region.x}:y=${region.y}:w=${region.w}:h=${region.h}:show=0`)
    .join(",");

  // Reconstruct on a copy of the frame, attach the feathered matte as alpha, then blend it
  // back over the untouched original so only the softened watermark area is replaced.
  const outputFormat = metadata.kind === "image" ? "rgb24" : metadata.pixelFormat || "yuv420p";
  const filterComplex =
    `[0:v]split=2[base][work];` +
    `[work]${delogoChain}[clean];` +
    `[clean][1:v]alphamerge[patch];` +
    `[base][patch]overlay=0:0:format=auto,format=${outputFormat}[out]`;

  return [
    "-hide_banner",
    "-y",
    "-i",
    inputPath,
    "-i",
    maskPath,
    "-filter_complex",
    filterComplex,
    "-map",
    "[out]",
    ...outputArgs(mode, metadata),
    outputPath
  ];
}

function buildVideoArgs(mode, metadata) {
  const pixelFormat = metadata.pixelFormat || "yuv420p";

  if (mode === "fast") {
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", pixelFormat];
  }

  // "Match uploaded quality": constant-quality encode at a visually-lossless level rather than
  // capping at the source bitrate (which re-compresses and loses a generation of quality).
  const isHevc = metadata.codecName === "hevc" || metadata.codecName === "h265";
  return isHevc
    ? ["-c:v", "libx265", "-preset", "slow", "-crf", "18", "-pix_fmt", pixelFormat]
    : ["-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", pixelFormat];
}

const imageCodecs = new Set(["png", "mjpeg", "webp", "bmp", "tiff", "gif"]);

async function probeVideo(filePath) {
  const payload = await runWithOutput("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    filePath
  ]);

  const parsed = JSON.parse(payload);
  const stream = parsed.streams?.find((item) => item.codec_type === "video") || {};
  const codecName = stream.codec_name || "";
  // A still has no meaningful duration and decodes as an image codec. Images skip 4:2:0
  // entirely, so they avoid both the chroma subsampling loss and the even-pixel constraint.
  const isImage = imageCodecs.has(codecName) && !(Number(parsed.format?.duration) > 0.2);

  return {
    kind: isImage ? "image" : "video",
    codecName,
    width: Number(stream.width || 0),
    height: Number(stream.height || 0),
    pixelFormat: normalizePixelFormat(stream.pix_fmt)
  };
}

function normalizePixelFormat(pixelFormat) {
  const supported = new Set(["yuv420p", "yuv422p", "yuv444p", "yuv420p10le"]);
  return supported.has(pixelFormat) ? pixelFormat : "yuv420p";
}

function describeQuality(metadata, mode, method) {
  const removals = {
    unblend: "watermark un-blended from a calibrated profile, detail underneath restored",
    shaped: "watermark traced and rebuilt from its own outline",
    delogo: "watermark interpolated away with feathered edges"
  };
  const removal = removals[method] || removals.delogo;

  if (metadata.kind === "image") {
    const lossless = metadata.codecName !== "mjpeg";
    return `${removal}; ${lossless ? "lossless" : "high-quality JPEG"} still`;
  }

  if (mode === "fast") {
    return `${removal}; fast export`;
  }

  const codec = metadata.codecName === "hevc" || metadata.codecName === "h265" ? "HEVC" : "H.264";
  return `${removal}; visually-lossless ${codec}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function expandRegions(regions, amount, width, height) {
  return regions.map((region) =>
    clampBox(
      { x: region.x - amount, y: region.y - amount, w: region.w + amount * 2, h: region.h + amount * 2 },
      width,
      height
    )
  );
}

// delogo requires the box to sit strictly inside the frame (a 1px border on every side).
function clampBox(box, width, height) {
  const w = Math.min(Math.max(8, Math.round(box.w)), width - 2);
  const h = Math.min(Math.max(8, Math.round(box.h)), height - 2);
  const x = Math.min(Math.max(1, Math.round(box.x)), width - w - 1);
  const y = Math.min(Math.max(1, Math.round(box.y)), height - h - 1);
  return { x, y, w, h };
}

function sanitizeRegions(regions) {
  if (!Array.isArray(regions)) return [];

  return regions
    .map((region) => ({
      x: Math.max(0, Math.round(Number(region.x))),
      y: Math.max(0, Math.round(Number(region.y))),
      w: Math.max(8, Math.round(Number(region.w))),
      h: Math.max(8, Math.round(Number(region.h)))
    }))
    .filter((region) =>
      Number.isFinite(region.x) &&
      Number.isFinite(region.y) &&
      Number.isFinite(region.w) &&
      Number.isFinite(region.h)
    );
}

function clampRegionsToFrame(regions, width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 16 || height < 16) return [];

  return regions
    .map((region) => {
      const w = Math.min(Math.max(8, region.w), width - 2);
      const h = Math.min(Math.max(8, region.h), height - 2);
      const x = Math.min(Math.max(1, region.x), width - w - 1);
      const y = Math.min(Math.max(1, region.y), height - h - 1);

      return {
        x: Math.round(x),
        y: Math.round(y),
        w: Math.round(w),
        h: Math.round(h)
      };
    })
    .filter((region) => region.w >= 8 && region.h >= 8);
}

function summarizeProcessingError(message) {
  if (/Logo area is outside of the frame/i.test(message)) {
    return "watermark area outside frame";
  }

  if (/Conversion failed/i.test(message)) {
    return "video conversion failed";
  }

  return String(message || "unknown error").split("\n").at(-1)?.trim() || "unknown error";
}

function safeBaseName(name) {
  const withoutExt = String(name).replace(/\.[^.]+$/, "");
  return withoutExt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "video";
}

function readRequest(req) {
  return new Promise((resolveRead, rejectRead) => {
    const chunks = [];
    let total = 0;
    const maxBytes = 1024 * 1024 * 1024;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        rejectRead(new Error("Uploaded video is larger than 1GB."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveRead(Buffer.concat(chunks)));
    req.on("error", rejectRead);
  });
}

function parseMultipart(buffer, boundary) {
  const boundaryText = `--${boundary}`;
  const binary = buffer.toString("binary");
  const chunks = binary.split(boundaryText).slice(1, -1);

  return chunks.map((chunk) => {
    const trimmed = chunk.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const separatorIndex = trimmed.indexOf("\r\n\r\n");
    const headerText = trimmed.slice(0, separatorIndex);
    const contentBinary = trimmed.slice(separatorIndex + 4);
    const disposition = headerText.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || "";
    const name = disposition.match(/name="([^"]+)"/)?.[1] || "";
    const filename = disposition.match(/filename="([^"]*)"/)?.[1] || "";

    return {
      name,
      filename,
      data: Buffer.from(contentBinary, "binary")
    };
  });
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: root });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", rejectRun);
    child.on("close", (code) => {
      if (code === 0) {
        resolveRun();
      } else {
        rejectRun(new Error(stderr.trim() || `${command} exited with code ${code}`));
      }
    });
  });
}

function runWithOutput(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: root });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", rejectRun);
    child.on("close", (code) => {
      if (code === 0) {
        resolveRun(stdout);
      } else {
        rejectRun(new Error(stderr.trim() || `${command} exited with code ${code}`));
      }
    });
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}
