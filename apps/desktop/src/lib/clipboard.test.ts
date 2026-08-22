import { describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

describe("copyText", () => {
  it("copies an invite and reports success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    await expect(copyText("https://parrot.example/i/invite")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("https://parrot.example/i/invite");
  });

  it("falls back when the webview clipboard API rejects", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("unavailable")) } });
    document.execCommand = vi.fn().mockReturnValue(true);

    await expect(copyText("https://parrot.example/i/invite")).resolves.toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });
});
