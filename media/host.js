const vscode = acquireVsCodeApi();

const DEFAULT_COLORS = {
  background: "#000000",
  black: "#000000",
  blue: "#7890f0",
  red: "#f01818",
  pink: "#ff00ff",
  green: "#24d830",
  turquoise: "#58f0f0",
  yellow: "#ffff00",
  white: "#ffffff",
};

const COLOR_KEYS = Object.keys(DEFAULT_COLORS);

const PREVIEW_ROWS = [
  [
    ["green", " Unprotected normal   "],
    ["red", "Unprotected intense   "],
  ],
  [
    ["turquoise", " Protected normal     "],
    ["white", "Protected intense     "],
  ],
  [
    ["blue", " Blue "],
    ["pink", "Pink "],
    ["yellow", "Yellow "],
    ["black", "Black "],
    ["white", "White"],
  ],
];

let hostId = null;
let statusTimer = null;

const el = (id) => document.getElementById(id);

function currentColors() {
  const colors = {};
  for (const key of COLOR_KEYS) {
    colors[key] = el(`c-${key}`).value;
  }
  return colors;
}

function setStatus(text, isError) {
  const status = el("status");
  status.textContent = text;
  status.className = isError ? "error" : "";
  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }
  if (text && !isError) {
    statusTimer = setTimeout(() => {
      status.textContent = "";
    }, 3000);
  }
}

// Built as nodes rather than markup: the webview CSP forbids inline style
// attributes, but setting style properties from script is allowed.
function renderPreview() {
  const colors = currentColors();
  const preview = el("preview");
  preview.textContent = "";
  preview.style.background = colors.background;
  for (const row of PREVIEW_ROWS) {
    const line = document.createElement("div");
    for (const [key, text] of row) {
      const span = document.createElement("span");
      span.textContent = text;
      span.style.color = colors[key];
      line.appendChild(span);
    }
    preview.appendChild(line);
  }
}

function syncEnabled() {
  const tls = el("f-secure").value === "tls";
  el("f-verifyCert").disabled = !tls;
  el("f-secLevel").disabled = !tls;
}

function applyHost(host, isNew) {
  hostId = host.id;
  el("heading").textContent = isNew ? "New 3270 host" : host.label || "Host";
  el("f-label").value = host.label || "";
  el("f-group").value = host.group || "";
  el("f-host").value = host.host || "";
  el("f-port").value = String(host.port || (host.secure === false ? 23 : 992));
  el("f-psSize").value = host.psSize || "24x80";
  el("f-codePage").value = host.codePage || "037";
  el("f-secure").value = host.secure === false ? "plain" : "tls";
  el("f-secLevel").value =
    host.secLevel === undefined || host.secLevel === null
      ? ""
      : String(host.secLevel);
  el("f-verifyCert").checked = host.verifyCert !== false;
  el("f-luName").value = host.luName || "";
  el("f-tn3270e").checked = host.tn3270e !== false;
  el("f-extendedColor").checked = host.extendedColor !== false;
  el("f-blink").checked = host.blink === true;
  const colors = { ...DEFAULT_COLORS, ...(host.colors || {}) };
  for (const key of COLOR_KEYS) {
    el(`c-${key}`).value = colors[key];
  }
  syncEnabled();
  renderPreview();
}

function collect() {
  const secLevel = el("f-secLevel").value;
  return {
    id: hostId,
    label: el("f-label").value,
    group: el("f-group").value,
    host: el("f-host").value,
    port: Number(el("f-port").value),
    secure: el("f-secure").value === "tls",
    verifyCert: el("f-verifyCert").checked,
    secLevel: secLevel === "" ? undefined : Number(secLevel),
    luName: el("f-luName").value,
    tn3270e: el("f-tn3270e").checked,
    codePage: el("f-codePage").value,
    psSize: el("f-psSize").value,
    extendedColor: el("f-extendedColor").checked,
    blink: el("f-blink").checked,
    colors: currentColors(),
  };
}

el("f-secure").addEventListener("change", () => {
  const tls = el("f-secure").value === "tls";
  const port = Number(el("f-port").value);
  // Only follow the transport while the port is still the other default.
  if (port === (tls ? 23 : 992) || !port) {
    el("f-port").value = tls ? "992" : "23";
  }
  syncEnabled();
});

for (const key of COLOR_KEYS) {
  el(`c-${key}`).addEventListener("input", renderPreview);
}

el("reset").addEventListener("click", () => {
  for (const key of COLOR_KEYS) {
    el(`c-${key}`).value = DEFAULT_COLORS[key];
  }
  renderPreview();
  setStatus("Palette reset. Save to apply.");
});

el("save").addEventListener("click", () => {
  vscode.postMessage({ op: "save", host: collect() });
});

el("close").addEventListener("click", () => {
  vscode.postMessage({ op: "close" });
});

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    vscode.postMessage({ op: "save", host: collect() });
  }
});

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg.op === "load") {
    applyHost(msg.host, msg.isNew);
  } else if (msg.op === "saved") {
    el("heading").textContent = msg.host.label || "Host";
    setStatus("Saved.");
  } else if (msg.op === "invalid") {
    setStatus(msg.message, true);
  }
});

vscode.postMessage({ op: "ready" });
