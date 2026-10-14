import { AudioPlayer, VideoRenderer, type CatalogTrack } from "./moq/media";
import { MoqSession, RequestError, type MoqObject } from "./moq/session";
import { StreamOffline, type Stats, type Transport } from "./transport";

const REORDER_WINDOW = 30; // frames to wait for a late group before skipping it

/** Plays over Media over QUIC: WebTransport in, WebCodecs out. */
export class MoqTransport implements Transport {
  readonly element = document.createElement("canvas");
  private session: MoqSession | null = null;
  private video: VideoRenderer | null = null;
  private audio: AudioPlayer | null = null;
  private volume: number | null = null;

  constructor(private readonly url: string) {}

  async start(onClose: (error: Error) => void): Promise<void> {
    if (!("WebTransport" in window)) throw new Error("this browser has no WebTransport; use WebRTC or HLS");
    const session = await MoqSession.connect(this.url, `${this.url}/fingerprint`);
    this.session = session;
    void session.closed.then(onClose);

    // The catalog is the only stream until we subscribe to tracks, so it can be read directly.
    const catalogAlias = await session.subscribe(".catalog").catch(offlineIfMissing);
    const [catalogObject] = await session.nextSubgroup();
    if (catalogObject?.trackAlias !== catalogAlias) throw new Error("expected the catalog as the first object");
    const catalog = JSON.parse(new TextDecoder().decode(catalogObject.payload)) as { tracks: CatalogTrack[] };

    // The catalog marks audio tracks with a sample rate; the first track of each kind is played.
    const routes = new Map<bigint, (object: MoqObject) => void>();
    for (const track of catalog.tracks) {
      if (track.samplerate === undefined && !this.video) {
        this.video = new VideoRenderer(this.element, track, onClose);
        routes.set(await session.subscribe(track.name), inGroupOrder(this.video));
      } else if (track.samplerate !== undefined && !this.audio) {
        this.audio = new AudioPlayer(track, onClose);
        if (this.volume !== null) this.audio.setVolume(this.volume);
        routes.set(await session.subscribe(track.name), inGroupOrder(this.audio));
      }
    }

    void session.readObjects((object) => {
      const route = routes.get(object.trackAlias);
      if (route) route(object);
      else console.warn("object for unknown track alias", object.trackAlias);
    }).catch(onClose);
  }

  stop(): void {
    this.session?.close();
    this.video?.close();
    this.audio?.close();
    this.session = this.video = this.audio = null;
  }

  setVolume(volume: number): void {
    this.volume = volume;
    this.audio?.setVolume(volume);
  }

  async stats(): Promise<Stats> {
    return {
      bytes: (this.video?.bytes ?? 0) + (this.audio?.bytes ?? 0),
      frames: this.video?.frames ?? 0,
      codec: [this.video?.track.codec, this.audio?.track.codec].filter(Boolean).join(" + ") || "unknown",
      width: this.element.width,
      height: this.element.height,
      buffer: NaN,
      latency: NaN,
      connection: this.session ? "webtransport" : "closed",
    };
  }
}

function offlineIfMissing(error: unknown): never {
  throw error instanceof RequestError && error.code === RequestError.DOES_NOT_EXIST ? new StreamOffline() : error;
}

/** Subgroup streams finish in any order; frames are released in group order, skipping a group once REORDER_WINDOW newer ones have arrived. */
function inGroupOrder(sink: { push(object: MoqObject): void }): (object: MoqObject) => void {
  const pending = new Map<bigint, MoqObject>();
  let next: bigint | null = null;
  return (object) => {
    next ??= object.groupId;
    if (object.groupId < next) return; // already skipped
    pending.set(object.groupId, object);
    for (;;) {
      const head = pending.get(next);
      if (head) {
        pending.delete(next);
        sink.push(head);
        next += 1n;
      } else if (pending.size > REORDER_WINDOW) {
        next = [...pending.keys()].reduce((a, b) => (a < b ? a : b));
      } else {
        return;
      }
    }
  };
}
