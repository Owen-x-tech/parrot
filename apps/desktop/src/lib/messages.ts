import type { LocalMessage } from "./runtime";

function signature(message: LocalMessage): string {
  return `${message.senderHandle}\u0000${message.body}\u0000${message.replyToBody ?? ""}`;
}

export function mergeCloudMessages(cloudItems: LocalMessage[], localItems: LocalMessage[]): LocalMessage[] {
  const cloudIds = new Set(cloudItems.map((message) => message.id));
  const authoritative = new Map<string, number>();
  for (const message of cloudItems) {
    const key = signature(message);
    authoritative.set(key, (authoritative.get(key) ?? 0) + 1);
  }
  const pending = localItems.filter((message) => {
    if ((message.state !== "pending" && message.state !== "failed") || cloudIds.has(message.id)) return false;
    const key = signature(message);
    const matching = authoritative.get(key) ?? 0;
    if (matching === 0) return true;
    authoritative.set(key, matching - 1);
    return false;
  });
  return [...cloudItems, ...pending];
}
