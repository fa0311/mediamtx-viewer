import { ByteReader, decodeVarint, encodeMessage, encodeString, encodeVarint } from "./wire";

// Message types (draft-ietf-moq-transport-19 §10).
const SETUP = 0x2f00;
const SUBSCRIBE = 0x03;
const SUBSCRIBE_OK = 0x04;
const REQUEST_ERROR = 0x05;
const TIMESTAMP_PROPERTY = 0x06n; // draft-ietf-moq-loc §2.3.1.1
const NAMESPACE = "stream"; // MediaMTX serves every path under this namespace

export interface MoqObject {
  trackAlias: bigint;
  groupId: bigint;
  /** LOC timestamp in the track's clock units, when the publisher sent one. */
  timestamp: bigint | null;
  payload: Uint8Array;
}

export class RequestError extends Error {
  static readonly DOES_NOT_EXIST = 0x10n;

  constructor(
    readonly code: bigint,
    reason: string,
  ) {
    super(`request error 0x${code.toString(16)}: ${reason}`);
  }
}

/** A subscriber-side MoQ Transport session over WebTransport. */
export class MoqSession {
  private nextRequestId = 0n; // clients use even request IDs (§10.1)

  private constructor(
    private readonly transport: WebTransport,
    private readonly incoming: ReadableStreamDefaultReader<ReadableStream<Uint8Array>>,
  ) {}

  static async connect(url: string, fingerprintUrl: string): Promise<MoqSession> {
    const transport = new WebTransport(url, {
      serverCertificateHashes: [{ algorithm: "sha-256", value: await fetchFingerprint(fingerprintUrl) }],
      protocols: ["moqt-19"],
    });
    await transport.ready;
    const session = new MoqSession(transport, transport.incomingUnidirectionalStreams.getReader());
    await session.setup();
    return session;
  }

  /** Settles when the session ends for any reason. */
  get closed(): Promise<Error> {
    return this.transport.closed.then(
      (info) => new Error(`session closed (code ${info.closeCode}: ${info.reason || "no reason"})`),
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    );
  }

  close(): void {
    this.transport.close();
  }

  /** Subscribes to a track and returns the alias that tags its subgroup streams. */
  async subscribe(trackName: string): Promise<bigint> {
    const requestId = this.nextRequestId;
    this.nextRequestId += 2n;
    const stream = await this.transport.createBidirectionalStream();
    const writer = stream.writable.getWriter();
    await writer.write(
      encodeMessage(
        SUBSCRIBE,
        encodeVarint(requestId),
        encodeVarint(1),
        encodeString(NAMESPACE),
        encodeString(trackName),
        encodeVarint(0), // no parameters
      ),
    );
    writer.releaseLock();

    const reader = new ByteReader(stream.readable);
    const type = await reader.readVarint();
    const body = await reader.readBytes(await reader.readUint16());
    if (type === BigInt(REQUEST_ERROR)) {
      const code = decodeVarint(body);
      const retryAfter = decodeVarint(body, code.end);
      const reasonLength = decodeVarint(body, retryAfter.end);
      throw new RequestError(code.value, new TextDecoder().decode(body.subarray(reasonLength.end)));
    }
    if (type !== BigInt(SUBSCRIBE_OK)) throw new Error(`expected SUBSCRIBE_OK, got 0x${type.toString(16)}`);
    return decodeVarint(body).value;
  }

  /** Reads the next incoming subgroup stream to its end. */
  async nextSubgroup(): Promise<MoqObject[]> {
    return readSubgroup(new ByteReader(await this.nextIncomingStream()));
  }

  /**
   * Delivers objects from all incoming subgroup streams. Streams are read concurrently
   * because QUIC keeps them independent: a stalled frame must not delay the others.
   */
  async readObjects(onObject: (object: MoqObject) => void): Promise<never> {
    for (;;) {
      const stream = await this.nextIncomingStream();
      void readSubgroup(new ByteReader(stream)).then(
        (objects) => objects.forEach(onObject),
        (error: Error) => this.transport.close({ closeCode: 1, reason: error.message }),
      );
    }
  }

  /** Each peer sends SETUP on its own unidirectional control stream, which stays open (§3.3). */
  private async setup(): Promise<void> {
    const control = await this.transport.createUnidirectionalStream();
    const writer = control.getWriter();
    await writer.write(encodeMessage(SETUP)); // no setup options
    writer.releaseLock();

    const reply = new ByteReader(await this.nextIncomingStream());
    const type = await reply.readVarint();
    if (type !== BigInt(SETUP)) throw new Error(`expected SETUP, got 0x${type.toString(16)}`);
    await reply.readBytes(await reply.readUint16()); // setup options are not needed
  }

  private async nextIncomingStream(): Promise<ReadableStream<Uint8Array>> {
    const { value, done } = await this.incoming.read();
    if (done) throw new Error("session ended");
    return value;
  }
}

async function fetchFingerprint(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fingerprint fetch returned ${response.status}`);
  const hex = await response.text();
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return bytes;
}

/**
 * SUBGROUP_HEADER and its objects (§11.4.2). MediaMTX sends one frame per group, followed by
 * an end-of-group status object; the stream itself is only closed when the subscription ends.
 */
async function readSubgroup(reader: ByteReader): Promise<MoqObject[]> {
  const type = await reader.readVarint();
  if ((type & 0x90n) !== 0x10n) throw new Error(`unexpected stream type 0x${type.toString(16)}`);
  const hasProperties = (type & 0x01n) !== 0n;
  const hasSubgroupId = (type & 0x06n) === 0x04n;
  const hasPriority = (type & 0x20n) === 0n;
  const trackAlias = await reader.readVarint();
  const groupId = await reader.readVarint();
  if (hasSubgroupId) await reader.readVarint();
  if (hasPriority) await reader.readBytes(1);

  const objects: MoqObject[] = [];
  while (!(await reader.atEnd())) {
    await reader.readVarint(); // object ID delta
    const timestamp = hasProperties ? timestampOf(await reader.readBytes(Number(await reader.readVarint()))) : null;
    const length = Number(await reader.readVarint());
    if (length === 0) {
      await reader.readVarint(); // status: end of group or track
      break;
    }
    objects.push({ trackAlias, groupId, timestamp, payload: await reader.readBytes(length) });
  }
  return objects;
}

/** Properties are key/value pairs with delta-coded keys; odd keys carry length-prefixed bytes, even keys a varint (§2.5). */
function timestampOf(properties: Uint8Array): bigint | null {
  let key = 0n;
  for (let offset = 0; offset < properties.length; ) {
    const delta = decodeVarint(properties, offset);
    key += delta.value;
    const value = decodeVarint(properties, delta.end);
    offset = key % 2n === 1n ? value.end + Number(value.value) : value.end;
    if (key === TIMESTAMP_PROPERTY) return value.value;
  }
  return null;
}
