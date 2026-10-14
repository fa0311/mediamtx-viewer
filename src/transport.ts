/** Thrown when the server has no live stream at the requested path; the viewer keeps polling. */
export class StreamOffline extends Error {
  constructor() {
    super("stream is offline");
  }
}

/** Counters are cumulative since start(); the caller turns them into rates. */
export interface Stats {
  /** Received media bytes. Omitted when the transport cannot count them. */
  bytes?: number;
  /** kbps, for transports that estimate it themselves instead of counting bytes. */
  bitrate?: number;
  /** Decoded video frames. */
  frames: number;
  codec: string;
  width: number;
  height: number;
  /** Seconds of media buffered ahead of playback. NaN when not applicable. */
  buffer: number;
  /** Seconds behind live. NaN when unknown. */
  latency: number;
  /** Transport-specific connection state, for the debug panel. */
  connection: string;
}

export interface Transport {
  /** Shows the picture: a <video> for WebRTC/HLS, a <canvas> for MoQ. */
  readonly element: HTMLVideoElement | HTMLCanvasElement;
  /** Resolves once media is set up. Failures after that are reported through onClose. */
  start(onClose: (error: Error) => void): Promise<void>;
  stop(): void;
  /** Called from a user gesture, so it may also unmute. */
  setVolume(volume: number): void;
  stats(): Promise<Stats>;
}
