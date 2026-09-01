# startlpar — Ctrl+click an LPAR name (or run from Run Macro).
#
# settings.json:
#   "tn3270.macros": { "startlpar": { "script": "startlpar" } }
#   "tn3270.clickMacro": "startlpar"
#
# Copy this file to the macros folder (3270 Terminal: Open Macros Folder)
# if it is not already there. Do not put a password in this file.
#
# Copyright (c) 2026 Marcus Davage
# SPDX-License-Identifier: Apache-2.0

if not unlocked():
    return

wait_unlock(10)

lpar = word_at(click)
if len(lpar) != 4 or click.row < 11 or click.row > 17 or click.col < 6 or click.col > 61:
    lpar = ask("Enter LPAR", default=lpar, max=4)
    if not lpar:
        return

uid = ask("Enter=MVS, 0-4=RDA  —  User ID for " + lpar)
if uid == "0":
    userid = "RDAMJD"
elif uid in ("1", "2", "3", "4"):
    userid = "RDAMJD" + uid
elif uid == "8":
    userid = "RDAMJD" + uid + "C"
else:
    userid = "MVSMJD"

type(lpar + " " + userid)
enter()

# The keyboard comes back on the first reply, which is not the logon panel,
# so wait for the panel itself rather than for the unlock.
seen = wait_for("Password  ===>", "not authorized to use TSO", seconds=20)

if seen == "not authorized to use TSO":
    warn(userid + " is not authorised to use " + lpar)
    pf3()
    return

if not seen:
    # VTHB is only tested here: on some systems it appears in a header, and
    # racing it against the password prompt would match the wrong screen.
    if on_screen("VTHB"):
        warn("Application " + lpar + " does not exist.")
        clear()
        return
    trace_screen()
    warn("Can't find the password prompt anywhere.")
    return

home()
eraseeof()
type(ask_password("Password"))
enter()
wait_unlock(3)

if on_screen("IKJ56425I") or on_screen("IKJ56418I"):
    warn("Userid " + userid + " is revoked on " + lpar)
    wait_unlock(3)
    clear()
    return

wait_unlock(3)
enter()
wait_unlock(3)
enter()
