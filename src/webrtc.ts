import { StreamOffline, type Stats, type Transport } from "./transport";

/**
 * Plays over WebRTC with WHEP. ICE candidates are gathered before the single POST,
 * so no trickle-ICE PATCH requests are needed. The server advertises no ICE servers
 * (webrtcICEServers2 is empty), so none are requested either.
 */
export class WebRTCTransport implements Transport {
  readonly element = document.createElement("video");
  private pc: RTCPeerConnection | null = null;
  private sessionUrl = "";

  constructor(private readonly whepUrl: string) {
    this.element.autoplay = true;
    this.element.playsInline = true;
    this.element.muted = true;
  }

  async start(onClose: (error: Error) => void): Promise<void> {
    const pc = new RTCPeerConnection();
    this.pc = pc;
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
    pc.ontrack = (event) => {
      this.element.srcObject = event.streams[0] ?? null;
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        onClose(new Error(`peer connection ${pc.connectionState}`));
      }
    };

    await pc.setLocalDescription(await pc.createOffer());
    await iceGatheringComplete(pc);
    const response = await fetch(this.whepUrl, {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: pc.localDescription!.sdp,
    });
    if (response.status === 404) throw new StreamOffline();
    if (response.status !== 201) throw new Error(`WHEP POST returned ${response.status}`);
    this.sessionUrl = new URL(response.headers.get("Location") ?? "", new URL(this.whepUrl, location.href)).href;
    await pc.setRemoteDescription({ type: "answer", sdp: await response.text() });
  }

  stop(): void {
    this.pc?.close();
    this.pc = null;
    this.element.srcObject = null;
    if (this.sessionUrl) void fetch(this.sessionUrl, { method: "DELETE", keepalive: true });
  }

  setVolume(volume: number): void {
    this.element.volume = volume;
    this.element.muted = false;
  }

  async stats(): Promise<Stats> {
    const report = await this.pc?.getStats();
    let inbound: RTCInboundRtpStreamStats | undefined;
    report?.forEach((entry: RTCInboundRtpStreamStats) => {
      if (entry.type === "inbound-rtp" && entry.kind === "video") inbound = entry;
    });
    const codec = inbound?.codecId ? (report?.get(inbound.codecId) as { mimeType?: string } | undefined) : undefined;
    return {
      bytes: inbound?.bytesReceived ?? 0,
      frames: inbound?.framesDecoded ?? 0,
      codec: codec?.mimeType ?? "unknown",
      width: inbound?.frameWidth ?? 0,
      height: inbound?.frameHeight ?? 0,
      buffer: (inbound?.jitterBufferDelay ?? NaN) / (inbound?.jitterBufferEmittedCount ?? NaN),
      latency: NaN,
      connection: this.pc ? `${this.pc.connectionState} / ice ${this.pc.iceConnectionState}` : "closed",
    };
  }
}

function iceGatheringComplete(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (pc.iceGatheringState === "complete") resolve();
    };
    pc.onicegatheringstatechange = check;
    check();
  });
}
