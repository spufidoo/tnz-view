# TNZ 3270

Native 3270 terminal view for VS Code and Cursor. Hosts live in the left activity bar; sessions open as editor tabs with a fixed 3270 grid (not a VT terminal).

The TN3270 protocol is handled by [IBM tnz](https://github.com/IBM/tnz) in a Python sidecar. This repo does not vendor tnz.

## Prerequisites

- Python 3.10 or later
- `pip install tnz ebcdic`
- VS Code or Cursor 1.85+

Optional: point `tnzView.tnzPath` at a local IBM/tnz checkout while developing.

## Setup

```console
cd tnz-view
npm install
npm run compile
```

Press **F5** (Run Extension) from this folder, or install the folder as an unpacked extension.

Open the **TNZ 3270** icon in the activity bar → **Add Host** → Connect.

## Host profiles

Saved in `tnzView.hosts` (user settings). Fields:

| Field | Meaning |
| --- | --- |
| host / port | Default ports: 992 TLS, 23 plain |
| secure / verifyCert | TLS and certificate checking |
| psSize | `24x80`, `32x80`, `43x80`, `27x132`, `62x160`, … |
| codePage | EBCDIC code page, e.g. `037` |
| luName / tn3270e | LU name requires TN3270E |
| secLevel | Set to `1` for older TLS stacks (`ZTI_SECLEVEL`) |

Passwords are not stored. Log on in the 3270 screen.

## Keys (3270 tab focused)

| Key | Action |
| --- | --- |
| F1–F12 | PF1–PF12 |
| Shift+F1–F12 | PF13–PF24 |
| Enter | ENTER |
| Tab / Shift+Tab | Tab / Backtab |
| Insert | Toggle insert |
| Home, arrows, Backspace, Delete | Cursor / edit |
| Ctrl+Home | Erase EOF |
| Pause | CLEAR |
| Alt+A or Ctrl+C (no selection) | ATTN |
| Click / double-click | Cursor / cursor + ENTER |
| Drag | Select text |
| Ctrl+C (with selection) | Copy |
| Ctrl+V | Paste into fields |

The webview scales the font so the whole 3270 screen fits. Resizing the editor does not change rows×cols.

Screen text is rendered as real text, so it can be selected and copied with the
usual shortcuts. Non-display fields (passwords) are blanked in the sidecar, so
they never reach the webview and cannot be copied.

## Colour

Basic colours come from the field attribute (protected/intensified). When the host
sends extended colour orders, tnz switches the screen into extended colour mode and
the full seven-colour palette plus reverse video and underscore are used. The status
line shows `BASE COLOR` or `EXT COLOR` so you can tell which set is in play.

## Layout

```
src/           TypeScript extension (tree, sidecar client, session tabs)
media/         3270 webview CSS/JS
sidecar/       Python JSON-lines process wrapping tnz.Tnz
```

Apache-2.0. See `NOTICE` for the tnz attribution.
