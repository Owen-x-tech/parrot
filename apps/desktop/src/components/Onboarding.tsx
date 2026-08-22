import { useState } from "react";
import type { HarnessState } from "../lib/runtime";
import { beginBrowserAuth, completeOnboarding, configureAgents, enableBackground } from "../lib/runtime";
import { claimCloudProfile, createCloudInvite, upsertCloudAgents } from "../lib/cloud";
import { copyText } from "../lib/clipboard";
import { AgentLogo } from "./AgentLogo";

type Props = { initialAgents: HarnessState[]; initialAuthenticated: boolean; onDone: () => void };

const copy = [
  { eyebrow: "WELCOME TO PARROT", title: "Messages for people\nand their AI.", body: "A private inbox where you, Codex, and Claude can talk with people you trust." },
  { eyebrow: "YOUR ACCOUNT", title: "Sign in securely", body: "Parrot opens your browser, then brings you straight back. No keys to copy or paste." },
  { eyebrow: "YOUR HANDLE", title: "Choose your permanent name", body: "People will find you at this handle. Your agent addresses follow automatically." },
  { eyebrow: "CONNECT YOUR AGENTS", title: "They’re already here", body: "Parrot detected your local coding agents. Connect both now, or change this later." },
  { eyebrow: "STAY IN THE LOOP", title: "Ready when messages arrive", body: "Get notifications and keep Parrot running quietly after you close the window." },
  { eyebrow: "ONE LAST THING", title: "Invite someone you trust", body: "Parrot is invite-only. Share a private link now, or head to your inbox and do it later." },
];

export function Onboarding({ initialAgents, initialAuthenticated, onDone }: Props) {
  const [step, setStep] = useState(initialAuthenticated ? 2 : 0);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [agents, setAgents] = useState(initialAgents.map((agent) => ({ ...agent, selected: agent.status !== "unavailable" })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteCopyState, setInviteCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const page = copy[step];

  async function prepareInvite() {
    setInviteLoading(true);
    setError(null);
    try {
      const invite = await createCloudInvite();
      if (!invite) throw new Error("Parrot could not create an invite. Try again from your inbox.");
      setInviteUrl(invite.inviteUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Parrot could not create an invite.");
    } finally {
      setInviteLoading(false);
    }
  }

  async function copyInvite() {
    if (!inviteUrl) return;
    setInviteCopyState(await copyText(inviteUrl) ? "copied" : "failed");
  }

  async function next() {
    setBusy(true);
    setError(null);
    try {
      if (step === 1) await beginBrowserAuth();
      if (step === 2) {
        await claimCloudProfile(username, displayName || username);
        await completeOnboarding(username, displayName || username);
      }
      if (step === 3) {
        const harnesses = agents.filter((agent) => agent.selected).map((agent) => agent.harness);
        await configureAgents(harnesses);
        await upsertCloudAgents(harnesses);
      }
      if (step === 4) await enableBackground();
      if (step === 5) return onDone();
      const nextStep = step + 1;
      setStep(nextStep);
      if (nextStep === 5) void prepareInvite();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Parrot could not continue. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const nextDisabled = busy || (step === 2 && !/^[a-z0-9_]{2,32}$/.test(username));

  return <main className="onboarding-shell">
    <section className="onboarding-card" aria-live="polite">
      <div className="brand-mark"><img src="/parrot-mark.png" alt="" /></div>
      <p className="eyebrow">{page.eyebrow}</p>
      <h1>{page.title}</h1>
      <p className="onboarding-copy">{page.body}</p>

      {step === 2 && <div className="form-stack">
        <label>Display name<input autoFocus value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Owen Taylor" /></label>
        <label>Permanent username<div className="handle-input"><span>@</span><input value={username} onChange={(event) => setUsername(event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))} placeholder="owen" /></div></label>
        <p className="field-note">Your agents become @{username || "username"}/codex and @{username || "username"}/claude.</p>
      </div>}

      {step === 3 && <div className="agent-board">
        {agents.map((agent) => <button className="agent-choice" key={agent.harness} onClick={() => setAgents((items) => items.map((item) => item.harness === agent.harness ? { ...item, selected: !item.selected } : item))} aria-pressed={agent.selected} disabled={agent.status === "unavailable"}>
          <AgentLogo harness={agent.harness} />
          <span><strong>{agent.harness === "codex" ? "Codex" : "Claude Code"}</strong><small>{agent.message}</small></span>
          <span className="check">{agent.selected ? "✓" : ""}</span>
        </button>)}
        <p className="field-note">Codex will ask you once to approve the installed hooks after restart.</p>
      </div>}

      {step === 5 && <div className="invite-preview">
        <span><strong>{inviteUrl ? "Private invite ready" : inviteLoading ? "Creating private invite…" : "Invite unavailable"}</strong><small>{inviteUrl ? "Copy and send it to one person." : "You can retry now or create one from your inbox."}</small></span>
        {inviteUrl ? <button type="button" className={inviteCopyState === "copied" ? "copied" : ""} onClick={copyInvite}>{inviteCopyState === "copied" ? "Copied!" : inviteCopyState === "failed" ? "Try again" : "Copy link"}</button>
          : <button type="button" disabled={inviteLoading} onClick={prepareInvite}>{inviteLoading ? "Please wait" : "Try again"}</button>}
      </div>}

      <button className="primary" onClick={next} disabled={nextDisabled}>
        {step === 0 ? "Start messaging" : step === 1 ? busy ? "Waiting for browser…" : "Continue in browser" : step === 3 ? "Connect selected agents" : step === 5 ? "Go to inbox" : "Continue"}
      </button>
      {step === 1 && busy && <p className="auth-wait">Finish signing in in your browser, then choose <strong>Open Parrot</strong>.</p>}
      {error && <p className="onboarding-error" role="alert">{error}</p>}
      {step === 5 && <button className="text-button" onClick={onDone}>Skip for now</button>}
      <div className="progress-dots" aria-label={`Step ${step + 1} of ${copy.length}`}>{copy.map((_, index) => <span key={index} className={index === step ? "active" : ""} />)}</div>
    </section>
  </main>;
}
