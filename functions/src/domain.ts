import { createHash, randomBytes } from "node:crypto";
import {
  agentSlugSchema,
  clientNonceSchema,
  displayNameSchema,
  messageBodySchema,
  usernameSchema,
} from "@parrot/contracts";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function personIdentityId(uid: string): string {
  return `person_${sha256(uid).slice(0, 32)}`;
}

export function agentIdentityId(uid: string, slug: string): string {
  return `agent_${sha256(`${uid}:${agentSlugSchema.parse(slug)}`).slice(0, 32)}`;
}

export function contactId(uidA: string, uidB: string): string {
  return `contact_${sha256([uidA, uidB].sort().join(":"))}`;
}

export function conversationId(identityA: string, identityB: string): string {
  return `conversation_${sha256([identityA, identityB].sort().join(":"))}`;
}

export function messageId(conversation: string, senderIdentity: string, nonce: string): string {
  return `message_${sha256(`${conversation}:${senderIdentity}:${clientNonceSchema.parse(nonce)}`)}`;
}

export function parseProfileInput(input: unknown): { username: string; displayName: string } {
  const data = (input ?? {}) as Record<string, unknown>;
  return {
    username: usernameSchema.parse(data.username),
    displayName: displayNameSchema.parse(data.displayName),
  };
}

export function parseMessageInput(input: unknown): {
  conversationId: string;
  senderIdentityId: string;
  recipientIdentityId: string;
  body: string;
  replyToId: string | null;
  clientNonce: string;
} {
  const data = (input ?? {}) as Record<string, unknown>;
  return {
    conversationId: String(data.conversationId ?? ""),
    senderIdentityId: String(data.senderIdentityId ?? ""),
    recipientIdentityId: String(data.recipientIdentityId ?? ""),
    body: messageBodySchema.parse(data.body),
    replyToId: data.replyToId ? String(data.replyToId) : null,
    clientNonce: clientNonceSchema.parse(data.clientNonce),
  };
}
