// Where keys live: the macOS Keychain, the Secret Service on Linux (GNOME Keyring, KWallet), and nowhere at all
// elsewhere, where a key lasts only until Herdr quits. Never in shared.json, localStorage or a log.
//
// A key never goes on a command line, where other processes could read it. It's written to a file in a folder only
// this user can open, read from stdin by the keychain tool, and the file is removed in the same command.

import { exec, appHome } from "herdr";
import * as fs from "fs/promises";
import os from "os";
import { randomBytes } from "crypto";
import { checkKey } from "./model.js";

const SERVICE = "herdr.flowdeck";
const LABEL = "Flowdeck for n8n";
const platform = () => os.platform();

export const privateDir = () => `${appHome()}/.flowdeck`;

export async function ensurePrivateDir() {
  const dir = privateDir();
  // mkdir -m only applies to a folder it creates, so close an older one too, then check it really is ours alone and
  // not a link somewhere else. Nothing secret is written until this holds.
  const r = await exec("sh", ["-c", 'mkdir -p -m 700 "$1" && chmod 700 "$1" && [ -d "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] && m=$(stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1") && [ "$m" = 700 ]', "sh", dir]);
  if (r.code !== 0) throw new Error("Flowdeck's private folder isn't private, so it won't write a key there");
  return dir;
}

// The keychain item is named for the profile and the instance's origin together, so a profile whose address was
// changed behind Flowdeck's back (shared state is writable) finds no key, rather than sending it somewhere new.
const account = (id, base) => {
  if (!/^[a-z0-9-]{1,40}$/.test(id)) throw new Error("bad profile id");
  let origin;
  try { origin = new URL(base).origin; } catch { throw new Error("bad instance address"); }
  if (!/^https?:\/\/[a-z0-9.\-:[\]]{1,300}$/.test(origin)) throw new Error("bad instance address");
  return `${id}@${origin}`;
};

async function has(cmd) {
  try { return (await exec("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", cmd])).code === 0; } catch { return false; }
}

let kindCache = null;
export async function vaultKind() {
  if (kindCache) return kindCache;
  const p = platform();
  if ((p === "macos" || p === "darwin") && await has("security")) kindCache = "keychain";
  else if (p === "linux" && await has("secret-tool")) kindCache = "secret-service";
  else kindCache = "session";
  return kindCache;
}

export const vaultName = (kind) => ({ keychain: "macOS Keychain", "secret-service": "your system keyring", session: "memory until Herdr quits" })[kind] ?? kind;

// Session-only keys, per Herdr run. Kept off disk entirely.
const SESSION = "flowdeck.session.";

async function viaStdin(contents, script, args) {
  const dir = await ensurePrivateDir();
  const file = `${dir}/k-${randomBytes(8).toString("hex")}`;
  try {
    await fs.writeFile(file, contents);
    await exec("chmod", ["600", file]);
    return await exec("sh", ["-c", `umask 077; ${script}; c=$?; rm -f "$1"; exit $c`, "sh", file, ...args]);
  } finally {
    await exec("rm", ["-f", file]).catch(() => {});
  }
}

export async function saveSecret(id, base, secret, { remember = true } = {}) {
  const { key, error } = checkKey(secret);
  if (error) throw new Error(error);
  const kind = remember ? await vaultKind() : "session";
  if (kind === "keychain") {
    // security -i reads commands from stdin; checkKey guarantees the key has no quotes or spaces to escape.
    const r = await viaStdin(`add-generic-password -U -s "${SERVICE}" -a "${account(id, base)}" -l "${LABEL}" -w "${key}"\n`, 'security -i < "$1" >/dev/null', []);
    if (r.code !== 0) throw new Error("The Keychain didn't save the key");
  } else if (kind === "secret-service") {
    const r = await viaStdin(key, 'secret-tool store --label="$2" service "$3" account "$4" < "$1"', [LABEL, SERVICE, account(id, base)]);
    if (r.code !== 0) throw new Error("The system keyring didn't save the key");
  } else {
    sessionStorage.setItem(SESSION + account(id, base), key);
  }
  return kind;
}

export async function loadSecret(id, base) {
  const session = sessionStorage.getItem(SESSION + account(id, base));
  if (session) return session;
  const kind = await vaultKind();
  let r = null;
  if (kind === "keychain") r = await exec("security", ["find-generic-password", "-s", SERVICE, "-a", account(id, base), "-w"]).catch(() => null);
  else if (kind === "secret-service") r = await exec("secret-tool", ["lookup", "service", SERVICE, "account", account(id, base)]).catch(() => null);
  const key = r?.code === 0 ? r.stdout.trim() : "";
  return checkKey(key).key ?? null;
}

export async function deleteSecret(id, base) {
  sessionStorage.removeItem(SESSION + account(id, base));
  const kind = await vaultKind();
  if (kind === "keychain") await exec("security", ["delete-generic-password", "-s", SERVICE, "-a", account(id, base)]).catch(() => null);
  else if (kind === "secret-service") await exec("secret-tool", ["clear", "service", SERVICE, "account", account(id, base)]).catch(() => null);
}

// Leftovers from a crash mid-save: nothing in the private folder should outlive the command that wrote it.
export async function sweepPrivateDir() {
  const dir = await ensurePrivateDir();
  await exec("sh", ["-c", 'find "$1" -maxdepth 1 -type f \\( -name "k-*" -o -name "ask-*" \\) -mmin +10 -delete', "sh", dir]).catch(() => null);
}
