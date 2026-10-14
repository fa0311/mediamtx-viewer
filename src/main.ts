import "./style.css";
import { HlsTransport } from "./hls";
import { MoqTransport } from "./moq";
import { mediamtxPath, streamKeyFromLocation } from "./path";
import { setupPublishGuide } from "./publish-guide";
import { StreamOffline, type Stats, type Transport } from "./transport";
import { Stage } from "./view";
import { WebRTCTransport } from "./webrtc";

const MOQ_PORT = 8892; // MediaMTX MoQ listener; WebTransport cannot pass through the reverse proxy
const HISTORY_SIZE = 120;
type Mode = "webrtc" | "hls" | "moq";

const params = new URLSearchParams(location.search);
const mode: Mode = params.has("moq") ? "moq" : params.has("hls") ? "hls" : "webrtc";
// The root plays an unadvertised default key; while nothing is published there it just shows the guide.
const urlKey = streamKeyFromLocation();
const key = urlKey || "live";
const path = mediamtxPath(key);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusElement = $("status");
const stage = new Stage($("stage"));
const volumeInput = $<HTMLInputElement>("volume");

let transport: Transport | null = null;
let unmuted = false;
let reconnects = 0;
let lastError = "none";

function createTransport(): Transport {
  switch (mode) {
    case "webrtc":
      return new WebRTCTransport(`/${path}/whep`);
    case "hls":
      return new HlsTransport(`/${path}/index.m3u8`);
    case "moq":
      return new MoqTransport(`https://${location.hostname}:${MOQ_PORT}/${path}`);
  }
}

function setStatus(message: string, tone: "" | "warn" | "bad" = ""): void {
  statusElement.textContent = message;
  statusElement.dataset.tone = tone;
}

/** Connects, waits for the session to end, reports why, and reconnects. */
async function play(): Promise<never> {
  for (;;) {
    const current = createTransport();
    transport = current;
    stage.show(current.element);
    if (unmuted) current.setVolume(Number(volumeInput.value));
    setStatus(`connecting ${key} via ${mode}`);

    const ended = new Promise<Error>((resolve) => {
      current.start(resolve).then(() => {
        setStatus("live");
        $("offlineGuide").hidden = true;
      }, resolve);
    });
    const error = await ended;
    current.stop();
    transport = null;
    reconnects++;
    lastError = error.message;

    const offline = error instanceof StreamOffline;
    $("offlineGuide").hidden = !offline;
    setStatus(offline ? "waiting for the stream to start" : `${error.message}; reconnecting`, offline ? "" : "warn");
    if (!offline) console.error(`[${mode}]`, error);
    await new Promise((resolve) => setTimeout(resolve, offline ? 1000 : 2000));
  }
}

const history: number[] = [];
let previous = { bytes: 0, frames: 0, at: performance.now() };

const IDLE_STATS: Stats = { frames: 0, codec: "-", width: 0, height: 0, buffer: NaN, latency: NaN, connection: "idle" };

async function renderStats(): Promise<void> {
  const stats = transport ? await transport.stats() : IDLE_STATS;
  const now = performance.now();
  const seconds = (now - previous.at) / 1000;
  const bitrate = stats.bitrate ?? Math.max(0, ((stats.bytes ?? 0) - previous.bytes) * 8) / seconds / 1000;
  const fps = Math.max(0, stats.frames - previous.frames) / seconds;
  previous = { bytes: stats.bytes ?? 0, frames: stats.frames, at: now };
  history.push(bitrate);
  if (history.length > HISTORY_SIZE) history.shift();

  const text = (id: string, value: string) => ($(id).textContent = value);
  text("bitrate", `${Math.round(bitrate)} kbps`);
  text("fps", fps.toFixed(1));
  text("codec", stats.codec);
  text("size", `${stats.width}x${stats.height}`);
  text("buffer", seconds2(stats.buffer));
  text("latency", seconds2(stats.latency));
  text("connection", stats.connection);
  text("reconnects", String(reconnects));
  text("lastError", lastError);
  drawGraph();
}

const seconds2 = (value: number) => (Number.isFinite(value) ? `${value.toFixed(2)}s` : "n/a");

function drawGraph(): void {
  const graph = $<HTMLCanvasElement>("graph");
  const context = graph.getContext("2d")!;
  const max = Math.max(1000, ...history);
  context.clearRect(0, 0, graph.width, graph.height);
  context.strokeStyle = "#5ee6a8";
  context.lineWidth = 2;
  context.beginPath();
  history.forEach((value, index) => {
    const x = (index / (HISTORY_SIZE - 1)) * graph.width;
    const y = graph.height - 5 - (value / max) * (graph.height - 10);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.stroke();
}

function bindControls(): void {
  $("streamName").textContent = urlKey || "-";
  const modeSelect = $<HTMLSelectElement>("mode");
  modeSelect.value = mode;
  modeSelect.addEventListener("change", () => {
    location.assign(location.pathname + (modeSelect.value === "webrtc" ? "" : `?${modeSelect.value}`));
  });
  volumeInput.addEventListener("input", () => {
    unmuted = true;
    transport?.setVolume(Number(volumeInput.value));
  });
  $("zoomInButton").addEventListener("click", () => stage.zoomBy(0.25));
  $("zoomOutButton").addEventListener("click", () => stage.zoomBy(-0.25));
  $("resetButton").addEventListener("click", () => stage.resetView());
  $("shotButton").addEventListener("click", () => {
    stage.copyScreenshot().then(
      () => setStatus("screenshot copied"),
      (error: Error) => setStatus(`screenshot failed: ${error.message}`, "bad"),
    );
  });
  $("debugButton").addEventListener("click", () => $("debugPanel").classList.toggle("open"));
  $("closeDebugButton").addEventListener("click", () => $("debugPanel").classList.remove("open"));
}

bindControls();
setupPublishGuide(urlKey);
setInterval(() => void renderStats(), 1000);
play().catch((error: Error) => setStatus(`fatal: ${error.message}`, "bad"));
