export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "downloading"; version: string; percent: number | null }
  | { kind: "ready"; version: string };

export async function prepareUpdate(onStatus: (status: UpdateStatus) => void): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;

  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return;

  let downloaded = 0;
  let contentLength = 0;
  onStatus({ kind: "downloading", version: update.version, percent: null });
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") contentLength = event.data.contentLength ?? 0;
    if (event.event === "Progress") downloaded += event.data.chunkLength;
    const percent = contentLength > 0 ? Math.min(100, Math.round((downloaded / contentLength) * 100)) : null;
    onStatus({ kind: "downloading", version: update.version, percent });
  });
  onStatus({ kind: "ready", version: update.version });
}

export async function relaunchForUpdate(): Promise<void> {
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
