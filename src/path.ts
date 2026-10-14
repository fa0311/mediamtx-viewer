/** MediaMTX path names are restricted to a few characters, so the stream key travels as UTF-8 hex. */
export function mediamtxPath(key: string): string {
  return Array.from(new TextEncoder().encode(key), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The first path segment is the stream key; the root shows "live". */
export function streamKeyFromLocation(): string {
  const segment = location.pathname.split("/").find(Boolean) ?? "";
  return segment ? decodeURIComponent(segment) : "live";
}

/** Keeps non-ASCII characters readable while escaping the rest, for share links. */
export function encodeKeyForUrl(key: string): string {
  return Array.from(key, (char) =>
    /^[A-Za-z0-9._~-]$/.test(char) || char.codePointAt(0)! > 0x7f ? char : encodeURIComponent(char),
  ).join("");
}

/** Renders IDN labels (xn--) as Unicode, since the browser only exposes the ASCII form. */
export function displayHostname(hostname: string): string {
  return hostname
    .split(".")
    .map((label) => (label.startsWith("xn--") ? punycodeDecode(label.slice(4)) : label))
    .join(".");
}

// RFC 3492 decoder.
function punycodeDecode(input: string): string {
  const delimiter = input.lastIndexOf("-");
  const output = Array.from(input.slice(0, Math.max(delimiter, 0)), (char) => char.codePointAt(0)!);
  let n = 128;
  let bias = 72;
  let i = 0;
  for (let position = delimiter + 1; position < input.length; ) {
    const previous = i;
    for (let weight = 1, k = 36; ; k += 36) {
      const digit = punycodeDigit(input.charCodeAt(position++));
      i += digit * weight;
      const threshold = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
      if (digit < threshold) break;
      weight *= 36 - threshold;
    }
    bias = punycodeAdapt(i - previous, output.length + 1, previous === 0);
    n += Math.floor(i / (output.length + 1));
    i %= output.length + 1;
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}

function punycodeDigit(code: number): number {
  return code - (code < 58 ? 22 : code < 91 ? 65 : 97);
}

function punycodeAdapt(delta: number, points: number, first: boolean): number {
  delta = first ? Math.floor(delta / 700) : delta >> 1;
  delta += Math.floor(delta / points);
  let k = 0;
  for (; delta > 455; k += 36) delta = Math.floor(delta / 35);
  return k + Math.floor((36 * delta) / (delta + 38));
}
