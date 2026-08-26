# Development history

This is a record of the Cursor chat that produced tnz-view (20–26 August 2026),
not a transcript dump. Tool calls, screenshots and log attachments are omitted;
the decisions and the bugs that drove them are not.

The extension lives at [https://github.com/spufidoo/tnz-view](https://github.com/spufidoo/tnz-view).
It uses [IBM tnz](https://github.com/IBM/tnz) at runtime and does not vendor it.

## Why this exists

The starting point was a clone of IBM/tnz and the question whether it could
become a VS Code or Cursor extension. tnz already speaks TN3270, including
extended colour, file transfer and a character-cell API. What it does not
provide is an editor UI.

Two fronts were considered: zti's curses terminal (easy, wrong for an editor)
and a native 3270 webview driven by tnz's `Tnz` object (harder, what was
wanted). The native view won. Hosts were to live in the activity bar; sessions
as editor tabs with a fixed 3270 grid, not a VT terminal.

A separate repository was recommended so the extension would not sit inside
the IBM/tnz checkout. It was built in this workspace, then moved to
`spufidoo/tnz-view`.

Architecture that stuck from the first build:

- TypeScript extension for the tree, settings, commands and webview.
- A Python sidecar wrapping `tnz.Tnz`, talking JSON-lines over stdin/stdout.
  One process, one worker thread per session.
- Secrets stay out of settings; passwords are typed on the 3270 screen.

## 20–21 August — scaffold

First working extension: host list, connect, webview screen, PF keys, ATTN,
basic colour from field attributes. Packaged and installed in Cursor and VS
Code.

## 24 August — first real session

### Sidecar would not start

tnz tried to write `tnz.log` into the editor install directory (`C:\Program
Files\cursor`), which is not writable. The sidecar now logs under
`TNZ_VIEW_LOG_DIR` (the extension's global storage) or disables tnz file
logging. The process is spawned with a writable cwd. A log channel was added
so errors are copyable.

### Canvas vs text

The first screen was a `<canvas>`. Text could not be selected. It was rewritten
as a DOM grid (`div` rows, `span` runs) so copy and paste work. The webview CSP
forbids inline `style` attributes; colours are set from script via CSSOM.

`Ctrl+C` copies when there is a selection and sends ATTN when there is not.

### Hidden fields and colour

The logon password was visible. tnz does read the non-display bit; the sidecar
was not applying field attributes across the buffer. `_effective_planes`
propagates field attributes and extended colour/highlight, and `_mask_hidden`
blanks non-display fields before they reach the webview.

The first paint was green on black. Field-attribute colour (protected /
intensified) was implemented with a PCOMM-like palette, then compared against
screenshots of a real emulator. Extended colour mode followed: advertise
colour in the 3270 query reply (`capable_color`) so the host sends extended
colour orders; the status line shows `BASE COLOR` or `EXT COLOR`. APL /
box-drawing glyphs needed `cp310` loaded in the sidecar.

Windows pipes defaulted to cp1252, so those glyphs crashed the sidecar with
`UnicodeEncodeError`. stdin/stdout/stderr are reconfigured to UTF-8, and
`PYTHONIOENCODING=utf-8` is set on spawn. Screen-update errors are caught so
one bad paint cannot kill the session thread.

### Host editor

Sequential input boxes for host fields were replaced by a settings tab: all
fields, extended colour, blink, and a live palette. Saving a profile repaints
open sessions for colour and blink; geometry and TLS still need a reconnect.

That day's colour and editor work was committed and pushed on request.

## 25 August — reconnect, keys, files, macros

### Session lost on TSO reconnect

Reconnecting to an existing TSO session failed with `TnzTerminalError: Invalid
address`. The host was writing past the end of the client buffer because the
session geometry had been set by another emulator (PCOMM at `30x133`) and
TN3270E does not renegotiate it. Columns must match exactly; rows may be
higher.

The host editor's screen size became free text with a datalist of standard
models. A Unicode multiplication sign (`30×133`) failed `_util.session_ps_size`;
both the sidecar and the editor now accept `×`. Lost-session messages started
explaining the address error instead of discarding the exception.

### Keymap

Keys were an `if/else` chain in the webview. They became a chord → action
table (`src/keymap.ts`), overridable with `tnzView.keymap`. Missing keys were
added as table entries: PA1–3, Clear, End, word left/right, Erase Input, New
Line, Reset. Reset is local (leave insert, clear the status); it cannot
unlock a host-held keyboard.

**TNZ 3270: Show Keyboard Map** lists the bindings in effect. Chord syntax,
AID vs nav vs local, and reserved keys are in [docs/KEYMAP.md](docs/KEYMAP.md).
DUP and Field Mark were left out: they insert EBCDIC controls rather than
calling a tnz key function.

### IND$FILE

Download and upload commands wrap `tnz.get_file` / `put_file` on the session
thread, because tnz drives its own wait loop. The session must be at a ready
prompt; the command is typed at the cursor. An idle timeout stops the loop
spinning forever when IND$FILE never starts. Host-initiated transfers stay
disabled.

Text mode needs `ASCII` and `CRLF` as whole words so tnz does the translation
itself (the host's tables mangle `|`). The first parameter builder wrapped
options in `(`, which is CMS convention. TSO answered `IKJ56712I INVALID
KEYWORD, (`. TSO now gets bare keywords; `tnzView.transfer.syntax` selects
`tso` (default) or `cms`. Walkthrough: [docs/TRANSFER.md](docs/TRANSFER.md).

Title-bar transfer buttons were declared but easy to miss; the commands stay
in the palette even with no session focused, and they say so rather than
vanishing. `tnzView.sessionActive` was only set from `onDidChangeViewState`,
which does not fire when a panel is created, so a new session counted as
inactive until the user clicked away and back.

### Macros

Named sequences in `tnzView.macros`, played from a key (`macro:<name>`) or
**Run Macro**. Syntax is text with `[action]` markers, e.g.
`=3.4[enter][wait]MY.JCL[enter]`. `[wait]` blocks on the keyboard lock rather
than a guessed delay. Macros run on the session thread so typing cannot
interleave. Passwords should not go in settings (plain text, often synced).
A separate `MACROS.md` was declined; KEYMAP.md covers them.

After Run Macro from the palette, the 3270 ignored keys until a click. The
palette returns focus to the webview document, not to `#screen`. The webview
now focuses that element whenever the window regains focus.

## 26 August — polish and TLS

### Field attribute column

An underscored input field looked one column too wide on the left. Every
buffer position inherited the nearest field's extended highlighting,
including the attribute byte itself. That byte occupies a screen position but
belongs to no field; a 3270 shows it as a plain blank. It now keeps default
planes while still setting what following positions inherit.

### TLS mismatch

Connecting to `www.moshix.tech:2023` dropped immediately with SESSION LOST.
The port speaks TLS (`DO TERMINAL-TYPE` after a TLS handshake; the
certificate validates). Connect had been reporting `connection lost during
connect` and dropping the exception.

Failures now keep the original exception (and wrapped SSL causes) and add a
sentence for TLS vs plain, certificate verification, refused, reset, timeout,
DNS, and oversized screens. A handshake that never completes times out with
that explanation instead of claiming success.

## What was left on purpose

- DUP / Field Mark keys.
- Host-initiated IND$FILE.
- Per-host macros.
- A chord-capture or editable keymap UI (the setting and Show Keyboard Map
  were enough).
- Title-bar transfer icons, if they still fail to appear; the palette commands
  are the supported path.

Current packaged version at the end of this chat: **0.3.5**.
