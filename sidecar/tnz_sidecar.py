"""JSON-lines sidecar wrapping tnz.Tnz for the TNZ 3270 VS Code extension.

One process, one worker thread per session. Commands arrive on stdin;
events are written to stdout as a single JSON object per line.
"""

from __future__ import annotations

import base64
import json
import os
import queue
import sys
import threading
import traceback

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
    from tnz.tnz import Tnz, TnzError
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


NAV = {
    "left": "key_curleft",
    "right": "key_curright",
    "up": "key_curup",
    "down": "key_curdown",
    "tab": "key_tab",
    "backtab": "key_backtab",
    "home": "key_home",
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
                            "message": str(exc),
                        }
                    )
                    continue

                if tns.seslost:
                    emit(
                        {
                            "op": "status",
                            "sessionId": self.session_id,
                            "connected": False,
                            "tls": False,
                            "lu": tns.lu_name or "",
                            "seslost": True,
                            "lock": True,
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
                    self._emit_screen()
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
        port = cmd.get("port")
        if port is None:
            port = 992 if secure else 23
        verify = bool(cmd.get("verifyCert", True))
        lu_name = (cmd.get("luName") or "").strip() or None
        code_page = str(cmd.get("codePage") or "037")
        ps_size = str(cmd.get("psSize") or "24x80")
        sec_level = cmd.get("secLevel")
        tn3270e = bool(cmd.get("tn3270e", True))

        if sec_level:
            os.environ["SESSION_SECLEVEL"] = str(sec_level)

        tns = Tnz(name=self.session_id)
        tns.capable_color = True
        tns.use_tn3270e = tn3270e
        tns.lu_name = lu_name
        try:
            tns.encoding = f"cp{code_page}"
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
        except Exception:
            pass

        try:
            tns.connect(host, int(port), secure=secure, verifycert=verify)
        except Exception as exc:
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": f"connect failed: {exc}",
                }
            )
            return

        self.tns = tns
        # Wait until the transport exists or the session is lost.
        for _ in range(600):
            if tns._transport or tns.seslost:
                break
            tns.wait(timeout=0.05)

        if tns.seslost:
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": "connection lost during connect",
                }
            )
            self.tns = None
            return

        tns.wait(timeout=2.0)
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
                "fa": b64(tns.plane_fa),
                "fg": b64(tns.plane_fg),
                "bg": b64(tns.plane_bg),
                "eh": b64(tns.plane_eh),
                "extendedColor": bool(tns.extended_color_mode()),
            }
        )


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
