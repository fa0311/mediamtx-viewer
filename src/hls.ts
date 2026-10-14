import type Hls from "hls.js";
import type { ErrorData } from "hls.js";
import { StreamOffline, type Stats, type Transport } from "./transport";

/** Plays low-latency HLS with hls.js (loaded on demand), or natively where MSE is unavailable (iOS Safari). */
export class HlsTransport implements Transport {
  readonly element = document.createElement("video");
  private hls: Hls | null = null;

  constructor(private readonly playlistUrl: string) {
    this.element.autoplay = true;
    this.element.playsInline = true;
    this.element.muted = true;
  }

  async start(onClose: (error: Error) => void): Promise<void> {
    const { default: Hls } = await import("hls.js");
    if (!Hls.isSupported()) {
      this.element.src = this.playlistUrl;
      this.element.onerror = () => onClose(new Error(this.element.error?.message ?? "media error"));
      return;
    }
    const hls = new Hls({
      lowLatencyMode: true,
      liveSyncDuration: 2.4,
      liveMaxLatencyDuration: 6,
      maxLiveSyncPlaybackRate: 1.5,
    });
    this.hls = hls;
    await new Promise<void>((resolve, reject) => {
      hls.on(Hls.Events.MANIFEST_PARSED, () => resolve());
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        const error = toError(data);
        reject(error);
        onClose(error);
      });
      hls.attachMedia(this.element);
      hls.loadSource(this.playlistUrl);
    });
  }

  stop(): void {
    this.hls?.destroy();
    this.hls = null;
    this.element.removeAttribute("src");
  }

  setVolume(volume: number): void {
    this.element.volume = volume;
    this.element.muted = false;
  }

  async stats(): Promise<Stats> {
    const video = this.element;
    const level = this.hls?.levels[this.hls.currentLevel];
    const buffered = video.buffered.length ? video.buffered.end(video.buffered.length - 1) - video.currentTime : 0;
    return {
      bitrate: (this.hls?.bandwidthEstimate ?? NaN) / 1000,
      frames: video.getVideoPlaybackQuality().totalVideoFrames,
      codec: level ? [level.videoCodec, level.audioCodec].filter(Boolean).join(" + ") : "unknown",
      width: video.videoWidth,
      height: video.videoHeight,
      buffer: buffered,
      latency: this.hls?.latency ?? NaN,
      connection: this.hls ? "hls.js" : "native",
    };
  }
}

function toError(data: ErrorData): Error {
  if (data.response?.code === 404) return new StreamOffline();
  return new Error([data.type, data.details, data.response?.code, data.error?.message].filter(Boolean).join(" "));
}
