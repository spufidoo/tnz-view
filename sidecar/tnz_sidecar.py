"""JSON-lines sidecar wrapping tnz.Tnz for the TNZ 3270 VS Code extension.

One process, one worker thread per session. Commands arrive on stdin;
events are written to stdout as a single JSON object per line.
"""

from __future__ import annotations

import base64
import json
import os
import queue
import re
import sys
import threading
import time
import traceback

# The protocol is UTF-8 in both directions. On Windows a pipe defaults to the
# ANSI code page, which cannot encode the cp310 box-drawing glyphs ISPF uses.
for _stream in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

# Optional local IBM/tnz checkout (set by the extension).
_tnz_path = os.environ.get("TNZ_VIEW_TNZ_PATH", "").strip()
if _tnz_path:
    sys.path.insert(0, _tnz_path)


def _configure_tnz_logging() -> None:
    """Point tnz at a writable log file.

    tnz ships a logging.json whose filename is relative, so it lands in the
    process working directory. Editors launch us from their install
    directory, which is typically read-only.
    """
    if "TNZ_LOGGING" in os.environ:
        return

    log_dir = os.environ.get("TNZ_VIEW_LOG_DIR", "").strip()
    if not log_dir:
        os.environ["TNZ_LOGGING"] = ""  # disable tnz file logging
        return

    try:
        os.makedirs(log_dir, exist_ok=True)
        config = {
            "version": 1,
            "disable_existing_loggers": False,
            "formatters": {"tnz_format": {"format": "%(asctime)s %(message)s"}},
            "handlers": {
                "tnz_log": {
                    "class": "logging.FileHandler",
                    "encoding": "utf8",
                    "filename": os.path.join(log_dir, "tnz.log"),
                    "formatter": "tnz_format",
                    "mode": "w",
                }
            },
            "loggers": {
                "tnz": {
                    "handlers": ["tnz_log"],
                    "level": os.environ.get("TNZ_VIEW_LOG_LEVEL", "WARN"),
                    "propagate": False,
                }
            },
        }
        config_path = os.path.join(log_dir, "tnz-logging.json")
        with open(config_path, "w", encoding="utf8") as file:
            json.dump(config, file)
        os.environ["TNZ_LOGGING"] = config_path
    except OSError:
        os.environ["TNZ_LOGGING"] = ""


_configure_tnz_logging()

try:
    from tnz.tnz import Tnz, TnzError, TnzTransferError
except ImportError:
    sys.stderr.write(
        "tnz is not installed. Run: pip install tnz ebcdic\n"
    )
    raise SystemExit(2)

_stdout_lock = threading.Lock()
_sessions: dict[str, "Session"] = {}
_sessions_lock = threading.Lock()


def emit(payload: dict) -> None:
    line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    with _stdout_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def b64(data: bytes | bytearray) -> str:
    return base64.b64encode(bytes(data)).decode("ascii")


# Standard 3270 screen sizes, smallest buffer first. 132- and 160-column
# models come after the 80-column ones so a suggestion keeps the current
# width where it can.
_MODELS = ((24, 80), (32, 80), (43, 80), (27, 132), (24, 132), (62, 160))


def _suggest_sizes(address: int, cols: int) -> list[str]:
    """Standard sizes big enough to hold the address the host asked for."""
    need = address + 1
    same = [f"{r}x{c}" for r, c in _MODELS if c == cols and r * c >= need]
    wider = [f"{r}x{c}" for r, c in _MODELS if c != cols and r * c >= need]
    return same[:1] + wider[:1] or ["62x160"]


def _deadline_wait(tns, idle_seconds: float):
    """A tns.wait that gives up once the transfer stops making progress.

    get_file and put_file poll wait() until the host sends a DDM message. If
    IND$FILE never starts -- the command was typed somewhere that is not a
    ready prompt, so it went into a field instead -- that loop spins forever
    and takes the session thread with it. Raising from wait() unwinds through
    their try/finally, which is the only way in from outside.
    """
    original = type(tns).wait
    deadline = time.monotonic() + idle_seconds

    def wait(timeout=None, zti=None, key=None):
        nonlocal deadline
        if tns.ddm_in_progress():
            deadline = time.monotonic() + idle_seconds
        elif time.monotonic() > deadline:
            raise TnzTransferError(
                f"no response from IND$FILE for {idle_seconds:g} seconds"
            )
        return original(tns, timeout=timeout, zti=zti, key=key)

    return wait


def _transfer_reason(exc: Exception, tns) -> str:
    """Turn an IND$FILE failure into something actionable."""
    text = str(exc).strip()
    if tns.seslost:
        return "the session was lost during the transfer"
    if text in ("", "None"):
        return "the transfer ended without a completion message from IND$FILE"
    if "no response from IND$FILE" in text:
        return (
            text
            + ". The command is typed at the cursor, so the session must be"
            " at a ready prompt (TSO READY, ISPF option 6, or CMS) rather"
            " than in a panel or editor."
        )
    return text


def _exception_chain(exc) -> list:
    """Walk __cause__ / __context__ so wrapped SSL errors are visible."""
    seen: list = []
    while exc is not None and exc not in seen:
        seen.append(exc)
        nxt = exc.__cause__ or exc.__context__
        if nxt is exc:
            break
        exc = nxt
    return seen


def _format_exc(exc) -> str:
    if exc is None:
        return ""
    text = str(exc).strip()
    name = type(exc).__name__
    if not text or text == name:
        return name
    return f"{name}: {text}"


def _seslost_exc(seslost):
    """Pull the exception out of tnz's seslost value.

    tnz sets seslost to True for a close with no error, or to a
    sys.exc_info() / (type, exc, tb) tuple when it knows why.
    """
    if isinstance(seslost, BaseException):
        return seslost
    if isinstance(seslost, tuple) and len(seslost) >= 2:
        return seslost[1]
    return None


def _failure_advice(exc, *, tns=None, secure: bool | None = None) -> str:
    """One sentence of what to try, or empty if we cannot say."""
    chain = _exception_chain(exc) if exc is not None else []
    blob = " ".join(_format_exc(e).lower() for e in chain)
    names = " ".join(type(e).__name__.lower() for e in chain)

    if re.search(r"invalid address: (\d+)", blob) and tns is not None:
        match = re.search(r"invalid address: (\d+)", blob)
        address = int(match.group(1))
        cols = tns.maxcol or 80
        options = " or ".join(_suggest_sizes(address, cols))
        return (
            f"The host wrote past the end of this {tns.maxrow}x{cols}"
            f" screen. Set the screen size to match the emulator that"
            f" started the session: the columns must match exactly and the"
            f" rows must be at least as many. Otherwise try {options}."
        )

    if any(
        key in blob
        for key in (
            "wrong version number",
            "wrong_version_number",
            "unknown protocol",
            "record layer failure",
            "httpsconnectionpool",
        )
    ):
        if secure:
            return (
                "This looks like a plain (non-TLS) TN3270 port. Turn off"
                " Secure in the host profile, or use port 23."
            )
        return (
            "The host answered in TLS. Turn on Secure in the host profile;"
            " the usual TLS port is 992, though some sites use another."
        )

    if any(
        key in blob
        for key in (
            "certificate_verify_failed",
            "certificate verify failed",
            "unable to get local issuer",
            "self signed certificate",
            "self-signed certificate",
        )
    ):
        return (
            "The certificate is not trusted. For a lab or self-signed host,"
            " turn off Verify certificate. Otherwise the host name in the"
            " profile must match the name on the certificate."
        )

    if any(
        key in blob
        for key in (
            "hostname mismatch",
            "doesn't match",
            "does not match",
            "certificate_hostname",
        )
    ):
        return (
            "The certificate name does not match this host. Use the name on"
            " the certificate, or turn off Verify certificate."
        )

    if "handshake" in blob or "ssl" in names or "ssl" in blob:
        if secure is False:
            return (
                "The host closed a TLS handshake. Turn on Secure in the"
                " host profile."
            )
        if secure:
            return (
                "The TLS handshake failed. Try turning off Verify"
                " certificate, setting Sec level to 1 for an older stack,"
                " or turning Secure off if this is actually a plain port."
            )

    refused = (
        "connection refused" in blob
        or "actively refused" in blob
        or "errno 111" in blob
        or "winerror 10061" in blob
        or "econnrefused" in names
        or "connectionrefused" in names
    )
    if refused:
        return (
            "Nothing is listening on that host and port. Check the port"
            " (992 is the usual TLS TN3270 port, 23 the usual plain one)"
            " and that the host name resolves to the machine you meant."
        )

    reset = (
        "connection reset" in blob
        or "connectionabort" in names
        or "connectionreset" in names
        or "winerror 10054" in blob
        or "errno 104" in blob
        or "broken pipe" in blob
    )
    if reset:
        if secure is False:
            return (
                "The host closed the connection. This port may expect TLS;"
                " turn on Secure in the host profile."
            )
        if secure:
            return (
                "The host closed the TLS connection. If this is a plain"
                " port, turn Secure off. Otherwise the host may have"
                " rejected the TN3270 negotiation (try toggling TN3270E)."
            )
        return "The host closed the connection."

    timed_out = (
        "timed out" in blob
        or "timeout" in names
        or "winerror 10060" in blob
        or "errno 110" in blob
    )
    if timed_out:
        return (
            "The host did not answer in time. Check the host name and port,"
            " and whether you need TLS (Secure) to reach it."
        )

    dns = (
        "gaierror" in names
        or "getaddrinfo" in blob
        or "name or service not known" in blob
        or "nodename nor servname" in blob
        or "not known" in blob
        and "host" in blob
    )
    if dns:
        return "The host name did not resolve. Check the spelling."

    if "eof" in blob or "connection closed" in blob:
        if secure is False:
            return (
                "The host closed the socket without speaking. This port may"
                " expect TLS; turn on Secure in the host profile."
            )
        return "The host closed the connection."

    return ""


def _explain_failure(exc, *, tns=None, secure: bool | None = None) -> str:
    """Exception text plus advice, for toasts and the status line."""
    if exc is None:
        return _seslost_reason(True, tns, secure=secure)
    reason = _format_exc(exc)
    extra = [
        _format_exc(e)
        for e in _exception_chain(exc)[1:]
        if _format_exc(e) not in reason
    ]
    if extra:
        reason = reason + " (" + "; ".join(extra) + ")"
    advice = _failure_advice(exc, tns=tns, secure=secure)
    if advice:
        reason = f"{reason}. {advice}" if reason else advice
    return reason or _seslost_reason(True, tns, secure=secure)


def _seslost_reason(seslost, tns, *, secure: bool | None = None) -> str:
    """Describe why tnz dropped the session."""
    exc = _seslost_exc(seslost)
    if exc is None:
        if secure is False:
            return (
                "The host closed the connection. If this port expects TLS,"
                " turn on Secure in the host profile."
            )
        return "The host closed the connection."
    return _explain_failure(exc, tns=tns, secure=secure)


NAV = {
    "left": "key_curleft",
    "right": "key_curright",
    "up": "key_curup",
    "down": "key_curdown",
    "tab": "key_tab",
    "backtab": "key_backtab",
    "home": "key_home",
    "end": "key_end",
    "wordleft": "key_word_left",
    "wordright": "key_word_right",
    "newline": "key_newline",
    "backspace": "key_backspace",
    "delete": "key_delete",
    "eraseeof": "key_eraseeof",
    "eraseinput": "key_eraseinput",
}

AID = {
    "enter": "enter",
    "clear": "clear",
    "attn": "attn",
    "pa1": "pa1",
    "pa2": "pa2",
    "pa3": "pa3",
}
for _i in range(1, 25):
    AID[f"pf{_i}"] = f"pf{_i}"


class Session:
    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self.commands: queue.Queue = queue.Queue()
        self.stop = threading.Event()
        self.tns: Tnz | None = None
        self.secure = False
        self.thread = threading.Thread(
            target=self._run, name=f"tnz-{session_id}", daemon=True
        )

    def start(self) -> None:
        self.thread.start()

    def _run(self) -> None:
        try:
            while not self.stop.is_set():
                try:
                    cmd = self.commands.get(timeout=0.05)
                except queue.Empty:
                    cmd = None

                if cmd is not None:
                    self._handle(cmd)

                tns = self.tns
                if tns is None:
                    continue
                try:
                    tns.wait(timeout=0.05)
                except Exception as exc:
                    emit(
                        {
                            "op": "error",
                            "sessionId": self.session_id,
                            "message": _explain_failure(
                                exc, tns=tns, secure=self.secure
                            ),
                        }
                    )
                    continue

                if tns.seslost:
                    reason = _seslost_reason(
                        tns.seslost, tns, secure=self.secure
                    )
                    emit(
                        {
                            "op": "error",
                            "sessionId": self.session_id,
                            "message": f"session lost: {reason}",
                        }
                    )
                    emit(
                        {
                            "op": "status",
                            "sessionId": self.session_id,
                            "connected": False,
                            "tls": False,
                            "lu": tns.lu_name or "",
                            "seslost": True,
                            "lock": True,
                            "reason": reason,
                        }
                    )
                    try:
                        tns.close()
                    except Exception:
                        pass
                    self.tns = None
                    continue

                if tns.updated:
                    tns.updated = False
                    try:
                        self._emit_screen()
                    except Exception:
                        # One unrenderable screen must not kill the session.
                        emit(
                            {
                                "op": "error",
                                "sessionId": self.session_id,
                                "message": "screen update failed: "
                                + traceback.format_exc(limit=1),
                            }
                        )
        except Exception:
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": traceback.format_exc(),
                }
            )

    def _handle(self, cmd: dict) -> None:
        op = cmd.get("op")
        if op == "connect":
            self._connect(cmd)
        elif op == "disconnect":
            self._disconnect()
        elif op == "key":
            self._key(cmd)
        elif op == "click":
            self._click(cmd)
        elif op == "paste":
            self._paste(cmd)
        elif op == "transfer":
            self._transfer(cmd)
        elif op == "macro":
            self._macro(cmd)
        else:
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": f"unknown op {op}",
                }
            )

    def _connect(self, cmd: dict) -> None:
        self._disconnect()
        host = cmd.get("host") or "127.0.0.1"
        secure = bool(cmd.get("secure", True))
        self.secure = secure
        port = cmd.get("port")
        if port is None:
            port = 992 if secure else 23
        verify = bool(cmd.get("verifyCert", True))
        lu_name = (cmd.get("luName") or "").strip() or None
        code_page = str(cmd.get("codePage") or "037")
        # A typographic multiplication sign is an easy thing to paste in.
        ps_size = str(cmd.get("psSize") or "24x80").replace("\u00d7", "x")
        sec_level = cmd.get("secLevel")
        tn3270e = bool(cmd.get("tn3270e", True))

        if sec_level:
            os.environ["SESSION_SECLEVEL"] = str(sec_level)

        tns = Tnz(name=self.session_id)
        # Advertising colour in the query reply is what invites the host to
        # send extended colour orders; without it we only get field colours.
        tns.capable_color = bool(cmd.get("capableColor", True))
        tns.use_tn3270e = tn3270e
        tns.lu_name = lu_name
        try:
            tns.encoding = f"cp{code_page}"
            # Character set 0xF1 carries the APL/line-drawing glyphs ISPF uses
            # for panel borders. tnz only wires this up for a UTF-8 tty, and
            # our stdout is a pipe.
            from tnz import cp310 as _cp310  # registers the codec

            tns.encoding = ("cp310", 0xF1)
        except Exception as exc:
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": f"code page cp{code_page}: {exc}",
                }
            )
            return

        try:
            from tnz import _util

            rows, cols = _util.session_ps_size(ps_size)
            tns.amaxrow, tns.amaxcol = rows, cols
        except Exception as exc:
            # Falling back to 24x80 silently leaves the host free to address
            # rows we do not have, which shows up much later as a lost session.
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": f"screen size {ps_size}: {exc}",
                }
            )

        try:
            tns.connect(host, int(port), secure=secure, verifycert=verify)
        except Exception as exc:
            reason = _explain_failure(exc, tns=tns, secure=secure)
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": f"connect failed: {reason}",
                }
            )
            self._emit_lost(tns, reason)
            return

        self.tns = tns
        # Wait until the transport exists or the session is lost.
        for _ in range(600):
            if tns._transport or tns.seslost:
                break
            tns.wait(timeout=0.05)

        if tns.seslost:
            reason = _seslost_reason(tns.seslost, tns, secure=secure)
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": f"connection lost during connect: {reason}",
                }
            )
            self._emit_lost(tns, reason)
            self.tns = None
            return

        if not tns._transport:
            reason = (
                f"timed out waiting for {host}:{port} to complete the"
                f" {'TLS ' if secure else ''}handshake. Check the host,"
                f" port, and whether Secure should be"
                f" {'off' if secure else 'on'}."
            )
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": reason,
                }
            )
            self._emit_lost(tns, reason)
            self.tns = None
            return

        tns.wait(timeout=2.0)
        if tns.seslost:
            reason = _seslost_reason(tns.seslost, tns, secure=secure)
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": f"connection lost during connect: {reason}",
                }
            )
            self._emit_lost(tns, reason)
            self.tns = None
            return

        tns.updated = False
        emit(
            {
                "op": "status",
                "sessionId": self.session_id,
                "connected": True,
                "tls": bool(secure),
                "lu": tns.lu_name or "",
                "seslost": False,
                "lock": bool(tns.pwait or tns.system_lock_wait),
            }
        )
        self._emit_screen()

    def _emit_lost(self, tns, reason: str) -> None:
        emit(
            {
                "op": "status",
                "sessionId": self.session_id,
                "connected": False,
                "tls": False,
                "lu": getattr(tns, "lu_name", "") or "",
                "seslost": True,
                "lock": True,
                "reason": reason,
            }
        )
        try:
            tns.close()
        except Exception:
            pass

    def _disconnect(self) -> None:
        tns = self.tns
        self.tns = None
        if tns is not None:
            try:
                tns.close()
            except Exception:
                pass
            emit(
                {
                    "op": "status",
                    "sessionId": self.session_id,
                    "connected": False,
                    "tls": False,
                    "lu": "",
                    "seslost": False,
                    "lock": False,
                }
            )

    def _key(self, cmd: dict) -> None:
        tns = self.tns
        if tns is None:
            return
        kind = cmd.get("type")
        value = cmd.get("value") or ""
        try:
            if kind == "chars":
                if cmd.get("insert"):
                    tns.key_ins_data(value)
                else:
                    tns.key_data(value)
            elif kind == "nav":
                method = NAV.get(value)
                if not method:
                    raise TnzError(f"unknown nav {value}")
                getattr(tns, method)()
            elif kind == "aid":
                method = AID.get(value.lower())
                if not method:
                    raise TnzError(f"unknown aid {value}")
                getattr(tns, method)()
            else:
                raise TnzError(f"unknown key type {kind}")
        except TnzError as exc:
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": str(exc),
                    "lock": True,
                }
            )
            return
        self._emit_screen()

    def _click(self, cmd: dict) -> None:
        tns = self.tns
        if tns is None:
            return
        row = int(cmd.get("row") or 1)
        col = int(cmd.get("col") or 1)
        try:
            tns.set_cursor_position(row, col)
            if cmd.get("double"):
                tns.enter()
        except (TnzError, ValueError) as exc:
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": str(exc),
                }
            )
            return
        self._emit_screen()

    def _paste(self, cmd: dict) -> None:
        tns = self.tns
        if tns is None:
            return
        try:
            tns.paste_data(cmd.get("text") or "")
        except TnzError as exc:
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": str(exc),
                }
            )
            return
        self._emit_screen()

    def _wait_unlock(self, tns, timeout_ms: float) -> None:
        """Block until the host gives the keyboard back.

        Sending an AID sets both inhibit flags, so this is what makes a macro
        step wait for the screen the previous step asked for.
        """
        deadline = time.monotonic() + timeout_ms / 1000
        while tns.pwait or tns.system_lock_wait:
            if tns.seslost:
                raise TnzError("the session was lost")
            if time.monotonic() > deadline:
                raise TnzError(
                    f"the host did not respond within {timeout_ms:g} ms"
                )
            tns.wait(timeout=0.1)

    def _macro(self, cmd: dict) -> None:
        """Replay a parsed macro on the session thread.

        Running here rather than feeding the steps in one at a time keeps
        typing and AIDs in order and stops the user's keystrokes interleaving
        with the macro's.
        """
        tns = self.tns
        if tns is None:
            return
        name = cmd.get("name") or ""
        steps = cmd.get("steps") or []
        index = 0
        try:
            for index, step in enumerate(steps, 1):
                kind = step.get("kind")
                if kind == "text":
                    tns.key_data(step.get("value") or "")
                elif kind == "aid":
                    method = AID.get(str(step.get("value")).lower())
                    if not method:
                        raise TnzError(f"unknown aid {step.get('value')}")
                    getattr(tns, method)()
                elif kind == "nav":
                    method = NAV.get(str(step.get("value")))
                    if not method:
                        raise TnzError(f"unknown nav {step.get('value')}")
                    getattr(tns, method)()
                elif kind == "wait":
                    self._wait_unlock(tns, float(step.get("ms") or 10000))
                    self._emit_screen()
                elif kind == "pause":
                    time.sleep(float(step.get("ms") or 0) / 1000)
                else:
                    raise TnzError(f"unknown macro step {kind}")
        except (TnzError, ValueError) as exc:
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": f"macro {name} stopped at step {index}: {exc}",
                }
            )
        try:
            self._emit_screen()
        except Exception:
            pass

    def _transfer(self, cmd: dict) -> None:
        """Run IND$FILE on the session thread.

        tnz drives its own wait loop for the duration, so nothing else can
        touch this Tnz while a transfer is running. Keeping it on the session
        thread is what makes that safe.
        """
        transfer_id = cmd.get("transferId") or ""
        direction = cmd.get("direction")
        local = cmd.get("localPath") or ""
        parms = cmd.get("parms") or ""

        def done(ok: bool, message: str) -> None:
            emit(
                {
                    "op": "transfer",
                    "sessionId": self.session_id,
                    "transferId": transfer_id,
                    "state": "done",
                    "ok": ok,
                    "message": message,
                }
            )

        tns = self.tns
        if tns is None:
            done(False, "not connected")
            return
        if tns.pwait or tns.system_lock_wait:
            done(
                False,
                "the keyboard is locked. IND$FILE is typed as a command, so"
                " the session must be at a ready prompt (TSO READY, ISPF"
                " option 6, or CMS) with the keyboard unlocked.",
            )
            return

        emit(
            {
                "op": "transfer",
                "sessionId": self.session_id,
                "transferId": transfer_id,
                "state": "start",
                "direction": direction,
                "localPath": local,
                "parms": parms,
            }
        )
        idle = float(cmd.get("idleTimeout") or 60)
        tns.wait = _deadline_wait(tns, idle)
        try:
            if direction == "download":
                message = tns.get_file(parms, local)
            elif direction == "upload":
                message = tns.put_file(local, parms)
            else:
                raise TnzError(f"unknown transfer direction {direction}")
        except TnzTransferError as exc:
            done(False, _transfer_reason(exc, tns))
        except (TnzError, OSError) as exc:
            done(False, str(exc))
        except Exception:
            done(False, traceback.format_exc(limit=2))
        else:
            done(True, str(message).strip())
        finally:
            try:
                del tns.wait
            except AttributeError:
                pass
            try:
                self._emit_screen()
            except Exception:
                pass

    def _emit_screen(self) -> None:
        tns = self.tns
        if tns is None:
            return
        rows = tns.maxrow
        cols = tns.maxcol
        text = tns.scrstr(0, 0, rstrip=False)
        # Pad/trim to the current buffer in case of a size race.
        size = rows * cols
        if len(text) < size:
            text = text + (" " * (size - len(text)))
        elif len(text) > size:
            text = text[:size]
        attrs, eff_eh, eff_fg, eff_bg = _effective_planes(tns, size)
        text = _mask_hidden(text, tns.plane_fa, attrs, size)
        cur = tns.curadd
        emit(
            {
                "op": "screen",
                "sessionId": self.session_id,
                "rows": rows,
                "cols": cols,
                "cursorRow": cur // cols + 1,
                "cursorCol": cur % cols + 1,
                "lock": bool(tns.pwait or tns.system_lock_wait),
                "text": text,
                "attr": b64(attrs),
                "fg": b64(eff_fg),
                "bg": b64(eff_bg),
                "eh": b64(eff_eh),
                "extendedColor": bool(tns.extended_color_mode()),
            }
        )


def _effective_planes(tns, size: int) -> tuple:
    """Resolve per-position attributes the way a 3270 display does.

    tnz stores a field attribute only at the field's own position, and
    extended attributes (colour, highlighting) may be set either on the
    field or on individual characters. Every position inherits from the
    nearest preceding field, wrapping around the buffer, and a character
    value overrides the field value.
    """
    plane_fa = tns.plane_fa
    plane_eh = tns.plane_eh
    plane_fg = tns.plane_fg
    plane_bg = tns.plane_bg

    attrs = bytearray(size)
    eff_eh = bytearray(size)
    eff_fg = bytearray(size)
    eff_bg = bytearray(size)

    field_pos = -1
    for i in range(size - 1, -1, -1):
        if plane_fa[i]:
            field_pos = i
            break

    f_fa = f_eh = f_fg = f_bg = 0
    if field_pos >= 0:
        f_fa = plane_fa[field_pos]
        f_eh = plane_eh[field_pos]
        f_fg = plane_fg[field_pos]
        f_bg = plane_bg[field_pos]

    for i in range(size):
        if plane_fa[i]:
            f_fa = plane_fa[i]
            f_eh = plane_eh[i]
            f_fg = plane_fg[i]
            f_bg = plane_bg[i]
            # The attribute byte takes up a screen position but belongs to
            # no field, and a 3270 shows it as a plain blank. Leaving its
            # planes at zero stops underscore or reverse video from
            # starting a column early and making the field look wider.
            continue

        attrs[i] = f_fa
        eff_eh[i] = plane_eh[i] or f_eh
        eff_fg[i] = plane_fg[i] or f_fg
        eff_bg[i] = plane_bg[i] or f_bg

    return attrs, eff_eh, eff_fg, eff_bg


def _mask_hidden(text: str, plane_fa, attrs: bytearray, size: int) -> str:
    """Blank non-display fields (passwords) and field attribute positions.

    Masking here keeps hidden characters inside this process.
    """
    chars = list(text)
    for i in range(size):
        if plane_fa[i] or attrs[i] & 0x0C == 0x0C:
            chars[i] = " "
    return "".join(chars)


def get_session(session_id: str) -> Session:
    with _sessions_lock:
        ses = _sessions.get(session_id)
        if ses is None:
            ses = Session(session_id)
            _sessions[session_id] = ses
            ses.start()
        return ses


def main() -> int:
    emit({"op": "ready"})
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError as exc:
            emit({"op": "error", "sessionId": "", "message": f"bad json: {exc}"})
            continue

        op = cmd.get("op")
        if op == "shutdown":
            with _sessions_lock:
                sessions = list(_sessions.values())
            for ses in sessions:
                ses.stop.set()
                ses.commands.put({"op": "disconnect"})
            break

        session_id = cmd.get("sessionId") or ""
        if not session_id:
            emit({"op": "error", "sessionId": "", "message": "sessionId required"})
            continue
        get_session(session_id).commands.put(cmd)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
