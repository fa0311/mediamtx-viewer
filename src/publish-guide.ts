import { displayHostname, encodeKeyForUrl, mediamtxPath } from "./path";

const KEY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** The "start publishing" dialog: turns a stream key into the OBS WHIP URL and the share link. */
export function setupPublishGuide(currentKey: string): void {
  const dialog = document.getElementById("publishDialog") as HTMLDialogElement;
  const keyInput = document.getElementById("publishKey") as HTMLInputElement;
  const keyError = document.getElementById("publishKeyError")!;
  const whipUrl = document.getElementById("whipUrl") as HTMLInputElement;
  const viewerUrl = document.getElementById("viewerUrl") as HTMLInputElement;
  const click = (id: string, handler: () => void) => document.getElementById(id)!.addEventListener("click", handler);

  const update = () => {
    const key = keyInput.value.trim();
    keyError.textContent = !key ? "配信キーを入力するか、ランダム生成してください。" : key.includes("/") ? "配信キーに / は使用できません。" : "";
    const valid = keyError.textContent === "";
    whipUrl.value = valid ? `${location.origin}/${mediamtxPath(key)}/whip` : "";
    const host = location.port ? `${displayHostname(location.hostname)}:${location.port}` : displayHostname(location.hostname);
    viewerUrl.value = valid ? `${location.protocol}//${host}/${encodeKeyForUrl(key)}` : "";
  };

  click("openPublishGuideButton", () => {
    keyInput.value = currentKey;
    update();
    dialog.showModal();
    keyInput.select();
  });
  click("closePublishDialogButton", () => dialog.close());
  click("generatePublishKeyButton", () => {
    const values = crypto.getRandomValues(new Uint32Array(6));
    keyInput.value = Array.from(values, (value) => KEY_ALPHABET[value % KEY_ALPHABET.length]).join("");
    update();
  });
  keyInput.addEventListener("input", update);
  click("copyWhipUrlButton", () => void navigator.clipboard.writeText(whipUrl.value));
  click("copyViewerUrlButton", () => void navigator.clipboard.writeText(viewerUrl.value));
  click("openViewerUrlButton", () => {
    if (viewerUrl.value) location.assign(`/${encodeKeyForUrl(keyInput.value.trim())}`);
  });
}
