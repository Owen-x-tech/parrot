import { useEffect, useState } from "react";
import { Inbox } from "./components/Inbox";
import { Onboarding } from "./components/Onboarding";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { runtimeSnapshot, type RuntimeSnapshot } from "./lib/runtime";

export default function App() {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  useEffect(() => { void runtimeSnapshot().then(setSnapshot); }, []);
  const content = !snapshot
    ? <div className="loading" aria-label="Loading Parrot"><img src="/parrot-mark.png" alt="" /></div>
    : !snapshot.onboarded
      ? <Onboarding initialAgents={snapshot.agents} initialAuthenticated={snapshot.authenticated} onDone={() => setSnapshot({ ...snapshot, onboarded: true })} />
      : <Inbox username={snapshot.username ?? "you"} agents={snapshot.agents} />;
  return <>{content}<UpdatePrompt /></>;
}
