const vscode = acquireVsCodeApi();

// IBM PCOMM defaults, overridden per host from the settings tab.
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

const EH_BLINK = 0xf1;
const EH_REVERSE = 0xf2;
const EH_UNDERSCORE = 0xf4;

const config = window.__TNZ_CONFIG__ || {};
let colors = { ...DEFAULT_COLORS, ...(config.colors || {}) };
let blinkEnabled = config.blink === true;
let keymap = config.keymap || {};

// Colour value 0 means "use the field default".
let PALETTE = {};

function applyColors() {
  PALETTE = {
    0x00: null,
    0xf0: colors.black,
    0xf1: colors.blue,
    0xf2: colors.red,
    0xf3: colors.pink,
    0xf4: colors.green,
    0xf5: colors.turquoise,
    0xf6: colors.yellow,
    0xf7: colors.white,
  };
  document.body.style.background = colors.background;
}

const FONT_STACK =
  '"Lucida Console", "Cascadia Mono", Consolas, "Courier New", monospace';
const LINE_RATIO = 1.2;

const screenEl = document.getElementById("screen");
const gridEl = document.createElement("div");
gridEl.id = "grid";
const cursorEl = document.createElement("div");
cursorEl.id = "cursor";
gridEl.appendChild(cursorEl);
screenEl.appendChild(gridEl);

const measure = document.createElement("canvas").getContext("2d");

let state = {
  rows: 24,
  cols: 80,
  cursorRow: 1,
  cursorCol: 1,
  lock: false,
  text: " ".repeat(24 * 80),
  attr: new Uint8Array(24 * 80),
  fg: new Uint8Array(24 * 80),
  bg: new Uint8Array(24 * 80),
  eh: new Uint8Array(24 * 80),
  extendedColor: false,
};
let insertMode = false;
let cellW = 8;
let cellH = 16;
let rowEls = [];
let rowSig = [];

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
  // 3270 field attribute bits 4-5: 00 normal, 01 detectable,
  // 10 intensified, 11 non-display.
  const fa = state.attr[i] || 0;
  const disp = fa & 0x0c;
  if (disp === 0x0c) {
    return { fg: colors.background, bg: colors.background, hidden: true };
  }
  const intense = disp === 0x08;
  const normal = disp === 0x00;
  const protectedField = (fa & 0x20) !== 0;
  let fg = PALETTE[state.fg[i]] || null;
  let bg = PALETTE[state.bg[i]] || null;
  if (!fg) {
    if (intense && !protectedField) {
      fg = state.extendedColor ? colors.white : colors.red;
    } else if (intense && protectedField) {
      fg = colors.white;
    } else if (normal && protectedField) {
      fg = state.extendedColor ? colors.green : colors.turquoise;
    } else {
      fg = colors.green;
    }
  }
  if (!bg) {
    bg = colors.background;
  }
  if (state.eh[i] === EH_REVERSE) {
    return { fg: bg, bg: fg, hidden: false };
  }
  return { fg, bg, hidden: false };
}

// Built as DOM nodes rather than markup: the webview CSP forbids inline
// style attributes, but setting style properties from script is allowed.
function makeSpan(style, text) {
  const [fg, bg, underline, blink] = style.split("|");
  const el = document.createElement("span");
  el.textContent = text;
  el.style.color = fg;
  if (bg !== colors.background) {
    el.style.background = bg;
  }
  if (underline === "1") {
    el.style.textDecoration = "underline";
  }
  if (blink === "1") {
    el.className = "blink";
  }
  return el;
}

function buildGrid() {
  for (const el of rowEls) {
    el.remove();
  }
  rowEls = [];
  rowSig = new Array(state.rows).fill(null);
  for (let r = 0; r < state.rows; r++) {
    const row = document.createElement("div");
    row.className = "row";
    gridEl.appendChild(row);
    rowEls.push(row);
  }
}

function paint() {
  if (rowEls.length !== state.rows) {
    buildGrid();
  }
  for (let r = 0; r < state.rows; r++) {
    const runs = [];
    let style = null;
    let run = "";
    for (let c = 0; c < state.cols; c++) {
      const i = r * state.cols + c;
      const { fg, bg, hidden } = cellColor(i);
      const underline = state.eh[i] === EH_UNDERSCORE ? "1" : "0";
      const blink = blinkEnabled && state.eh[i] === EH_BLINK ? "1" : "0";
      const key = `${fg}|${bg}|${underline}|${blink}`;
      const ch = hidden ? " " : state.text[i] || " ";
      if (key === style) {
        run += ch;
      } else {
        if (style !== null) {
          runs.push([style, run]);
        }
        style = key;
        run = ch;
      }
    }
    if (style !== null) {
      runs.push([style, run]);
    }

    // Only touch rows that changed, so an active selection survives updates.
    const signature = runs.map(([s, t]) => `${s}\u0000${t}`).join("\u0001");
    if (rowSig[r] === signature) {
      continue;
    }
    rowSig[r] = signature;
    const row = rowEls[r];
    row.textContent = "";
    for (const [runStyle, runText] of runs) {
      row.appendChild(makeSpan(runStyle, runText));
    }
  }
  positionCursor();
}

function positionCursor() {
  cursorEl.style.width = `${cellW}px`;
  cursorEl.style.height = insertMode ? "2px" : `${cellH}px`;
  cursorEl.style.left = `${(state.cursorCol - 1) * cellW}px`;
  cursorEl.style.top = `${
    (state.cursorRow - 1) * cellH + (insertMode ? cellH - 2 : 0)
  }px`;
}

function fit() {
  const w = screenEl.clientWidth || 1;
  const h = screenEl.clientHeight || 1;
  measure.font = `100px ${FONT_STACK}`;
  const ratio = measure.measureText("M").width / 100 || 0.6;

  let fontSize = Math.floor(
    Math.min(w / state.cols / ratio, h / state.rows / LINE_RATIO)
  );
  fontSize = Math.max(fontSize, 8);
  cellW = fontSize * ratio;
  cellH = Math.round(fontSize * LINE_RATIO);

  gridEl.style.font = `${fontSize}px/${cellH}px ${FONT_STACK}`;
  gridEl.style.width = `${state.cols * cellW}px`;
  gridEl.style.height = `${state.rows * cellH}px`;
  for (const row of rowEls) {
    row.style.height = `${cellH}px`;
  }
  positionCursor();
}

function setOia() {
  const lock = document.getElementById("oia-lock");
  lock.textContent = state.lock ? "X" : "A";
  lock.className = state.lock ? "locked" : "unlocked";
  document.getElementById("oia-ins").textContent = insertMode ? "INS" : "REP";
  document.getElementById("oia-pos").textContent =
    `${state.cursorRow},${state.cursorCol}`;
  document.getElementById("oia-size").textContent =
    `${state.rows}x${state.cols}`;
  document.getElementById("oia-color").textContent = state.extendedColor
    ? "EXT COLOR"
    : "BASE COLOR";
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg.op === "screen") {
    const resized = msg.rows !== state.rows || msg.cols !== state.cols;
    state = {
      rows: msg.rows,
      cols: msg.cols,
      cursorRow: msg.cursorRow,
      cursorCol: msg.cursorCol,
      lock: msg.lock,
      text: msg.text,
      attr: decodeB64(msg.attr),
      fg: decodeB64(msg.fg),
      bg: decodeB64(msg.bg),
      eh: decodeB64(msg.eh),
      extendedColor: msg.extendedColor,
    };
    document.getElementById("oia-msg").textContent = msg.lock ? "X SYSTEM" : "";
    if (resized) {
      buildGrid();
    }
    fit();
    paint();
    setOia();
  } else if (msg.op === "status") {
    if (msg.seslost) {
      document.getElementById("oia-msg").textContent = msg.reason
        ? `SESSION LOST — ${msg.reason}`
        : "SESSION LOST";
    } else if (msg.connected) {
      document.getElementById("oia-msg").textContent = msg.tls
        ? "TLS"
        : "CONNECTED";
    } else {
      document.getElementById("oia-msg").textContent = "DISCONNECTED";
    }
    state.lock = msg.lock;
    setOia();
  } else if (msg.op === "config") {
    colors = { ...DEFAULT_COLORS, ...(msg.colors || {}) };
    blinkEnabled = msg.blink === true;
    if (msg.keymap) {
      keymap = msg.keymap;
    }
    applyColors();
    rowSig.fill(null);
    paint();
  } else if (msg.op === "focus") {
    screenEl.focus();
  } else if (msg.op === "transfer") {
    // The screen does not update while IND$FILE runs, so say why.
    document.getElementById("oia-msg").textContent =
      msg.state === "start" ? "FILE TRANSFER IN PROGRESS" : "";
  } else if (msg.op === "error") {
    const first =
      String(msg.message || "error")
        .split("\n")
        .find((l) => l.trim()) || "error";
    document.getElementById("oia-msg").textContent =
      first.length > 240 ? `${first.slice(0, 240)}…` : first;
  }
});

function hasSelection() {
  const sel = window.getSelection();
  return Boolean(sel && !sel.isCollapsed && sel.toString().length);
}

const KEY_ALIASES = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  PageUp: "pageup",
  PageDown: "pagedown",
  Escape: "escape",
  " ": "space",
};

function chordFor(e) {
  const key = KEY_ALIASES[e.key] || e.key.toLowerCase();
  let chord = "";
  if (e.ctrlKey) {
    chord += "ctrl+";
  }
  if (e.altKey) {
    chord += "alt+";
  }
  if (e.shiftKey) {
    chord += "shift+";
  }
  if (e.metaKey) {
    chord += "meta+";
  }
  return chord + key;
}

function setInsert(on) {
  insertMode = on;
  vscode.postMessage({ op: "insert", value: insertMode });
  setOia();
  positionCursor();
}

function runAction(action) {
  const sep = action.indexOf(":");
  const kind = sep === -1 ? action : action.slice(0, sep);
  const value = sep === -1 ? "" : action.slice(sep + 1);
  if (kind === "aid" || kind === "nav") {
    vscode.postMessage({ op: "key", type: kind, value });
  } else if (kind === "macro") {
    vscode.postMessage({ op: "macro", name: value });
  } else if (kind === "local" && value === "insert") {
    setInsert(!insertMode);
  } else if (kind === "local" && value === "reset") {
    // Reset is an operator function: it unlocks the keyboard and leaves
    // insert mode without sending anything to the host.
    setInsert(false);
    document.getElementById("oia-msg").textContent = "";
  }
}

screenEl.addEventListener("keydown", (e) => {
  // Clipboard and select-all belong to the editor. Ctrl+C only means ATTN
  // when there is nothing to copy.
  if ((e.ctrlKey || e.metaKey) && ["c", "a", "v", "x"].includes(e.key.toLowerCase())) {
    if (e.key.toLowerCase() === "c" && !hasSelection()) {
      e.preventDefault();
      runAction("aid:attn");
    }
    return;
  }

  const action = keymap[chordFor(e)];
  if (action) {
    e.preventDefault();
    runAction(action);
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

function cellFromEvent(e) {
  const rect = gridEl.getBoundingClientRect();
  const col = Math.min(
    state.cols,
    Math.max(1, Math.floor((e.clientX - rect.left) / cellW) + 1)
  );
  const row = Math.min(
    state.rows,
    Math.max(1, Math.floor((e.clientY - rect.top) / cellH) + 1)
  );
  return { row, col };
}

// Dragging selects text; a plain click still positions the 3270 cursor.
gridEl.addEventListener("mouseup", (e) => {
  screenEl.focus();
  if (e.detail === 2) {
    const { row, col } = cellFromEvent(e);
    vscode.postMessage({ op: "click", row, col, double: true });
    return;
  }
  if (hasSelection()) {
    return;
  }
  const { row, col } = cellFromEvent(e);
  vscode.postMessage({ op: "click", row, col, double: false });
});

document.addEventListener("paste", (e) => {
  const text = e.clipboardData ? e.clipboardData.getData("text") : "";
  if (text) {
    e.preventDefault();
    vscode.postMessage({ op: "paste", text });
  }
});

window.addEventListener("resize", () => {
  fit();
});

// The command palette, notifications and dialogs all take focus away. VS Code
// hands it back to the webview document but not to the element listening for
// keys, so without this the 3270 stays deaf until the user clicks it.
window.addEventListener("focus", () => {
  screenEl.focus();
});

applyColors();
buildGrid();
fit();
paint();
setOia();
screenEl.focus();
