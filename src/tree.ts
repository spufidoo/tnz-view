// Copyright (c) 2026 Marcus Davage
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { getHosts } from "./hosts";
import { HostProfile, SessionStatus } from "./types";

export class HostItem extends vscode.TreeItem {
  constructor(
    public readonly profile: HostProfile,
    public readonly status: SessionStatus
  ) {
    super(profile.label, vscode.TreeItemCollapsibleState.None);
    this.id = profile.id;
    this.contextValue = status === "connected" ? "hostConnected" : "host";
    this.description = `${profile.host}:${profile.port}`;
    this.tooltip = `${profile.label}\n${profile.host}:${profile.port} ${
      profile.secure ? "TLS" : "plain"
    }\n${profile.psSize}  cp${profile.codePage}`;
    this.iconPath = new vscode.ThemeIcon(
      status === "connected"
        ? "vm-active"
        : status === "connecting"
          ? "sync~spin"
          : status === "lost"
            ? "error"
            : "vm"
    );
    this.command = {
      command: "tnzView.hosts.connect",
      title: "Connect",
      arguments: [this],
    };
  }
}

class GroupItem extends vscode.TreeItem {
  constructor(public readonly group: string) {
    super(group, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "group";
    this.iconPath = new vscode.ThemeIcon("folder");
  }
}

export class HostTreeProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>
{
  private readonly _onDidChange = new vscode.EventEmitter<
    vscode.TreeItem | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private readonly status = new Map<string, SessionStatus>();

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  setStatus(hostId: string, status: SessionStatus): void {
    if (status === "disconnected") {
      this.status.delete(hostId);
    } else {
      this.status.set(hostId, status);
    }
    this.refresh();
  }

  getStatus(hostId: string): SessionStatus {
    return this.status.get(hostId) ?? "disconnected";
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    const hosts = getHosts();
    if (element instanceof GroupItem) {
      return hosts
        .filter((h) => (h.group || "") === element.group)
        .map((h) => new HostItem(h, this.getStatus(h.id)));
    }

    const groups = [
      ...new Set(hosts.map((h) => h.group).filter((g): g is string => !!g)),
    ].sort((a, b) => a.localeCompare(b));
    const ungrouped = hosts.filter((h) => !h.group);
    return [
      ...groups.map((g) => new GroupItem(g)),
      ...ungrouped.map((h) => new HostItem(h, this.getStatus(h.id))),
    ];
  }
}
