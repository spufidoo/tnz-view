/* global vscode */
const vscode = acquireVsCodeApi();

const PALETTE = {
  0x00: null,
  0xf0: "#000000",
  0xf1: "#3d9eff",
  0xf2: "#ff5a5a",
  0xf3: "#ff7ad9",
  0xf4: "#39d353",
  0xf5: "#3ee0e0",
  0xf6: "#e6d325",
  0xf7: "#f4f4f4",
  0xf8: "#1a1a1a",
};

const DEFAULT_FG = "#39d353";
const DEFAULT_BG = "#0b0f0c";
const PROTECTED_FG = "#3ee0e0";
const INTENSE_FG = "#f4f4f4";

const screenEl = document.getElementById("screen");
const canvas = document.createElement("canvas");
screenEl.appendChild(canvas);
const ctx = canvas.getContext("2d");

let state = {
  rows: 24,
  cols: 80,
  cursorRow: 1,
  cursorCol: 1,
  lock: false,
  text: " ".repeat(24 * 80),
  fa: new Uint8Array(24 * 80),
  fg: new Uint8Array(24 * 80),
  bg: new Uint8Array(24 * 80),
  eh: new Uint8Array(24 * 80),
  extendedColor: false,
};
let insertMode = false;
let cellW = 8;
let cellH = 16;

function decodeB64(s) {
  if (!s) {
    return new Uint8Array(0);
  }
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function cellColor(i) {
  const fa = state.fa[i] || 0;
  const disp = fa & 0x0c;
  const hidden = disp === 0x0c || disp === 0x08;
  if (hidden) {
    return { fg: DEFAULT_BG, bg: DEFAULT_BG, hidden: true };
  }
  const reverse = state.eh[i] === 0xf4;
  const intense = disp === 0x04;
  const protectedField = (fa & 0x20) !== 0;
  let fg = PALETTE[state.fg[i]] || null;
  let bg = PALETTE[state.bg[i]] || null;
  if (!fg) {
    if (intense) {
      fg = INTENSE_FG;
    } else if (protectedField) {
      fg = PROTECTED_FG;
    } else {
      fg = DEFAULT_FG;
    }
  }
  if (!bg) {
    bg = DEFAULT_BG;
  }
  if (reverse) {
    return { fg: bg, bg: fg, hidden: false };
  }
  return { fg, bg, hidden: false };
}

function fit() {
  const w = screenEl.clientWidth || 1;
  const h = screenEl.clientHeight || 1;
  const aspect = 0.62;
  let fontH = Math.floor(h / state.rows);
  let fontW = Math.floor(fontH * aspect);
  if (fontW * state.cols > w) {
    fontW = Math.floor(w / state.cols);
    fontH = Math.floor(fontW / aspect);
  }
  fontW = Math.max(fontW, 6);
  fontH = Math.max(fontH, 10);
  cellW = fontW;
  cellH = fontH;
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${state.cols * cellW}px`;
  canvas.style.height = `${state.rows * cellH}px`;
  canvas.width = Math.floor(state.cols * cellW * dpr);
  canvas.height = Math.floor(state.rows * cellH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  paint();
}

function paint() {
  ctx.fillStyle = DEFAULT_BG;
  ctx.fillRect(0, 0, state.cols * cellW, state.rows * cellH);
  ctx.font = `${Math.floor(cellH * 0.88)}px "Lucida Console", "Cascadia Mono", Consolas, monospace`;
  ctx.textBaseline = "top";
  const text = state.text;
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      const i = r * state.cols + c;
      const ch = text[i] || " ";
      const { fg, bg } = cellColor(i);
      const x = c * cellW;
      const y = r * cellH;
      if (bg !== DEFAULT_BG) {
        ctx.fillStyle = bg;
        ctx.fillRect(x, y, cellW, cellH);
      }
      const isCursor = r + 1 === state.cursorRow && c + 1 === state.cursorCol;
      if (isCursor) {
        ctx.fillStyle = insertMode ? fg : fg;
        if (insertMode) {
          ctx.fillRect(x, y + cellH - 2, cellW, 2);
        } else {
          ctx.fillStyle = fg;
          ctx.fillRect(x, y, cellW, cellH);
        }
      }
      ctx.fillStyle = isCursor && !insertMode ? bg : fg;
      if (ch !== " " && ch !== "\0") {
        ctx.fillText(ch, x + 1, y + 1);
      }
      if (state.eh[i] === 0xf1) {
        ctx.fillStyle = fg;
        ctx.fillRect(x, y + cellH - 1, cellW, 1);
      }
    }
  }
}

function setOia() {
  const lock = document.getElementById("oia-lock");
  lock.textContent = state.lock ? "X" : "A";
  lock.className = state.lock ? "locked" : "unlocked";
  document.getElementById("oia-ins").textContent = insertMode ? "INS" : "REP";
  document.getElementById("oia-pos").textContent = `${state.cursorRow},${state.cursorCol}`;
  document.getElementById("oia-size").textContent = `${state.rows}x${state.cols}`;
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg.op === "screen") {
    state = {
      rows: msg.rows,
      cols: msg.cols,
      cursorRow: msg.cursorRow,
      cursorCol: msg.cursorCol,
      lock: msg.lock,
      text: msg.text,
      fa: decodeB64(msg.fa),
      fg: decodeB64(msg.fg),
      bg: decodeB64(msg.bg),
      eh: decodeB64(msg.eh),
      extendedColor: msg.extendedColor,
    };
    document.getElementById("oia-msg").textContent = msg.lock ? "X SYSTEM" : "";
    fit();
    setOia();
  } else if (msg.op === "status") {
    if (msg.seslost) {
      document.getElementById("oia-msg").textContent = "SESSION LOST";
    } else if (msg.connected) {
      document.getElementById("oia-msg").textContent = msg.tls ? "TLS" : "CONNECTED";
    } else {
      document.getElementById("oia-msg").textContent = "DISCONNECTED";
    }
    state.lock = msg.lock;
    setOia();
  } else if (msg.op === "error") {
    const first = String(msg.message || "error").split("\n").find((l) => l.trim()) || "error";
    document.getElementById("oia-msg").textContent =
      first.length > 120 ? `${first.slice(0, 120)}…` : first;
  }
});

screenEl.addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault();
    vscode.postMessage({
      op: "key",
      type: "nav",
      value: e.shiftKey ? "backtab" : "tab",
    });
    return;
  }
  if (e.key.startsWith("F") && /^F([1-9]|1[0-2])$/.test(e.key)) {
    e.preventDefault();
    const n = Number(e.key.slice(1));
    const pf = e.shiftKey ? n + 12 : n;
    vscode.postMessage({ op: "key", type: "aid", value: `pf${pf}` });
    return;
  }
  const nav = {
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    ArrowDown: "down",
    Home: e.ctrlKey ? null : "home",
    Backspace: "backspace",
    Delete: "delete",
  };
  if (e.key === "Home" && e.ctrlKey) {
    e.preventDefault();
    vscode.postMessage({ op: "key", type: "nav", value: "eraseeof" });
    return;
  }
  if (nav[e.key]) {
    e.preventDefault();
    vscode.postMessage({ op: "key", type: "nav", value: nav[e.key] });
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    vscode.postMessage({ op: "key", type: "aid", value: "enter" });
    return;
  }
  if (e.key === "Insert") {
    e.preventDefault();
    insertMode = !insertMode;
    vscode.postMessage({ op: "insert", value: insertMode });
    setOia();
    paint();
    return;
  }
  if (e.key === "Pause") {
    e.preventDefault();
    vscode.postMessage({ op: "key", type: "aid", value: "clear" });
    return;
  }
  if (e.altKey && e.key.toLowerCase() === "a") {
    e.preventDefault();
    vscode.postMessage({ op: "key", type: "aid", value: "attn" });
    return;
  }
  if (e.ctrlKey && e.key.toLowerCase() === "c") {
    const sel = window.getSelection();
    if (sel && sel.toString()) {
      return;
    }
    e.preventDefault();
    vscode.postMessage({ op: "key", type: "aid", value: "attn" });
    return;
  }
  if (e.ctrlKey || e.altKey || e.metaKey) {
    return;
  }
  if (e.key.length === 1) {
    e.preventDefault();
    vscode.postMessage({
      op: "key",
      type: "chars",
      value: e.key,
      insert: insertMode,
    });
  }
});

canvas.addEventListener("mousedown", (e) => {
  screenEl.focus();
  const rect = canvas.getBoundingClientRect();
  const col = Math.min(
    state.cols,
    Math.max(1, Math.floor((e.clientX - rect.left) / (rect.width / state.cols)) + 1)
  );
  const row = Math.min(
    state.rows,
    Math.max(1, Math.floor((e.clientY - rect.top) / (rect.height / state.rows)) + 1)
  );
  vscode.postMessage({
    op: "click",
    row,
    col,
    double: e.detail === 2,
  });
});

screenEl.addEventListener("paste", (e) => {
  e.preventDefault();
  const text = e.clipboardData ? e.clipboardData.getData("text") : "";
  if (text) {
    vscode.postMessage({ op: "paste", text });
  }
});

window.addEventListener("resize", fit);
screenEl.focus();
fit();
setOia();
