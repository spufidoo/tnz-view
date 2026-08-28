# Macros

A macro is a string of text with `[action]` markers in it, the notation
emulators have used for this for decades. Define them in `tnzView.macros` and
play them from a key or from **TNZ 3270: Run Macro**.

```json
"tnzView.macros": {
  "listcat": "LISTC[enter]",
  "back to primary": "[pf3][pf3][pf3]",
  "edit jcl": ["=3.4[enter][wait]", "MY.JCL[enter]"],
  "logon": "[home][prompt:Userid][enter][wait][password:Password][enter]"
},
"tnzView.keymap": {
  "ctrl+l": "macro:listcat",
  "ctrl+alt+l": "macro:logon"
}
```

This is a **keystroke tape**: it types, moves the cursor, sends AID keys, waits
for the keyboard to unlock, and can ask you for values *before* it starts. It
is not a program. There is no `if`, no reading the screen, no `OnScreen`, no
click-the-word-under-the-cursor, and no stopping mid-run to ask a second
question after ENTER. Those belong to emulators with a macro language (Vista
TN3270, for example), not to this setting.

## How to run one

A 3270 session tab must be focused.

| How | What happens |
| --- | --- |
| Command palette → **TNZ 3270: Run Macro** | Pick a name from `tnzView.macros` |
| A keymap chord `macro:<name>` | Same, without the picker |
| The 3270 tab's command palette while that tab is active | Same as Run Macro |

If no macros are defined, Run Macro offers to open the `tnzView.macros` setting.
If the named macro is missing or the markers do not parse, a toast names the
problem and nothing is typed.

Open **Keyboard Shortcuts** if a chord you bound never fires: the editor or
another extension may be claiming it first. See [KEYMAP.md](KEYMAP.md).

## How to define one

User `settings.json`, under `tnzView.macros`. Each key is the name you pick in
Run Macro and the name you put after `macro:` in the keymap.

The value is either a string, or an **array of strings joined with no
separator**. The array is only there so a long sequence stays readable; it is
not a list of independent macros.

```json
"tnzView.macros": {
  "one line": "LISTC[enter]",
  "split only for reading": [
    "=3.4[enter][wait]",
    "MY.JCL[enter][wait]",
    "S[enter]"
  ]
}
```

Anything outside `[...]` is typed into the field the cursor is in, exactly as
if you had pressed those keys. Markers are substituted as the steps below.

`[[` is a literal `[`. There is no escape for `]`.

Marker names are case-insensitive (`[Enter]` and `[enter]` are the same).
Labels on `[prompt:]` and `[password:]` keep the capitalisation you wrote.

## Execution

1. The source is parsed. A bad marker aborts here; the session is untouched.
2. Every `[prompt:]` and `[password:]` is asked, in order, **before** the first
   character is typed. Dismissing any box with Escape abandons the whole macro.
3. The resulting steps are replayed on the session thread as one batch, so your
   keystrokes cannot interleave with it.
4. If a step fails or a `[wait]` times out, the macro stops there. The status
   line names the step number.
5. Focus returns to the 3270 when the prompts (if any) are done.

Because the replay is one batch, a prompt cannot depend on what the host showed
after an ENTER. Ask everything you will need up front, then type.

## Primitives

### Literal text

Typed into the current input field with the session's insert/replace mode.

| Example | Result |
| --- | --- |
| `LISTC` | Types `LISTC` |
| `TSO LISTA` | Types that, including the space |
| `LOGON `[prompt:Userid] | Types `LOGON `, then the answer |

Protected fields reject the key, same as typing by hand. Put `[home]` or
`[tab]` first if the cursor might not be in the field you mean.

### AID keys — talk to the host

Each of these sends an AID, then locks the keyboard until the host replies.
Follow one with `[wait]` unless it is the last step.

| Marker | AID |
| --- | --- |
| `[enter]` | ENTER |
| `[pf1]` … `[pf24]` | PF1–PF24 |
| `[pa1]` `[pa2]` `[pa3]` | PA1–PA3 (no field changes) |
| `[clear]` | CLEAR |
| `[attn]` | ATTN |

There is no `[reset]` here. Reset is a local view action (`local:reset` on a
key). It is not a macro step, and it would not clear `X SYSTEM` anyway — only
the host can unlock that.

### Cursor and edit keys — local to the buffer

Nothing is sent to the host. These change what the next AID will carry.

| Marker | Meaning |
| --- | --- |
| `[left]` `[right]` `[up]` `[down]` | Cursor one position |
| `[home]` | First input field |
| `[end]` | End of the current field |
| `[wordleft]` `[wordright]` | Previous / next word |
| `[tab]` `[backtab]` | Next / previous input field |
| `[newline]` | First field on the next line |
| `[backspace]` | Delete the character to the left |
| `[delete]` | Delete the character under the cursor |
| `[eraseeof]` | Erase from the cursor to the end of the field |
| `[eraseinput]` | Erase every unprotected field |

### Wait for the host

| Marker | Meaning |
| --- | --- |
| `[wait]` | Wait until the keyboard unlocks, up to 10 seconds |
| `[wait:5000]` | The same, timeout in milliseconds |

Use this after every AID that is not the last step. The wait returns as soon as
the host unlocks; it does **not** look at the screen text. A password panel and
an error panel both unlock the keyboard, and `[wait]` cannot tell them apart.

If the host never unlocks, the macro stops with a timeout on that step.

### Fixed delay

| Marker | Meaning |
| --- | --- |
| `[pause:500]` | Sleep 500 milliseconds, host or not |

`[pause]` with no time is an error. Prefer `[wait]` after AIDs. `[pause]` is
for hosts that unlock the keyboard before the screen you care about has
finished painting — a last resort, not a substitute for `[wait]`.

### Ask, then type

| Marker | Meaning |
| --- | --- |
| `[prompt:Label]` | Input box; answer is typed as text |
| `[prompt]` | Same, label defaults to `Value` |
| `[password:Label]` | Masked box; answer is not remembered |
| `[password]` | Same, label defaults to `Password` |

The label is the prompt on the box. A colon in the label is allowed
(`[prompt:User ID: TSO]`). Leading and trailing spaces around the label are
stripped.

Answers to `[prompt:...]` with the **same label** are offered back as the
default next time in this editor session. That lives only in memory; it is not
written to settings. `[password:...]` answers are never kept, not even for the
next run.

Never put a password in `tnzView.macros` itself. Settings files are plain text
and sync between machines. `[password:...]` exists so you do not have to.

### Literal `[`

| Marker | Meaning |
| --- | --- |
| `[[` | One `[` character in the typed text |

## What is not a primitive

These look as if they might work and do not:

| You might write | What actually happens |
| --- | --- |
| `[reset]` `[insert]` | Parse error — not AID or nav names |
| `[wait:Password]` | Parse error — wait takes milliseconds |
| `[if]` `[onscreen:…]` | Parse error |
| A password in the JSON | Typed in the clear, stored in settings, synced |

Keymap-only actions (`local:insert`, `local:reset`) have no macro spelling.

## Examples

**One TSO command at READY**

```json
"lista": "TSO LISTA[enter]"
```

Drop the `TSO ` prefix if you are already at the READY prompt rather than an
ISPF command line.

**ISPF jump, then wait, then type**

```json
"edit jcl": "=3.4[enter][wait]MY.JCL[enter]"
```

Without `[wait]`, `MY.JCL` is typed while the keyboard is still locked and the
step fails with Input Inhibit.

**Leave ISPF**

```json
"back to primary": "[pf3][wait][pf3][wait][pf3]"
```

**Logon, userid and password asked, nothing stored**

```json
"logon": "[home][prompt:Userid][enter][wait][password:Password][enter]"
```

`[home]` pins the cursor to the first field. Both boxes appear before anything
is typed. Escape on the password box types nothing at all.

**LOGON command with the userid in the same field**

```json
"logon tso": "LOGON [prompt:Userid][enter][wait][password:Password][enter]"
```

**Clear a field, then type**

```json
"replace field": "[home][eraseeof]NEW.NAME[enter]"
```

**A PF key, then another**

```json
"split": "[pf2][wait]"
```

## Troubleshooting

**`macro "…": [foo] is not a known action`.** The name is not in the tables
above. Check spelling (`[password]`, not `[passwrod]`). Reload the window if
you just installed a build that added `[prompt]` / `[password]` — an older
extension reports those as "does not take a value".

**`[wait]` times out.** The host never unlocked. You may not have been at a
screen that accepts the AID you sent, or the host is slow: try `[wait:30000]`.

**Input Inhibit on a later step.** An AID was not followed by `[wait]`, so the
macro typed while the keyboard was locked.

**The typed text landed in the wrong field.** The tape uses wherever the cursor
is. Start with `[home]` or `[tab]`.

**I have to click the 3270 to type afterwards.** That was a bug in older
builds; current ones return focus after Run Macro and after prompts. Reload
the extension if you still see it.

**The password appeared on the screen.** The host field is not a 3270
non-display field. The sidecar only blanks fields the host marked hidden;
`[password:]` only masks the *box you type into*.

## Related

- [KEYMAP.md](KEYMAP.md) — chords, including `macro:<name>`
- [TRANSFER.md](TRANSFER.md) — IND$FILE is a command, not a macro
