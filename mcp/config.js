import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const CONFIG_PATH = join(homedir(), ".config", "parrot", "config.json");

export function configPath() {
  return CONFIG_PATH;
}

export function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
}

export function writeConfig(cfg) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);
}

export function getUsername() {
  return readConfig()?.username ?? null;
}
