// MoQ Transport wire primitives (draft-ietf-moq-transport-19).

/**
 * Variable-length integer (§1.4.1): the count of leading 1 bits in the first byte
 * is the number of bytes that follow; the remaining bits hold the value, big-endian.
 */
export function encodeVarint(value: number | bigint): Uint8Array {
  const v = BigInt(value);
  for (let size = 1; size <= 8; size++) {
    if (v < 1n << BigInt(7 * size)) {
      const bytes = bigEndian(v, size);
      bytes[0]! |= (0xff << (9 - size)) & 0xff;
      return bytes;
    }
  }
  return concat(Uint8Array.of(0xff), bigEndian(v, 8));
}

export function decodeVarint(bytes: Uint8Array, offset = 0): { value: bigint; end: number } {
  const first = bytes[offset]!;
  const extra = leadingOnes(first);
  let value = BigInt(first & (0x7f >> extra));
  for (let i = 1; i <= extra; i++) value = (value << 8n) | BigInt(bytes[offset + i]!);
  return { value, end: offset + 1 + extra };
}

function leadingOnes(byte: number): number {
  return Math.min(Math.clz32(((~byte & 0xff) << 24) >>> 0), 8);
}

function bigEndian(value: bigint, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = size - 1; i >= 0; i--) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Length-prefixed UTF-8, used for namespace fields and track names. */
export function encodeString(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  return concat(encodeVarint(bytes.length), bytes);
}

/** Control message (§10): type, 16-bit body length, body. */
export function encodeMessage(type: number, ...body: Uint8Array[]): Uint8Array {
  const payload = concat(...body);
  return concat(encodeVarint(type), Uint8Array.of(payload.length >> 8, payload.length & 0xff), payload);
}

/** Reads MoQ fields from a byte stream, buffering across chunk boundaries. */
export class ByteReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer: Uint8Array = new Uint8Array(0);

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  /** True once the stream has ended and no buffered bytes remain. */
  async atEnd(): Promise<boolean> {
    return this.buffer.length === 0 && !(await this.fill());
  }

  async readBytes(count: number): Promise<Uint8Array> {
    while (this.buffer.length < count) {
      if (!(await this.fill())) throw new Error(`stream ended ${count - this.buffer.length} bytes early`);
    }
    const bytes = this.buffer.slice(0, count);
    this.buffer = this.buffer.subarray(count);
    return bytes;
  }

  async readVarint(): Promise<bigint> {
    const first = await this.readBytes(1);
    const rest = await this.readBytes(leadingOnes(first[0]!));
    return decodeVarint(concat(first, rest)).value;
  }

  async readUint16(): Promise<number> {
    const [high, low] = await this.readBytes(2);
    return (high! << 8) | low!;
  }

  private async fill(): Promise<boolean> {
    const { value, done } = await this.reader.read();
    if (done) return false;
    this.buffer = concat(this.buffer, value);
    return true;
  }
}
