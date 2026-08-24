import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { DEFAULT_COLORS, HostColors, HostProfile } from "./types";

const HOSTS_KEY = "hosts";

export function getHosts(): HostProfile[] {
  const raw = vscode.workspace
    .getConfiguration("tnzView")
    .get<HostProfile[]>(HOSTS_KEY, []);
  return Array.isArray(raw) ? raw.map(normalizeHost) : [];
}

export function getHost(id: string): HostProfile | undefined {
  return getHosts().find((h) => h.id === id);
}

export async function saveHosts(hosts: HostProfile[]): Promise<void> {
  await vscode.workspace
    .getConfiguration("tnzView")
    .update(HOSTS_KEY, hosts, vscode.ConfigurationTarget.Global);
}

export async function upsertHost(host: HostProfile): Promise<void> {
  const hosts = getHosts();
  const idx = hosts.findIndex((h) => h.id === host.id);
  if (idx >= 0) {
    hosts[idx] = host;
  } else {
    hosts.push(host);
  }
  await saveHosts(hosts);
}

export async function deleteHost(id: string): Promise<void> {
  await saveHosts(getHosts().filter((h) => h.id !== id));
}

export function normalizeHost(raw: Partial<HostProfile>): HostProfile {
  const secure = raw.secure !== false;
  return {
    id: raw.id || randomUUID(),
    label: raw.label || raw.host || "host",
    group: raw.group || undefined,
    host: raw.host || "",
    port: Number(raw.port) || (secure ? 992 : 23),
    secure,
    verifyCert: raw.verifyCert !== false,
    luName: raw.luName || "",
    tn3270e: raw.tn3270e !== false,
    codePage: String(raw.codePage || "037"),
    psSize: String(raw.psSize || "24x80"),
    secLevel: raw.secLevel,
    extendedColor: raw.extendedColor !== false,
    blink: raw.blink === true,
    colors: normalizeColors(raw.colors),
  };
}

export function normalizeColors(raw?: Partial<HostColors>): HostColors {
  const out = { ...DEFAULT_COLORS };
  for (const key of Object.keys(DEFAULT_COLORS) as (keyof HostColors)[]) {
    const value = raw?.[key];
    if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)) {
      out[key] = value.toLowerCase();
    }
  }
  return out;
}

export function newHost(): HostProfile {
  return normalizeHost({ id: randomUUID(), label: "", host: "" });
}
