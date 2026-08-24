import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { HostProfile } from "./types";

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

function normalizeHost(raw: HostProfile): HostProfile {
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
  };
}

export async function promptHost(
  existing?: HostProfile
): Promise<HostProfile | undefined> {
  const label = await vscode.window.showInputBox({
    title: existing ? "Edit host — name" : "Add host — name",
    prompt: "Display name",
    value: existing?.label ?? "",
    ignoreFocusOut: true,
  });
  if (label === undefined) {
    return undefined;
  }

  const group = await vscode.window.showInputBox({
    title: "Group (optional)",
    prompt: "Sidebar folder name. Leave empty for no group.",
    value: existing?.group ?? "",
    ignoreFocusOut: true,
  });
  if (group === undefined) {
    return undefined;
  }

  const host = await vscode.window.showInputBox({
    title: "Hostname",
    prompt: "DNS name or IP",
    value: existing?.host ?? "",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : "Hostname is required"),
  });
  if (host === undefined) {
    return undefined;
  }

  const tlsPick = await vscode.window.showQuickPick(
    [
      { label: "TLS (port 992)", value: true },
      { label: "Plain telnet (port 23)", value: false },
    ],
    {
      title: "Security",
      ignoreFocusOut: true,
      placeHolder: existing?.secure === false ? "Plain telnet" : "TLS",
    }
  );
  if (!tlsPick) {
    return undefined;
  }
  const secure = tlsPick.value;

  const portStr = await vscode.window.showInputBox({
    title: "Port",
    value: String(existing?.port || (secure ? 992 : 23)),
    ignoreFocusOut: true,
    validateInput: (v) =>
      /^\d+$/.test(v) && Number(v) > 0 && Number(v) < 65536
        ? undefined
        : "Enter a port 1–65535",
  });
  if (portStr === undefined) {
    return undefined;
  }

  let verifyCert = true;
  if (secure) {
    const verifyPick = await vscode.window.showQuickPick(
      [
        { label: "Verify server certificate", value: true },
        { label: "Do not verify certificate", value: false },
      ],
      { title: "Certificate verification", ignoreFocusOut: true }
    );
    if (!verifyPick) {
      return undefined;
    }
    verifyCert = verifyPick.value;
  }

  const psSize = await vscode.window.showQuickPick(
    ["24x80", "32x80", "43x80", "27x132", "24x132", "62x160"],
    {
      title: "3270 screen size",
      ignoreFocusOut: true,
      placeHolder: existing?.psSize || "24x80",
    }
  );
  if (!psSize) {
    return undefined;
  }

  const codePage = await vscode.window.showInputBox({
    title: "EBCDIC code page",
    value: existing?.codePage ?? "037",
    ignoreFocusOut: true,
  });
  if (codePage === undefined) {
    return undefined;
  }

  const luName = await vscode.window.showInputBox({
    title: "LU name (optional)",
    prompt: "TN3270E LU name, if required",
    value: existing?.luName ?? "",
    ignoreFocusOut: true,
  });
  if (luName === undefined) {
    return undefined;
  }

  const secLevelStr = await vscode.window.showInputBox({
    title: "TLS security level (optional)",
    prompt: "Leave empty for default. Use 1 for older mainframe TLS stacks.",
    value: existing?.secLevel != null ? String(existing.secLevel) : "",
    ignoreFocusOut: true,
  });
  if (secLevelStr === undefined) {
    return undefined;
  }

  return {
    id: existing?.id || randomUUID(),
    label: label.trim() || host.trim(),
    group: group.trim() || undefined,
    host: host.trim(),
    port: Number(portStr),
    secure,
    verifyCert,
    luName: luName.trim(),
    tn3270e: true,
    codePage: codePage.trim() || "037",
    psSize,
    secLevel: secLevelStr.trim() ? Number(secLevelStr) : undefined,
  };
}
