import { useCallback, useEffect, useRef, useState } from "react";
import { prepareUpdate, relaunchForUpdate, type UpdateStatus } from "../lib/updater";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function UpdatePrompt() {
  const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });
  const checking = useRef(false);

  const checkNow = useCallback(async () => {
    if (checking.current || status.kind === "ready") return;
    checking.current = true;
    try { await prepareUpdate(setStatus); } catch { /* Retry at the next interval. */ }
    finally { checking.current = false; }
  }, [status.kind]);

  useEffect(() => {
    void checkNow();
    const interval = window.setInterval(() => { void checkNow(); }, CHECK_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [checkNow]);

  if (status.kind === "idle") return null;
  return <aside className="update-toast" aria-live="polite">
    <span>
      <strong>{status.kind === "ready" ? `Parrot ${status.version} is ready` : `Downloading Parrot ${status.version}`}</strong>
      <small>{status.kind === "ready" ? "Restart when you’re ready." : status.percent === null ? "Preparing update…" : `${status.percent}% complete`}</small>
    </span>
    {status.kind === "ready" && <button type="button" onClick={() => { void relaunchForUpdate(); }}>Relaunch to update</button>}
  </aside>;
}
