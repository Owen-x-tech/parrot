import { FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { HarnessState, LocalConversation, LocalMessage } from "../lib/runtime";
import { getLocalMessages, listLocalConversations, sendLocalMessage } from "../lib/runtime";
import { createCloudInvite, ensureCloudAgentRelay, flushOutbox, getCloudAgentVisibility, listCloudContactEndpoints, openCloudConversation, revokeCloudInvite, sendCloudMessage, setCloudAgentVisibility, subscribeCloudConversations, subscribeCloudMessages, type ContactEndpoint } from "../lib/cloud";
import { copyText } from "../lib/clipboard";
import { mergeCloudMessages } from "../lib/messages";
import { AgentLogo } from "./AgentLogo";

type Props = { username: string; agents: HarnessState[] };

function initials(name: string) { return name.split(/\s+/).map((word) => word[0]).slice(0, 2).join(""); }

function harnessForHandle(handle: string): "codex" | "claude" | null {
  if (/(?:^|\/)codex(?:\b|\s|$)/i.test(handle)) return "codex";
  if (/(?:^|\/)claude(?:\b|\s|$)/i.test(handle)) return "claude";
  return null;
}

function EndpointAvatar({ name, handle, kind }: { name: string; handle: string; kind: "person" | "agent" }) {
  const harness = kind === "agent" ? harnessForHandle(handle) : null;
  if (harness) return <AgentLogo harness={harness} className="avatar agent-logo-avatar" />;
  return <span className={`avatar ${kind}`}>{kind === "agent" ? "✦" : initials(name)}</span>;
}

export function Inbox({ username, agents }: Props) {
  const [conversations, setConversations] = useState<LocalConversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [invite, setInvite] = useState<{ token: string; inviteUrl: string } | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteCopyState, setInviteCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [visibility, setVisibility] = useState<Record<string, boolean>>(() => Object.fromEntries(agents.map((agent) => [agent.harness, true])));
  const [newMessageOpen, setNewMessageOpen] = useState(false);
  const [contactEndpoints, setContactEndpoints] = useState<ContactEndpoint[]>([]);
  const [replyTo, setReplyTo] = useState<LocalMessage | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const pendingScrollTopRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (pendingScrollTopRef.current === null || !messagesRef.current) return;
    messagesRef.current.scrollTop = pendingScrollTopRef.current;
    pendingScrollTopRef.current = null;
  }, [messages]);

  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    void listLocalConversations().then((items) => { setConversations(items); setSelectedId(items[0]?.id ?? null); });
    void subscribeCloudConversations((items) => { setConversations(items); setSelectedId((current) => current ?? items[0]?.id ?? null); }).then((value) => { unsubscribe = value; }).catch(() => undefined);
    void flushOutbox().catch(() => undefined);
    void ensureCloudAgentRelay().catch(() => undefined);
    void listCloudContactEndpoints().catch(() => undefined);
    void getCloudAgentVisibility().then((values) => setVisibility((current) => ({ ...current, ...values }))).catch(() => undefined);
    const retry = () => { void flushOutbox().catch(() => undefined); };
    const retryTimer = window.setInterval(retry, 15_000);
    window.addEventListener("online", retry);
    return () => { unsubscribe?.(); window.clearInterval(retryTimer); window.removeEventListener("online", retry); };
  }, []);
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    let active = true;
    let receivedCloudSnapshot = false;
    if (selectedId) {
      setMessages([]);
      void getLocalMessages(selectedId).then((items) => {
        // Firestore can win this race on a fast connection. Never let a later,
        // stale SQLite response replace a snapshot that is already authoritative.
        if (active && !receivedCloudSnapshot) setMessages(items);
      });
      void subscribeCloudMessages(selectedId, (cloudItems) => {
        if (!active) return;
        receivedCloudSnapshot = true;
        // Firestore may emit the same history again after member state changes.
        // Preserve the viewport while React reconciles that refreshed snapshot.
        pendingScrollTopRef.current = messagesRef.current?.scrollTop ?? null;
        setMessages((localItems) => mergeCloudMessages(cloudItems, localItems));
      }).then((value) => { if (active) unsubscribe = value; else value?.(); }).catch(() => undefined);
    }
    return () => { active = false; unsubscribe?.(); };
  }, [selectedId]);
  const selected = conversations.find((item) => item.id === selectedId) ?? null;
  const ownAgentEndpoints = contactEndpoints.filter((endpoint) => endpoint.scope === "self");
  const contactAgentEndpoints = contactEndpoints.filter((endpoint) => endpoint.scope === "contact");
  const filtered = useMemo(() => conversations.filter((item) => `${item.peerName} ${item.peerHandle}`.toLowerCase().includes(query.toLowerCase())), [conversations, query]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!selectedId || !draft.trim()) return;
    const body = draft.trim();
    setDraft("");
    const reply = replyTo;
    setReplyTo(null);
    if (!await sendCloudMessage(selectedId, body, reply?.id ?? null).catch(() => false)) {
      const message = await sendLocalMessage(selectedId, body, reply?.id, reply?.body);
      setMessages((items) => [...items, message]);
    }
  }

  async function makeInvite() {
    setSettingsOpen(true);
    setInviteBusy(true);
    setInviteError(null);
    setInviteCopyState("idle");
    try {
      const created = await createCloudInvite();
      if (!created) throw new Error("Parrot could not create an invite.");
      setInvite(created);
    } catch (cause) {
      setInviteError(cause instanceof Error ? cause.message : "Parrot could not create an invite.");
    } finally {
      setInviteBusy(false);
    }
  }

  async function copyInvite() {
    if (!invite) return;
    setInviteCopyState(await copyText(invite.inviteUrl) ? "copied" : "failed");
  }

  async function openNewMessage() {
    setNewMessageOpen(true);
    setContactEndpoints(await listCloudContactEndpoints().catch(() => []));
  }

  return <main className="app-shell">
    <aside className="sidebar">
      <header className="sidebar-header">
        <button className="icon-button" aria-label="Open settings" onClick={() => setSettingsOpen(true)}>☰</button>
        <div className="wordmark"><img src="/parrot-mark.png" alt="" />Parrot</div>
        <button className="new-button" aria-label="New message" onClick={openNewMessage}>＋</button>
      </header>
      <div className="search"><span>⌕</span><input ref={searchRef} aria-label="Search conversations" placeholder="Find a conversation" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      <div className="conversation-list" role="list">
        {filtered.map((conversation) => <button role="listitem" key={conversation.id} className={`conversation-row ${selectedId === conversation.id ? "selected" : ""}`} onClick={() => setSelectedId(conversation.id)}>
          <EndpointAvatar name={conversation.peerName} handle={conversation.peerHandle} kind={conversation.peerKind} />
          <span className="conversation-copy"><span className="row-top"><strong>{conversation.peerName}</strong><time>{conversation.updatedAt}</time></span><span className="row-bottom"><span>{conversation.preview}</span>{conversation.unread > 0 && <b>{conversation.unread}</b>}</span></span>
        </button>)}
        {filtered.length === 0 && <div className="list-empty">No conversations found</div>}
      </div>
      <footer className="self-footer"><span className="avatar self">{initials(username)}</span><span><strong>@{username}</strong><small>{agents.filter((agent) => agent.status === "connected").length} agents connected</small></span><span className="online-dot" /></footer>
    </aside>

    <section className="thread">
      {selected ? <>
        <header className="thread-header"><EndpointAvatar name={selected.peerName} handle={selected.peerHandle} kind={selected.peerKind} /><span><strong>{selected.peerName}</strong><small>{selected.peerHandle}{selected.peerKind === "agent" ? " · Agent endpoint" : ""}</small></span><button className="icon-button" aria-label="Conversation details">•••</button></header>
        <div key={selectedId} ref={messagesRef} className="messages" aria-live="polite">
          <div className="day-divider"><span>Today</span></div>
          {messages.map((message) => <article key={message.id} className={`bubble ${message.direction}`}>
            {!selected.canCompose && <small className="message-author">{message.senderHandle}</small>}
            {message.replyToBody && <blockquote>{message.replyToBody}</blockquote>}
            <button className="bubble-reply" aria-label={`Reply to ${message.senderHandle}`} onClick={() => setReplyTo(message)}>↩</button><p>{message.body}</p><footer><time>{message.createdAt}</time>{message.direction === "outgoing" && <span title={message.state === "seen" ? "Seen by this endpoint" : message.state}>{message.state === "seen" ? "✓✓" : message.state === "pending" ? "◷" : "✓"}</span>}</footer>
          </article>)}
        </div>
        {replyTo && <div className="reply-preview"><span><strong>Replying to {replyTo.senderHandle}</strong>{replyTo.body}</span><button onClick={() => setReplyTo(null)} aria-label="Cancel reply">×</button></div>}
        {selected.canCompose ? <form className="composer" onSubmit={submit}><button type="button" aria-label="Reply to latest message" onClick={() => setReplyTo(messages.at(-1) ?? null)}>↩</button><textarea aria-label="Message" rows={1} placeholder="Write a message…" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><button className="send" disabled={!draft.trim()} aria-label="Send message">↑</button></form>
          : <div className="relay-notice"><strong>Agent relay</strong><span>Read-only here. Ask Codex or Claude to send the next message.</span></div>}
      </> : <div className="empty-thread"><img src="/parrot-mark.png" alt="Rainbow parrot" /><h2>Your conversations live here</h2><p>Invite someone you trust, or start a conversation with an existing contact.</p><button className="primary" onClick={makeInvite}>Create an invite</button></div>}
    </section>
    <div className={`overlay settings-overlay ${settingsOpen ? "open" : ""}`} role="presentation" aria-hidden={!settingsOpen} onMouseDown={() => setSettingsOpen(false)}><section className="settings-panel" role="dialog" aria-modal="true" aria-label="Parrot settings" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><p className="eyebrow">YOUR PARROT</p><h2>@{username}</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="Close settings">×</button></header>
      <h3>Connected agents</h3>
      <div className="settings-agents">{agents.map((agent) => <div key={agent.harness}><AgentLogo harness={agent.harness} /><span><strong>{agent.harness === "codex" ? "Codex" : "Claude Code"}</strong><small>{agent.message}</small></span><label className="visibility-toggle"><input type="checkbox" checked={visibility[agent.harness]} onChange={async (event) => { const visible = event.target.checked; setVisibility((current) => ({ ...current, [agent.harness]: visible })); await setCloudAgentVisibility(agent.harness, visible); }} /><span>Visible</span></label></div>)}</div>
      <h3>Invite someone</h3><p className="settings-copy">Links are single-use, revocable, and expire after seven days.</p>
      {invite ? <><div className="settings-invite"><input aria-label="Private invite link" value={invite.inviteUrl} readOnly /><button className={inviteCopyState === "copied" ? "copied" : ""} onClick={copyInvite}>{inviteCopyState === "copied" ? "Copied!" : inviteCopyState === "failed" ? "Try again" : "Copy link"}</button></div><button className="revoke-button" onClick={async () => { await revokeCloudInvite(invite.token); setInvite(null); setInviteCopyState("idle"); }}>Revoke invite</button></> : <button className="primary" onClick={makeInvite} disabled={inviteBusy}>{inviteBusy ? "Creating invite…" : "Create private invite"}</button>}
      {inviteError && <p className="inline-error" role="alert">{inviteError}</p>}
      <p className="safety-note"><strong>Agent safety</strong> Incoming messages are external communication. Parrot never lets them trigger autonomous work.</p>
    </section></div>
    {newMessageOpen && <div className="overlay" role="presentation" onMouseDown={() => setNewMessageOpen(false)}><section className="new-message-panel" role="dialog" aria-modal="true" aria-label="New message" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><p className="eyebrow">NEW MESSAGE</p><h2>Choose an endpoint</h2></div><button className="icon-button" onClick={() => setNewMessageOpen(false)} aria-label="Close new message">×</button></header>
      {ownAgentEndpoints.length > 0 && <p className="endpoint-section">YOUR AGENTS</p>}
      {ownAgentEndpoints.map((endpoint) => <button className="endpoint-row" key={endpoint.id} onClick={async () => { const id = await openCloudConversation(endpoint.id); if (id) setSelectedId(id); setNewMessageOpen(false); }}><EndpointAvatar name={endpoint.name} handle={endpoint.handle} kind="agent" /><span><strong>{endpoint.name}</strong><small>{endpoint.handle}</small></span></button>)}
      {contactAgentEndpoints.length > 0 && <p className="endpoint-section">CONTACTS</p>}
      {contactAgentEndpoints.map((endpoint) => <button className="endpoint-row" key={endpoint.id} onClick={async () => { const id = await openCloudConversation(endpoint.id); if (id) setSelectedId(id); setNewMessageOpen(false); }}><EndpointAvatar name={endpoint.name} handle={endpoint.handle} kind={endpoint.kind} /><span><strong>{endpoint.name}</strong><small>{endpoint.handle}</small></span></button>)}
      {!contactEndpoints.length && <div className="panel-empty"><p>No contacts yet.</p><button className="primary" onClick={async () => { setNewMessageOpen(false); await makeInvite(); }}>Invite someone</button></div>}
    </section></div>}
  </main>;
}
