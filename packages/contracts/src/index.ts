import { z } from "zod";

export const USERNAME_PATTERN = /^[a-z0-9_]{2,32}$/;
export const AGENT_SLUG_PATTERN = /^[a-z0-9_]{2,24}$/;
export const MAX_MESSAGE_BYTES = 16 * 1024;

export const usernameSchema = z.string().regex(USERNAME_PATTERN);
export const agentSlugSchema = z.string().regex(AGENT_SLUG_PATTERN);
export const displayNameSchema = z.string().trim().min(1).max(80);
export const identityKindSchema = z.enum(["person", "agent"]);
export const harnessSchema = z.enum(["codex", "claude"]);

export const messageBodySchema = z.string().trim().min(1).superRefine((value, context) => {
  if (new TextEncoder().encode(value).byteLength > MAX_MESSAGE_BYTES) {
    context.addIssue({
      code: "custom",
      message: `Message exceeds ${MAX_MESSAGE_BYTES} UTF-8 bytes`,
    });
  }
});

export const clientNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
export const identityHandleSchema = z.string().regex(/^@[a-z0-9_]{2,32}(?:\/[a-z0-9_]{2,24})?$/);

export const profileSchema = z.object({
  uid: z.string().min(1),
  username: usernameSchema,
  displayName: displayNameSchema,
  personIdentityId: z.string().min(1),
  contactUids: z.array(z.string()),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
});

export const identitySchema = z.object({
  id: z.string().min(1),
  ownerUid: z.string().min(1),
  kind: identityKindSchema,
  username: usernameSchema,
  slug: agentSlugSchema.nullable(),
  handle: identityHandleSchema,
  displayName: displayNameSchema,
  harness: harnessSchema.nullable(),
  active: z.boolean(),
  visibleToContacts: z.boolean(),
});

export const contactSchema = z.object({
  id: z.string().min(1),
  memberUids: z.tuple([z.string(), z.string()]),
  invitedByUid: z.string(),
  status: z.enum(["active", "removed"]),
  acceptedAt: z.unknown(),
  removedAt: z.unknown().nullable(),
});

export const conversationSchema = z.object({
  id: z.string().min(1),
  participantIdentityIds: z.tuple([z.string(), z.string()]),
  ownerUids: z.array(z.string()).min(1).max(2),
  lastMessageAt: z.unknown().nullable(),
  lastMessagePreview: z.string().max(160),
  createdAt: z.unknown(),
});

export const messageSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  senderIdentityId: z.string().min(1),
  recipientIdentityId: z.string().min(1),
  body: messageBodySchema,
  replyToId: z.string().min(1).nullable(),
  clientNonce: clientNonceSchema,
  createdAt: z.unknown(),
});

export const inviteSchema = z.object({
  id: z.string().min(1),
  inviterUid: z.string().min(1),
  inviterIdentityId: z.string().min(1),
  status: z.enum(["open", "accepted", "revoked"]),
  expiresAt: z.unknown(),
  acceptedByUid: z.string().nullable(),
});

export const connectionStateSchema = z.object({
  harness: harnessSchema,
  status: z.enum([
    "unavailable",
    "detected",
    "configured",
    "restart_required",
    "hook_approval_required",
    "connected",
    "drifted",
  ]),
  configPath: z.string().nullable(),
  message: z.string(),
});

export type Profile = z.infer<typeof profileSchema>;
export type Identity = z.infer<typeof identitySchema>;
export type Contact = z.infer<typeof contactSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type Message = z.infer<typeof messageSchema>;
export type Invite = z.infer<typeof inviteSchema>;
export type Harness = z.infer<typeof harnessSchema>;
export type ConnectionState = z.infer<typeof connectionStateSchema>;

export function personHandle(username: string): string {
  return `@${username}`;
}

export function agentHandle(username: string, slug: string): string {
  return `@${username}/${slug}`;
}
