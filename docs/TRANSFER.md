# File transfer (IND$FILE)

**TNZ 3270: Download File from Host** and **TNZ 3270: Upload File to Host**
transfer files over the 3270 session using IND$FILE. Both are also buttons on
the session tab's title bar.

## Before you start

IND$FILE is a host command, and the extension runs it by typing it at the
cursor. The session must be at a ready prompt with the keyboard unlocked:

- TSO **READY**
- ISPF **option 6** (Command)
- CMS ready prompt

From a panel or an editor the command text just lands in a field, nothing
happens, and the transfer fails on the idle timeout. The download and upload
commands refuse to start if the keyboard is locked, but they cannot tell a
ready prompt from any other unlocked screen.

## Text or binary

You are asked for this each time.

**Text** sends `ASCII CRLF`. tnz spots that pair and does the EBCDIC
translation itself rather than letting the host do it, because host translation
tables mishandle some characters — `|` is the usual casualty. Host records
become lines. This is what you want for source, JCL and reports.

**Binary** copies bytes unchanged. Nothing is translated and no record
structure is preserved, so a download gives you the raw bytes with no
indication of where the host's records ended. Use it for load modules and
anything already compressed.

The code page used for text is the host profile's `codePage`.

## Host file names

The name is passed to IND$FILE untouched, so use whatever the host expects:

| Host | Example |
| --- | --- |
| TSO dataset | `'USERID.SOURCE(MYPROG)'` |
| TSO, prefix added by the host | `SOURCE(MYPROG)` |
| CMS | `PROFILE EXEC A` |

## Options

The options prompt is passed through to IND$FILE inside parentheses. Useful
ones when uploading to a dataset that does not exist yet:

```
RECFM(F) LRECL(80) BLKSIZE(3120)
RECFM(V) LRECL(255)
APPEND
```

`ASCII` and `CRLF` are added for you in text mode; do not repeat them.

Set `tnzView.transfer.options` to pre-fill the prompt with the options you
usually want.

## While a transfer runs

The screen does not update and keystrokes are ignored, because tnz owns the
session for the duration. The status line shows `FILE TRANSFER IN PROGRESS`.

There is no way to abort an IND$FILE transfer in progress, so the progress
notification has no Cancel button. If the host stops responding for
`tnzView.transfer.idleTimeout` seconds (60 by default) the transfer gives up
and the session returns to normal. The clock resets whenever data moves, so a
slow but healthy transfer will not trip it.

## Host-initiated transfers

tnz can accept transfers the host starts by itself. That is left switched off,
so a host cannot read or write files on your machine without you asking for a
transfer first.

## Failures

The completion message from IND$FILE is reported as-is. `TRANS03` means
success; anything else is an error and the text explains it.

| Symptom | Cause |
| --- | --- |
| "the keyboard is locked" | Not at a ready prompt, or the host still owes a reply |
| "no response from IND$FILE" | The command went into a field instead of being run |
| `TRANS13` and similar | The host rejected the request; the message says why |
| "the session was lost" | The connection dropped mid-transfer |

Partial files are left on disk after a failed download; check before reusing
them.
