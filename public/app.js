const videoInput = document.querySelector("#videoInput");
const dropZone = document.querySelector("#dropZone");
const stage = document.querySelector("#stage");
const video = document.querySelector("#video");
const image = document.querySelector("#image");
const overlay = document.querySelector("#overlay");
const ctx = overlay.getContext("2d");
const detectButton = document.querySelector("#detectButton");
const mode = document.querySelector("#mode");
const regionList = document.querySelector("#regionList");
const clearRegions = document.querySelector("#clearRegions");
const processButton = document.querySelector("#processButton");
const statusBox = document.querySelector("#status");
const downloadLink = document.querySelector("#downloadLink");
const jobCard = document.querySelector("#jobCard");
const jobLabel = document.querySelector("#jobLabel");
const jobPercent = document.querySelector("#jobPercent");
const progressBar = document.querySelector("#progressBar");
const jobSteps = [...document.querySelectorAll(".job-steps li")];

let selectedFile = null;
let regions = [];
let draft = null;
let dragStart = null;
let isProcessing = false;
let autoProcessStarted = false;
let firstFrameHandled = false;
let progressTimer = null;
let watermarkMatch = null;
let mediaKind = "video";

// The stage holds a <video> or an <img>; everything downstream works off these accessors so
// the overlay, region maths and detection do not care which one is loaded.
function activeMedia() {
  return mediaKind === "image" ? image : video;
}

function mediaWidth() {
  return mediaKind === "image" ? image.naturalWidth : video.videoWidth;
}

function mediaHeight() {
  return mediaKind === "image" ? image.naturalHeight : video.videoHeight;
}

function mediaReady() {
  return mediaKind === "image" ? image.complete && image.naturalWidth > 0 : video.readyState >= 2;
}

// Calibrated watermark profile (Veo/Gemini sparkle). When the uploaded video matches it we can
// reverse the watermark's blend instead of interpolating the area away, which preserves detail.
//
// Measured scores: a watermarked clip lands at ~0.94, the same clip without the watermark at
// ~0.54. The threshold sits in that gap — a false positive would stamp an inverted sparkle
// into clean footage, so it is deliberately far above the unwatermarked score.
const MATCH_THRESHOLD = 0.75;
const profilePromise = loadWatermarkProfile();

async function loadWatermarkProfile() {
  try {
    const profile = await (await fetch("/assets/veo-sparkle/profile.json")).json();
    const bitmap = await createImageBitmap(await (await fetch("/assets/veo-sparkle/template.png")).blob());
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const template = new Float32Array(bitmap.width * bitmap.height);
    for (let i = 0; i < template.length; i += 1) template[i] = data[i * 4] / 255;
    return { ...profile, template, templateWidth: bitmap.width, templateHeight: bitmap.height };
  } catch (error) {
    console.warn("Watermark profile unavailable, falling back to generic detection.", error);
    return null;
  }
}

videoInput.addEventListener("change", () => {
  if (videoInput.files?.[0]) {
    loadVideo(videoInput.files[0]);
  }
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("is-dragging");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("is-dragging");
});

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  event.stopPropagation();
  dropZone.classList.remove("is-dragging");
  handleDroppedFiles(event.dataTransfer.files);
});

document.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("is-dragging");
});

document.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("is-dragging");
  handleDroppedFiles(event.dataTransfer.files);
});

video.addEventListener("loadedmetadata", () => {
  video.pause();
  video.currentTime = 0;
  stage.classList.remove("is-empty");
  fitOverlay();
  setProgress(18, "Reading video", "detect");
  setStatus(`${Math.round(mediaWidth())} x ${Math.round(mediaHeight())} loaded. Detecting watermark...`);
  handleFirstFrame();
});

video.addEventListener("loadeddata", () => {
  video.pause();
  handleFirstFrame();
});

video.addEventListener("canplay", handleFirstFrame);
video.addEventListener("seeked", handleFirstFrame);

video.addEventListener("resize", fitOverlay);
window.addEventListener("resize", fitOverlay);

overlay.addEventListener("pointerdown", (event) => {
  if (!selectedFile || isProcessing) return;
  overlay.setPointerCapture(event.pointerId);
  dragStart = pointerToMediaPoint(event);
  draft = null;
});

overlay.addEventListener("pointermove", (event) => {
  if (!dragStart) return;
  const current = pointerToMediaPoint(event);
  draft = rectFromPoints(dragStart, current);
  drawOverlay();
});

overlay.addEventListener("pointerup", (event) => {
  if (!dragStart) return;
  const current = pointerToMediaPoint(event);
  const region = rectFromPoints(dragStart, current);
  dragStart = null;
  draft = null;

  if (region.w >= 8 && region.h >= 8) {
    // A hand-drawn area is not the detected watermark, so process exactly what was asked for.
    watermarkMatch = null;
    regions.push(region);
    updateUi();
  } else {
    drawOverlay();
  }
});

detectButton.addEventListener("click", () => {
  if (!selectedFile || !mediaWidth() || !mediaHeight()) {
    setStatus("Load a video or image before detection.", true);
    return;
  }

  autoDetectWatermark(true);
});

clearRegions.addEventListener("click", () => {
  regions = [];
  watermarkMatch = null;
  updateUi();
});

processButton.addEventListener("click", async () => {
  await processVideo();
});

function loadVideo(file) {
  const isVideo = file.type.startsWith("video/");
  const isImage = file.type.startsWith("image/");
  if (!isVideo && !isImage) {
    setStatus("Drop a video or image file.", true);
    return;
  }

  mediaKind = isImage ? "image" : "video";
  selectedFile = file;
  regions = [];
  isProcessing = false;
  autoProcessStarted = false;
  firstFrameHandled = false;
  watermarkMatch = null;
  stopProgressTimer();
  downloadLink.hidden = true;
  detectButton.disabled = true;
  processButton.textContent = isImage ? "Remove watermark" : "Process again";
  video.hidden = isImage;
  image.hidden = !isImage;

  if (isImage) {
    video.pause();
    video.removeAttribute("src");
    image.src = URL.createObjectURL(file);
  } else {
    image.removeAttribute("src");
    video.autoplay = false;
    video.pause();
    video.src = URL.createObjectURL(file);
    video.load();
  }

  stage.classList.remove("is-empty");
  dropZone.classList.add("has-file");
  setProgress(8, `Loaded ${formatBytes(file.size)}`, "upload");
  setStatus(isImage ? "Reading image..." : "Preparing automatic removal...");
  updateUi();
}

image.addEventListener("load", () => {
  if (mediaKind !== "image") return;
  stage.classList.remove("is-empty");
  fitOverlay();
  setProgress(18, "Reading image", "detect");
  setStatus(`${mediaWidth()} x ${mediaHeight()} loaded. Looking for a watermark...`);
  void handleImageLoaded();
});

// A still has no temporal signal, so the match cannot reach the confidence a clip does
// (measured 0.55 against the 0.75 auto threshold) even when it lands on the right pixel.
// The position is still trustworthy, so the box is proposed and the user confirms it rather
// than the removal running by itself.
const IMAGE_SUGGEST_THRESHOLD = 0.35;

async function handleImageLoaded() {
  const profile = await profilePromise;
  const frame = readImageLuma();
  const suggestion = matchWatermarkProfile(profile, frame, IMAGE_SUGGEST_THRESHOLD);

  if (suggestion) {
    // Confirmed by the user rather than by score, so the server allows the un-blend through.
    watermarkMatch = { ...suggestion, confirmed: true };
    regions = [{ x: suggestion.x, y: suggestion.y, w: suggestion.w, h: suggestion.h }];
    updateUi();
    setProgress(30, "Check the area", "detect");
    setStatus("Found a likely Veo sparkle (highlighted). Press Remove watermark to confirm, or drag your own box.");
    return;
  }

  autoDetectWatermark();
  setStatus("No known watermark found. Drag a box over the watermark, then press Remove watermark.");
}

function readImageLuma() {
  const width = mediaWidth();
  const height = mediaHeight();
  if (!width || !height) return null;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, width, height);
  const luma = new Float32Array(width * height);
  for (let p = 0; p < luma.length; p += 1) {
    const o = p * 4;
    luma[p] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  }
  return { luma, width, height };
}

function fitOverlay() {
  const rect = activeMedia().getBoundingClientRect();
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
  overlay.width = Math.max(1, Math.round(rect.width * window.devicePixelRatio));
  overlay.height = Math.max(1, Math.round(rect.height * window.devicePixelRatio));
  drawOverlay();
}

function pointerToMediaPoint(event) {
  const rect = overlay.getBoundingClientRect();
  const scaleX = mediaWidth() / rect.width;
  const scaleY = mediaHeight() / rect.height;
  return {
    x: clamp((event.clientX - rect.left) * scaleX, 0, mediaWidth()),
    y: clamp((event.clientY - rect.top) * scaleY, 0, mediaHeight())
  };
}

function rectFromPoints(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(Math.abs(a.x - b.x)),
    h: Math.round(Math.abs(a.y - b.y))
  };
}

function drawOverlay() {
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  ctx.save();
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

  for (const region of regions) {
    drawRegion(region, "rgba(63, 182, 168, 0.25)", "#3fb6a8");
  }

  if (draft) {
    drawRegion(draft, "rgba(240, 184, 75, 0.25)", "#f0b84b");
  }

  ctx.restore();
}

function drawRegion(region, fill, stroke) {
  const rect = activeMedia().getBoundingClientRect();
  const scaleX = rect.width / mediaWidth();
  const scaleY = rect.height / mediaHeight();
  const x = region.x * scaleX;
  const y = region.y * scaleY;
  const w = region.w * scaleX;
  const h = region.h * scaleY;

  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
}

function updateUi() {
  processButton.disabled = isProcessing || !selectedFile || !regions.length;
  detectButton.disabled = isProcessing || !selectedFile;
  clearRegions.disabled = isProcessing;
  mode.disabled = isProcessing;
  renderRegions();
  drawOverlay();
}

function renderRegions() {
  regionList.innerHTML = "";

  if (!regions.length) {
    const empty = document.createElement("div");
    empty.className = "region-empty";
    empty.textContent = "Automatic detection runs after upload.";
    regionList.append(empty);
    return;
  }

  regions.forEach((region, index) => {
    const item = document.createElement("li");
    const code = document.createElement("code");
    const remove = document.createElement("button");

    code.textContent = `x:${region.x} y:${region.y} w:${region.w} h:${region.h}`;
    remove.type = "button";
    remove.textContent = "Remove";
    remove.disabled = isProcessing;
    remove.addEventListener("click", () => {
      regions.splice(index, 1);
      updateUi();
    });

    item.append(code, remove);
    regionList.append(item);
  });
}

function setStatus(message, isError = false) {
  statusBox.textContent = message;
  statusBox.classList.toggle("error", isError);
  jobCard.classList.toggle("has-error", isError);
}

function startAutoProcess() {
  if (autoProcessStarted || isProcessing || !selectedFile || !regions.length) return;

  autoProcessStarted = true;
  setProgress(28, "Watermark detected", "detect");
  setStatus("Watermark area detected. Starting removal...");
  void processVideo();
}

async function processVideo() {
  if (!selectedFile || !regions.length || isProcessing) return;

  isProcessing = true;
  processButton.textContent = "Processing...";
  updateUi();
  downloadLink.hidden = true;
  if (mediaKind === "video") video.pause();
  setProgress(32, "Uploading video", "upload");
  setStatus("Removing watermark with FFmpeg...");

  const formData = new FormData();
  formData.append("video", selectedFile);
  formData.append("regions", JSON.stringify(regions));
  formData.append("mode", mode.value);

  if (watermarkMatch) {
    formData.append("match", JSON.stringify(watermarkMatch));
  }

  try {
    const payload = await uploadAndProcess(formData);

    downloadLink.href = payload.outputUrl;
    downloadLink.download = payload.fileName;
    downloadLink.hidden = false;
    setProgress(100, "Clean video ready", "done");
    setStatus(`Done. ${payload.quality || "Output is ready."}`);
  } catch (error) {
    autoProcessStarted = false;
    stopProgressTimer();
    setStatus(error.message, true);
  } finally {
    stopProgressTimer();
    isProcessing = false;
    processButton.textContent = "Process again";
    updateUi();
  }
}

function autoDetectWatermark(replaceExisting = false) {
  if (!selectedFile || !mediaWidth() || !mediaHeight() || !mediaReady()) return;

  const detected = detectLikelyWatermarkRegion();
  if (replaceExisting) regions = [];

  if (detected) {
    regions = replaceExisting || !regions.length ? [detected] : mergeRegions(regions, detected);
    updateUi();
    setProgress(26, "Watermark detected", "detect");
    setStatus(`Detected likely watermark area at x:${detected.x} y:${detected.y}.`);
    return;
  }

  const fallback = getCommonWatermarkRegion(mediaWidth(), mediaHeight());
  regions = replaceExisting || !regions.length ? [fallback] : regions;
  updateUi();
  setProgress(24, "Watermark area selected", "detect");
  setStatus("Auto detection used the common lower-right watermark area.");
}

async function handleFirstFrame() {
  if (mediaKind !== "video") return;
  if (firstFrameHandled || !selectedFile || video.readyState < 2 || !mediaWidth() || !mediaHeight()) return;

  firstFrameHandled = true;
  video.pause();
  fitOverlay();
  setProgress(14, "Analysing frames", "detect");
  setStatus("Analysing frames to locate the watermark...");

  watermarkMatch = null;

  const [profile, frame] = [await profilePromise, await buildAverageLuma()];

  // 1. A calibrated profile is the most accurate reconstruction, so try it first.
  watermarkMatch = matchWatermarkProfile(profile, frame);
  if (watermarkMatch) {
    regions = [{ x: watermarkMatch.x, y: watermarkMatch.y, w: watermarkMatch.w, h: watermarkMatch.h }];
    updateUi();
    setProgress(26, "Watermark identified", "detect");
    setStatus(`Veo sparkle identified (${Math.round(watermarkMatch.score * 100)}% match). Un-blending it keeps the detail underneath.`);
    startAutoProcess();
    return;
  }

  // 2. Not a watermark we have calibrated: fall back to a coarse guess and tell the user
  // plainly, so they can drag the box themselves rather than trust a bad automatic one.
  autoDetectWatermark();
  setStatus("No known watermark found. Check the highlighted area and drag your own box if it is wrong.");
  startAutoProcess();
}

function handleDroppedFiles(fileList) {
  const file = [...fileList].find((item) => item.type.startsWith("video/") || item.type.startsWith("image/"));
  if (file) {
    loadVideo(file);
  } else {
    setStatus("Drop a video or image file.", true);
  }
}

function uploadAndProcess(formData) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();

    request.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      const uploadProgress = Math.round((event.loaded / event.total) * 32);
      setProgress(Math.max(32, Math.min(60, 32 + uploadProgress)), "Uploading video", "upload");
    });

    request.upload.addEventListener("loadend", () => {
      setProgress(62, "Starting FFmpeg", "process");
      startProcessingProgress();
    });

    request.addEventListener("load", () => {
      let payload;
      try {
        payload = JSON.parse(request.responseText || "{}");
      } catch {
        reject(new Error("Processing returned an invalid response."));
        return;
      }

      if (request.status >= 200 && request.status < 300) {
        resolve(payload);
      } else {
        reject(new Error(payload.error || "Processing failed."));
      }
    });

    request.addEventListener("error", () => reject(new Error("Network error while processing video.")));
    request.addEventListener("abort", () => reject(new Error("Processing was cancelled.")));

    request.open("POST", "/api/process");
    request.send(formData);
  });
}

function startProcessingProgress() {
  stopProgressTimer();
  progressTimer = window.setInterval(() => {
    const current = Number(progressBar.dataset.value || 0);
    if (current < 62) {
      setProgress(62, "Starting FFmpeg", "process");
      return;
    }
    if (current < 94) {
      setProgress(current + Math.max(1, Math.round((94 - current) * 0.08)), "Removing watermark", "process");
    }
  }, 700);
}

function stopProgressTimer() {
  if (progressTimer) {
    window.clearInterval(progressTimer);
    progressTimer = null;
  }
}

function setProgress(value, label, activeStep) {
  const progress = Math.max(0, Math.min(100, Math.round(value)));
  progressBar.style.width = `${progress}%`;
  progressBar.dataset.value = String(progress);
  jobPercent.textContent = `${progress}%`;
  jobLabel.textContent = label;
  jobCard.classList.toggle("is-active", progress > 0 && progress < 100);

  const stepOrder = ["upload", "detect", "process", "done"];
  const activeIndex = stepOrder.indexOf(activeStep);
  jobSteps.forEach((step) => {
    const index = stepOrder.indexOf(step.dataset.step);
    step.classList.toggle("is-active", step.dataset.step === activeStep);
    step.classList.toggle("is-complete", activeIndex > index || progress === 100);
  });
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Averages luma across frames spread over the clip. The watermark is pinned to the frame while
// the scene moves, so it survives the average while the content washes out — that lifts the
// match score from ~0.5 (unreliable, and 20px off) to ~0.94 with pixel-accurate placement.
const MATCH_SAMPLES = 12;

async function buildAverageLuma() {
  const width = mediaWidth();
  const height = mediaHeight();
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  // Without a duration there is nothing to spread samples across, and a single frame is not
  // enough to match on: it scored 0.51 and landed 20px off the watermark while testing.
  if (!duration) return null;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const luma = new Float32Array(width * height);
  const restoreTo = video.currentTime;
  let samples = 0;

  // Sample midpoints rather than i/N: the first slot would otherwise land on 0s, where seeking
  // to the position the video already holds may never fire "seeked".
  for (let i = 0; i < MATCH_SAMPLES; i += 1) {
    if (!(await seekTo(duration * ((i + 0.5) / MATCH_SAMPLES)))) continue;

    context.drawImage(video, 0, 0);
    const { data } = context.getImageData(0, 0, width, height);
    for (let p = 0; p < luma.length; p += 1) {
      const o = p * 4;
      luma[p] += 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    }
    samples += 1;
  }

  await seekTo(restoreTo);
  if (samples < 2) return null;
  for (let p = 0; p < luma.length; p += 1) luma[p] /= samples;
  return { luma, width, height };
}

function seekTo(time) {
  return new Promise((resolveSeek) => {
    if (!Number.isFinite(time)) {
      resolveSeek(false);
      return;
    }

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const target = duration ? clamp(time, 0, Math.max(0, duration - 0.05)) : time;
    if (Math.abs(video.currentTime - target) < 0.025 && video.readyState >= 2) {
      resolveSeek(true);
      return;
    }

    const done = () => {
      video.removeEventListener("seeked", done);
      window.clearTimeout(timer);
      resolveSeek(true);
    };
    const timer = window.setTimeout(() => {
      video.removeEventListener("seeked", done);
      resolveSeek(false);
    }, 2000);
    video.addEventListener("seeked", done);
    try {
      video.currentTime = target;
    } catch {
      video.removeEventListener("seeked", done);
      window.clearTimeout(timer);
      resolveSeek(false);
    }
  });
}

// Looks for the calibrated sparkle near its expected spot and scores the fit with zero-mean
// normalised cross-correlation, which is robust to whatever brightness sits behind it.
function matchWatermarkProfile(profile, frame, threshold = MATCH_THRESHOLD) {
  if (!profile || !frame) return null;

  const { luma, width: videoWidth, height: videoHeight } = frame;

  // The watermark only sits where we calibrated it if the framing matches.
  const referenceAspect = profile.reference.width / profile.reference.height;
  if (Math.abs(videoWidth / videoHeight - referenceAspect) > 0.02) return null;

  const scale = videoHeight / profile.reference.height;
  const tw = Math.max(8, Math.round(profile.sparkle.width * scale));
  const th = Math.max(8, Math.round(profile.sparkle.height * scale));
  const expectedX = Math.round(profile.sparkle.x * scale);
  const expectedY = Math.round(profile.sparkle.y * scale);
  const search = Math.max(8, Math.round(24 * scale));

  const x0 = clamp(expectedX - search, 0, videoWidth - tw);
  const y0 = clamp(expectedY - search, 0, videoHeight - th);
  const x1 = clamp(expectedX + search, 0, videoWidth - tw);
  const y1 = clamp(expectedY + search, 0, videoHeight - th);
  const template = resampleTemplate(profile, tw, th);

  let best = null;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const score = correlate(luma, videoWidth, x, y, template, tw, th);
      if (!best || score > best.score) best = { score, x, y };
    }
  }

  if (!best || best.score < threshold) return null;
  return { profile: profile.name, x: best.x, y: best.y, score: Number(best.score.toFixed(4)), w: tw, h: th };
}

function resampleTemplate(profile, tw, th) {
  const out = new Float32Array(tw * th);
  for (let y = 0; y < th; y += 1) {
    const sy = Math.min(profile.templateHeight - 1, Math.floor((y * profile.templateHeight) / th));
    for (let x = 0; x < tw; x += 1) {
      const sx = Math.min(profile.templateWidth - 1, Math.floor((x * profile.templateWidth) / tw));
      out[y * tw + x] = profile.template[sy * profile.templateWidth + sx];
    }
  }
  return out;
}

function correlate(luma, lumaWidth, dx, dy, template, tw, th) {
  const n = tw * th;
  let sumA = 0;
  let sumB = 0;
  for (let y = 0; y < th; y += 1) {
    const row = (dy + y) * lumaWidth + dx;
    for (let x = 0; x < tw; x += 1) {
      sumA += luma[row + x];
      sumB += template[y * tw + x];
    }
  }
  const meanA = sumA / n;
  const meanB = sumB / n;

  let num = 0;
  let varA = 0;
  let varB = 0;
  for (let y = 0; y < th; y += 1) {
    const row = (dy + y) * lumaWidth + dx;
    for (let x = 0; x < tw; x += 1) {
      const a = luma[row + x] - meanA;
      const b = template[y * tw + x] - meanB;
      num += a * b;
      varA += a * a;
      varB += b * b;
    }
  }

  const denom = Math.sqrt(varA * varB);
  return denom > 1e-6 ? num / denom : 0;
}

function detectLikelyWatermarkRegion() {
  const sourceWidth = mediaWidth();
  const sourceHeight = mediaHeight();
  const scale = Math.min(1, 960 / sourceWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));

  const canvasContext = canvas.getContext("2d", { willReadFrequently: true });
  canvasContext.drawImage(activeMedia(), 0, 0, canvas.width, canvas.height);

  const zones = getDetectionZones(canvas.width, canvas.height);
  const candidates = zones
    .map((zone) => analyzeZone(canvasContext, zone))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) return null;

  const best = candidates[0];
  const inverseScale = 1 / scale;
  return clampRegion({
    x: Math.round(best.x * inverseScale),
    y: Math.round(best.y * inverseScale),
    w: Math.round(best.w * inverseScale),
    h: Math.round(best.h * inverseScale)
  }, sourceWidth, sourceHeight);
}

function getDetectionZones(width, height) {
  const zoneWidth = Math.round(width * 0.42);
  const zoneHeight = Math.round(height * 0.28);
  const insetX = Math.round(width * 0.015);
  const insetY = Math.round(height * 0.015);
  const centerWidth = Math.round(width * 0.5);

  return [
    // Google Veo / Gemini place their watermark at the bottom-center, so weight it highest.
    { x: Math.round((width - centerWidth) / 2), y: height - zoneHeight - insetY, w: centerWidth, h: zoneHeight, weight: 1.35 },
    { x: width - zoneWidth - insetX, y: height - zoneHeight - insetY, w: zoneWidth, h: zoneHeight, weight: 1.25 },
    { x: insetX, y: height - zoneHeight - insetY, w: zoneWidth, h: zoneHeight, weight: 1.1 },
    { x: width - zoneWidth - insetX, y: insetY, w: zoneWidth, h: zoneHeight, weight: 0.75 },
    { x: insetX, y: insetY, w: zoneWidth, h: zoneHeight, weight: 0.7 }
  ];
}

function analyzeZone(canvasContext, zone) {
  const image = canvasContext.getImageData(zone.x, zone.y, zone.w, zone.h);
  let minX = zone.w;
  let minY = zone.h;
  let maxX = 0;
  let maxY = 0;
  let count = 0;

  for (let y = 0; y < zone.h; y += 1) {
    for (let x = 0; x < zone.w; x += 1) {
      const offset = (y * zone.w + x) * 4;
      const r = image.data[offset];
      const g = image.data[offset + 1];
      const b = image.data[offset + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const brightness = (r + g + b) / 3;
      const saturation = max - min;

      if (brightness > 175 && saturation < 70) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        count += 1;
      }
    }
  }

  const coverage = count / (zone.w * zone.h);
  if (coverage < 0.002 || coverage > 0.42) return null;

  const pad = Math.round(Math.min(zone.w, zone.h) * 0.08);
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  if (w < zone.w * 0.05 || h < zone.h * 0.05) return null;

  return {
    x: Math.max(0, zone.x + minX - pad),
    y: Math.max(0, zone.y + minY - pad),
    w: Math.min(zone.w, w + pad * 2),
    h: Math.min(zone.h, h + pad * 2),
    score: coverage * zone.weight * Math.min(1, (w * h) / (zone.w * zone.h * 0.18))
  };
}

function getCommonWatermarkRegion(width, height) {
  // Falls back to the bottom-center band where Veo / Gemini stamp their watermark.
  const w = Math.round(width * 0.3);
  const h = Math.round(height * 0.08);
  return {
    x: Math.round((width - w) / 2),
    y: Math.round(height - h - height * 0.03),
    w,
    h
  };
}

function clampRegion(region, width, height) {
  const pad = Math.round(Math.min(width, height) * 0.012);
  const x = clamp(region.x - pad, 0, width - 8);
  const y = clamp(region.y - pad, 0, height - 8);
  const w = clamp(region.w + pad * 2, 8, width - x);
  const h = clamp(region.h + pad * 2, 8, height - y);

  return {
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(w),
    h: Math.round(h)
  };
}

function mergeRegions(existing, next) {
  const overlaps = existing.some((region) => {
    const left = Math.max(region.x, next.x);
    const top = Math.max(region.y, next.y);
    const right = Math.min(region.x + region.w, next.x + next.w);
    const bottom = Math.min(region.y + region.h, next.y + next.h);
    return right > left && bottom > top;
  });

  return overlaps ? existing : [...existing, next];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

renderRegions();
