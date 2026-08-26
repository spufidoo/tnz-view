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

**Add Host**, or **Edit Host** from a host's context menu, opens a settings tab with
every field on one page. Ctrl+S saves. Profiles are stored in `tnzView.hosts` (user
settings), so they can also be edited as JSON.

| Field | Meaning |
| --- | --- |
| host / port | Default ports: 992 TLS, 23 plain |
| secure / verifyCert | TLS and certificate checking. A TLS host on a non-standard port still needs Secure on; a mismatch drops the session immediately |
| psSize | Any `rowsxcols`, not just the standard models |
| codePage | EBCDIC code page, e.g. `037` |
| luName / tn3270e | LU name requires TN3270E |
| secLevel | Set to `1` for older TLS stacks (`ZTI_SECLEVEL`) |
| extendedColor | Advertise colour capability to the host |
| blink | Render the blink highlight instead of ignoring it |
| colors | Per-host palette |

Passwords are not stored. Log on in the 3270 screen.

### Screen size

`psSize` must match the emulator that started the session, because the host formats
for the screen size in its LU definition and does not renegotiate it when resuming
one. The columns have to match exactly, since a buffer address is mapped to a row
and column using the column count; the rows may be higher, which just leaves blank
lines at the bottom. Any size is accepted, not only the standard models — a PCOMM
session showing `30x133` needs exactly `30x133` here.

If the size is too small, the host writes past the end of the buffer and tnz drops
the session. The reported address is the *first* one past the end, so it is only a
lower bound and raising the size one model at a time will keep failing.

## Keys (3270 tab focused)

| Key | Action |
| --- | --- |
| F1–F12, Shift+F1–F12 | PF1–PF24 |
| Enter | ENTER |
| Alt+1 / Alt+2 / Alt+3 | PA1 / PA2 / PA3 |
| Alt+C or Pause | CLEAR |
| Alt+A or Ctrl+C (no selection) | ATTN |
| Tab / Shift+Tab | Next / previous field |
| Arrows, Home, End | Cursor movement |
| Alt+Left / Alt+Right | Word left / word right |
| Backspace, Delete | Edit |
| Ctrl+Home or Shift+End | Erase to end of field |
| Alt+Delete | Erase input |
| Ctrl+Enter | New line |
| Insert | Toggle insert |
| Ctrl+R | Reset |
| Click / double-click | Cursor / cursor + ENTER |
| Drag, Ctrl+C, Ctrl+V | Select, copy, paste into fields |

Every binding can be changed with the `tnzView.keymap` setting, and open sessions
pick up edits immediately. **TNZ 3270: Show Keyboard Map** lists what is in
effect.

Keys can also play macros — text with `[action]` markers in it, such as
`=3.4[enter][wait]MY.JCL[enter]`. `[wait]` holds until the host unlocks the
keyboard, so a macro follows the host rather than guessing at delays. Define
them in `tnzView.macros` and run them from a key or **TNZ 3270: Run Macro**.

See [docs/KEYMAP.md](docs/KEYMAP.md) for the chord syntax, every action name,
the macro markers, and the keys that are reserved.

The webview scales the font so the whole 3270 screen fits. Resizing the editor does not change rows×cols.

Screen text is rendered as real text, so it can be selected and copied with the
usual shortcuts. Non-display fields (passwords) are blanked in the sidecar, so
they never reach the webview and cannot be copied.

## File transfer

**TNZ 3270: Download File from Host** and **Upload File to Host**, or the
buttons on the session tab, transfer files with IND$FILE. The session must be
at a ready prompt (TSO READY, ISPF option 6, CMS) because the command is typed
at the cursor.

Text transfers use `ASCII CRLF`, which tnz translates itself rather than
trusting the host's tables; binary copies bytes unchanged. The screen freezes
for the duration and shows `FILE TRANSFER IN PROGRESS`, since tnz owns the
session while a transfer runs.

See [docs/TRANSFER.md](docs/TRANSFER.md) for host file name formats, RECFM and
LRECL options, timeouts, and what the failure messages mean.

## Colour

Basic colours come from the field attribute (protected/intensified). When the host
sends extended colour orders, tnz switches the screen into extended colour mode and
the full seven-colour palette plus reverse video and underscore are used. The status
line shows `BASE COLOR` or `EXT COLOR` so you can tell which set is in play.

The **Colour** section of the host settings tab controls this:

- **Extended colour** advertises colour capability in the 3270 query reply, which is
  what invites the host to send extended colour orders. Turning it off keeps the
  screen on basic field colours, which is useful when a host renders badly in colour.
- **Render the blink attribute** draws blinking fields instead of showing them as
  normal text.
- The palette sets all eight 3270 colour values plus the background, with a live
  preview. Saving repaints any open session for that host immediately; the extended
  colour toggle takes effect on the next connect.

## Layout

```
src/           TypeScript extension (tree, sidecar client, session + settings tabs)
media/         3270 webview and host settings CSS/JS
sidecar/       Python JSON-lines process wrapping tnz.Tnz
docs/          Keyboard map and file transfer references
```

Apache-2.0. See `NOTICE` for the tnz attribution.
