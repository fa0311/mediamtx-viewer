# mediamtx-viewer

[MediaMTX](https://github.com/bluenviron/mediamtx) の配信を WebRTC / HLS / MoQ (Media over QUIC) で見る単一ページ。
TypeScript + Vite で、Docker のマルチステージビルドで nginx イメージに焼く。
GitHub Actions が main への push ごとに `ghcr.io/fa0311/mediamtx-viewer` を更新する。

```yaml
services:
  mediamtx:
    image: bluenviron/mediamtx
    ports:
      - "8189:8189/udp" # WebRTC ICE
      - "8892:8892/tcp" # MoQ web (HTTP/2)
      - "8892:8892/udp" # MoQ WebTransport (HTTP/3)
  viewer:
    image: ghcr.io/fa0311/mediamtx-viewer
    ports:
      - "80:80"
```

nginx は MediaMTX に `mediamtx:8889` (WebRTC) と `mediamtx:8888` (HLS) で到達する前提。

| URL | 経路 |
| --- | --- |
| `/<配信キー>` | WebRTC (WHEP)。nginx が `/<path>/whip` と `/<path>/whep` を MediaMTX へ中継 |
| `/<配信キー>?hls` | 低遅延 HLS。nginx が `/<path>/*.m3u8` 等を MediaMTX へ中継 |
| `/<配信キー>?moq` | Media over QUIC。ブラウザが `https://<同じホスト>:8892/<path>` へ直接 WebTransport で接続 |

配信キーは UTF-8 の hex にして MediaMTX のパス名にする（`live` → `6c697665`）。

MoQ は WebTransport のためリバースプロキシを通せない。8892/TCP+UDP を MediaMTX に直接届け、
`mediamtx.yml` の `moqAllowOrigins` にこのページのオリジンを入れておく。MoQ で再生できるコーデックはブラウザの WebCodecs が復号できるもの全部で、viewer 側では絞らない。

## 開発

```
docker run --rm -v "$PWD":/app -w /app -u "$(id -u):$(id -g)" -e HOME=/tmp node:22-alpine npm install
docker run --rm -v "$PWD":/app -w /app -u "$(id -u):$(id -g)" -e HOME=/tmp node:22-alpine npm run build
```

- `src/main.ts` 起点。URL からモードと配信キーを決め、接続・再接続・デバッグパネルを回す
- `src/webrtc.ts` `src/hls.ts` `src/moq.ts` 各トランスポート。`src/transport.ts` の `Transport` を実装
- `src/moq/` MoQ Transport draft-19 のクライアント。`wire.ts` 可変長整数とバイト読み、`session.ts` SETUP / SUBSCRIBE / subgroup、`media.ts` WebCodecs での復号と描画
- `src/view.ts` ズーム・パン・スクリーンショット、`src/publish-guide.ts` 配信開始ダイアログ
