const CONTROLS_HIDE_MS = 1800;

/** The stage holds the picture and handles zoom, pan, screenshots and auto-hiding controls. */
export class Stage {
  private media: HTMLVideoElement | HTMLCanvasElement | null = null;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private hideTimer = 0;

  constructor(private readonly root: HTMLElement) {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    root.addEventListener("pointerdown", (event) => {
      if ((event.target as Element).closest("button, input, select, dialog")) return;
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      root.setPointerCapture(event.pointerId);
    });
    root.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      this.panX += event.clientX - lastX;
      this.panY += event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      this.applyTransform();
    });
    root.addEventListener("pointerup", () => {
      dragging = false;
    });
    root.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        this.zoomAt(this.zoom + (event.deltaY < 0 ? 0.15 : -0.15), event.clientX, event.clientY);
      },
      { passive: false },
    );
    for (const type of ["pointermove", "pointerdown", "touchstart", "keydown"]) {
      document.addEventListener(type, () => this.showControls(), { passive: true });
    }
    this.showControls();
  }

  show(media: HTMLVideoElement | HTMLCanvasElement): void {
    this.media?.remove();
    this.media = media;
    media.className = "media";
    this.root.prepend(media);
    this.resetView();
  }

  zoomBy(step: number): void {
    this.zoomAt(this.zoom + step, innerWidth / 2, innerHeight / 2);
  }

  resetView(): void {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.applyTransform();
  }

  /** Copies the current picture to the clipboard as PNG. */
  async copyScreenshot(): Promise<void> {
    if (!this.media) throw new Error("nothing to capture");
    const canvas = document.createElement("canvas");
    canvas.width = this.media instanceof HTMLVideoElement ? this.media.videoWidth : this.media.width;
    canvas.height = this.media instanceof HTMLVideoElement ? this.media.videoHeight : this.media.height;
    canvas.getContext("2d")!.drawImage(this.media, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("screenshot encoding failed");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  }

  private zoomAt(zoom: number, clientX: number, clientY: number): void {
    const next = Math.min(8, Math.max(0.25, zoom));
    const ratio = next / this.zoom;
    this.panX = (this.panX - (clientX - innerWidth / 2)) * ratio + (clientX - innerWidth / 2);
    this.panY = (this.panY - (clientY - innerHeight / 2)) * ratio + (clientY - innerHeight / 2);
    this.zoom = next;
    this.applyTransform();
  }

  private applyTransform(): void {
    if (!this.media) return;
    this.media.style.transform = `translate(calc(-50% + ${this.panX}px), calc(-50% + ${this.panY}px)) scale(${this.zoom})`;
  }

  private showControls(): void {
    document.body.classList.remove("controls-hidden");
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => document.body.classList.add("controls-hidden"), CONTROLS_HIDE_MS);
  }
}
