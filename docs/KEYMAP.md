# Keyboard map

Bindings apply while a 3270 tab has focus. Run **TNZ 3270: Show Keyboard Map**
from the command palette to see the ones actually in effect, including your own
overrides.

## Changing bindings

Add `tnzView.keymap` to your user `settings.json`. Each entry maps a chord to an
action:

```json
"tnzView.keymap": {
  "escape": "aid:pa2",
  "ctrl+shift+e": "nav:eraseinput",
  "shift+escape": "local:reset",
  "ctrl+l": "macro:listcat",
  "pause": ""
}
```

Entries are merged over the defaults, so list only what differs. An empty string
removes a default, which is how you hand a chord back to the editor when the two
are fighting over it. Open sessions apply changes as soon as you save; no
reconnect or reload.

## Chord syntax

A chord is modifiers followed by a key name, all lower case:

```
ctrl+alt+shift+meta+<key>
```

Modifiers must appear in that order, and only the ones you need. The key name is
the browser's `event.key` lower-cased, with these substitutions:

| Key | Name |
| --- | --- |
| Arrow keys | `left` `right` `up` `down` |
| Space bar | `space` |
| Page Up / Page Down | `pageup` `pagedown` |
| Esc | `escape` |

Everything else is the obvious lower-case name: `a`, `7`, `f9`, `enter`, `tab`,
`home`, `end`, `insert`, `delete`, `backspace`, `pause`.

Use `shift+` only for keys where Shift does not already change the character.
`shift+f3` and `shift+tab` are right; a shifted letter arrives as that letter, so
bind `a`, not `shift+a`.

## Actions

### `aid:` — send an AID and unlock

Sends the key to the host and waits for the reply.

| Action | Meaning |
| --- | --- |
| `aid:enter` | ENTER |
| `aid:clear` | CLEAR |
| `aid:attn` | ATTN |
| `aid:pa1` `aid:pa2` `aid:pa3` | Program attention 1–3 |
| `aid:pf1` … `aid:pf24` | Program function 1–24 |

### `nav:` — move the cursor or edit the screen

Local to the screen buffer; nothing is sent to the host.

| Action | Meaning |
| --- | --- |
| `nav:left` `nav:right` `nav:up` `nav:down` | Cursor one position |
| `nav:home` | First input field |
| `nav:end` | End of the current field |
| `nav:wordleft` `nav:wordright` | Previous / next word |
| `nav:tab` `nav:backtab` | Next / previous input field |
| `nav:newline` | First field on the next line |
| `nav:backspace` | Delete the character to the left |
| `nav:delete` | Delete the character under the cursor |
| `nav:eraseeof` | Erase from the cursor to the end of the field |
| `nav:eraseinput` | Erase every unprotected field |

### `local:` — handled by the view

| Action | Meaning |
| --- | --- |
| `local:insert` | Toggle insert mode |
| `local:reset` | Leave insert mode and clear the status message |

Reset sends nothing to the host, so it clears the view's own state but not a lock
the host is holding. If the status line shows `X SYSTEM`, the host has the
keyboard and only the host can give it back.

### `macro:` — play a named macro

`macro:<name>` runs an entry from `tnzView.macros`. See
[macros](#macros) below.

## Defaults

| Chord | Action |
| --- | --- |
| `f1` … `f12` | PF1–PF12 |
| `shift+f1` … `shift+f12` | PF13–PF24 |
| `enter` | ENTER |
| `alt+1` `alt+2` `alt+3` | PA1, PA2, PA3 |
| `alt+c`, `pause` | CLEAR |
| `alt+a` | ATTN |
| `tab`, `shift+tab` | Tab, backtab |
| `left` `right` `up` `down` | Cursor movement |
| `home` | First input field |
| `end` | End of field |
| `alt+left` `alt+right` | Word left, word right |
| `backspace` `delete` | Edit |
| `ctrl+home`, `shift+end` | Erase to end of field |
| `alt+delete` | Erase input |
| `ctrl+enter` | New line |
| `insert` | Toggle insert mode |
| `ctrl+r` | Reset |

Defaults follow [zti](https://github.com/IBM/tnz), the terminal front end shipped
with tnz, wherever the two overlap.

## Macros

A macro is a string of text with `[action]` markers in it, the notation
emulators have used for this for decades. Define them in `tnzView.macros` and
play them from a key or from **TNZ 3270: Run Macro**.

```json
"tnzView.macros": {
  "listcat": "LISTC[enter]",
  "back to primary": "[pf3][pf3][pf3]",
  "edit jcl": ["=3.4[enter][wait]", "MY.JCL[enter]"]
},
"tnzView.keymap": {
  "ctrl+l": "macro:listcat",
  "ctrl+alt+p": "macro:back to primary"
}
```

An array of strings is joined without a separator, which is only there to keep
long macros readable.

### Markers

| Marker | Meaning |
| --- | --- |
| `[enter]` `[clear]` `[attn]` `[pa1]`–`[pa3]` `[pf1]`–`[pf24]` | Send an AID |
| `[tab]` `[home]` `[eraseeof]` and the rest of the `nav:` names | Cursor and edit keys |
| `[wait]` | Wait for the host to unlock the keyboard, up to 10 seconds |
| `[wait:5000]` | The same, with an explicit timeout in milliseconds |
| `[pause:500]` | Wait a fixed number of milliseconds |
| `[[` | A literal `[` |

Anything outside the markers is typed into the current field.

### Waiting

Use `[wait]`, not `[pause:...]`, after anything that talks to the host. Sending
an AID locks the keyboard until the host replies, so `[wait]` returns as soon as
the new screen arrives rather than guessing at a duration.

A macro runs to completion on the session thread, so your keystrokes cannot
interleave with it. If a step fails or a `[wait]` times out, the macro stops
there and the status line names the step number.

### Passwords

Do not put passwords in a macro. Settings files are stored in plain text and
sync between machines. Type the password yourself; a macro can still get you to
the right screen and leave the cursor in the field.

## Reserved keys

These are handled before the keymap is consulted and cannot be rebound:

| Chord | Behaviour |
| --- | --- |
| `ctrl+c` | Copy when text is selected, ATTN when it is not |
| `ctrl+v` | Paste into fields |
| `ctrl+x` `ctrl+a` | Left to the editor |

Any printable key with no binding and no Ctrl, Alt or Meta is typed into the
current field.

## Mouse

| Action | Result |
| --- | --- |
| Click | Move the cursor |
| Double-click | Move the cursor and send ENTER |
| Drag | Select text |

## Troubleshooting

**A chord does nothing.** The editor or the window manager may be claiming it
before the webview sees it. Check Keyboard Shortcuts for a conflicting VS Code
command, or pick a different chord. `alt+` chords open menus on some Linux
desktops.

**A chord does the wrong thing.** Open **Show Keyboard Map** and confirm your
override is listed. A typo in the chord adds a new binding rather than replacing
one, so the default stays in place.

**An action name is rejected.** Names are case-sensitive and take the form
`kind:name` from the tables above. An unknown `aid:` or `nav:` name surfaces as
an error on the status line when you press the key.
