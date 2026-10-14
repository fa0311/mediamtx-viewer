import type { MoqObject } from "./session";

/** Track entry of the MSF catalog (draft-ietf-moq-msf-00) as MediaMTX publishes it. */
export interface CatalogTrack {
  name: string;
  codec: string;
  samplerate?: number;
  channels?: number;
  clockrate?: number;
  /** Base64 decoder configuration, e.g. AudioSpecificConfig for AAC. */
  initData?: string;
}

export const isVideoCodec = (codec: string) => /^(avc3|hev1|av01|vp09|vp8)/.test(codec);
export const isAudioCodec = (codec: string) => /^(opus|mp4a)/.test(codec);

const VIDEO_CLOCK = 90000; // MediaMTX stamps video in RTP clock units and omits clockrate
const START_CODE = Uint8Array.of(0, 0, 0, 1);
const MAX_AUDIO_LAG_SECONDS = 0.5;

/** Decodes H.264/H.265 with WebCodecs and paints each frame on a canvas as soon as it is ready. */
export class VideoRenderer {
  private readonly context: CanvasRenderingContext2D;
  private readonly decoder: VideoDecoder;
  private readonly hevc: boolean;
  bytes = 0;
  frames = 0;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly track: CatalogTrack,
    onError: (error: Error) => void,
  ) {
    if (!/^(avc3|hev1)/.test(track.codec)) {
      throw new Error(`MoQ playback supports H.264/H.265 only, the stream is ${track.codec}; use WebRTC or HLS`);
    }
    this.hevc = track.codec.startsWith("hev1");
    this.context = canvas.getContext("2d")!;
    this.decoder = new VideoDecoder({ output: (frame) => this.paint(frame), error: onError });
    // Without a description WebCodecs expects Annex B with in-band parameter sets.
    this.decoder.configure({ codec: track.codec, optimizeForLatency: true });
  }

  push(object: MoqObject): void {
    this.bytes += object.payload.length;
    this.decoder.decode(
      new EncodedVideoChunk({
        type: isKeyFrame(object.payload, this.hevc) ? "key" : "delta",
        timestamp: microseconds(object.timestamp, this.track.clockrate ?? VIDEO_CLOCK),
        data: annexB(object.payload),
      }),
    );
  }

  close(): void {
    this.decoder.close();
  }

  private paint(frame: VideoFrame): void {
    if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;
    }
    this.context.drawImage(frame, 0, 0);
    frame.close();
    this.frames++;
  }
}

/** Decodes Opus/AAC with WebCodecs and schedules the PCM back-to-back on an AudioContext. */
export class AudioPlayer {
  private readonly context = new AudioContext();
  private readonly gain = this.context.createGain();
  private readonly decoder: AudioDecoder;
  private nextStart = 0;
  bytes = 0;

  constructor(
    readonly track: CatalogTrack,
    onError: (error: Error) => void,
  ) {
    this.gain.connect(this.context.destination);
    this.decoder = new AudioDecoder({ output: (data) => this.play(data), error: onError });
    this.decoder.configure({
      codec: track.codec,
      sampleRate: track.samplerate ?? 48000,
      numberOfChannels: track.channels ?? 2,
      ...(track.initData && { description: Uint8Array.from(atob(track.initData), (char) => char.charCodeAt(0)) }),
    });
  }

  push(object: MoqObject): void {
    this.bytes += object.payload.length;
    this.decoder.decode(
      new EncodedAudioChunk({
        type: "key",
        timestamp: microseconds(object.timestamp, this.track.samplerate ?? 48000),
        data: object.payload,
      }),
    );
  }

  /** Browsers keep the context suspended until a user gesture; the volume slider is that gesture. */
  setVolume(volume: number): void {
    this.gain.gain.value = volume;
    void this.context.resume();
  }

  close(): void {
    this.decoder.close();
    void this.context.close();
  }

  private play(data: AudioData): void {
    if (this.context.state !== "running") {
      data.close();
      return;
    }
    const buffer = this.context.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
    for (let channel = 0; channel < data.numberOfChannels; channel++) {
      data.copyTo(buffer.getChannelData(channel), { planeIndex: channel, format: "f32-planar" });
    }
    data.close();

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    const now = this.context.currentTime;
    if (this.nextStart < now || this.nextStart > now + MAX_AUDIO_LAG_SECONDS) this.nextStart = now; // underrun or drift: resync
    source.start(this.nextStart);
    this.nextStart += buffer.duration;
  }
}

function microseconds(timestamp: bigint | null, clockRate: number): number {
  return timestamp === null ? 0 : Number((timestamp * 1_000_000n) / BigInt(clockRate));
}

/** Walks an AVCC-framed access unit: 4-byte big-endian length, then the NAL unit. */
function* nalUnits(avcc: Uint8Array): Generator<{ offset: number; nal: Uint8Array }> {
  const view = new DataView(avcc.buffer, avcc.byteOffset, avcc.byteLength);
  for (let offset = 0; offset + 4 <= avcc.length; ) {
    const length = view.getUint32(offset);
    yield { offset, nal: avcc.subarray(offset + 4, offset + 4 + length) };
    offset += 4 + length;
  }
}

function isKeyFrame(avcc: Uint8Array, hevc: boolean): boolean {
  for (const { nal } of nalUnits(avcc)) {
    const type = hevc ? (nal[0]! >> 1) & 0x3f : nal[0]! & 0x1f;
    if (hevc ? type >= 16 && type <= 21 : type === 5) return true;
  }
  return false;
}

/** Start codes are the same size as the length prefixes, so the conversion is in place on a copy. */
function annexB(avcc: Uint8Array): Uint8Array {
  const out = avcc.slice();
  for (const { offset } of nalUnits(avcc)) out.set(START_CODE, offset);
  return out;
}
