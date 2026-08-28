# startlpar — Ctrl+click an LPAR name (or run from Run Macro).
#
# settings.json:
#   "tnzView.macros": { "startlpar": { "script": "startlpar" } }
#   "tnzView.clickMacro": "startlpar"
#
# Copy this file to the macros folder (TNZ 3270: Open Macros Folder)
# if it is not already there. Do not put a password in this file.

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
wait_unlock(5)

if on_screen("not authorized to use TSO"):
    warn(userid + " is not authorised to use " + lpar)
    pf3()
    return

if on_screen("VTHB"):
    warn("Application " + lpar + " does not exist.")
    clear()
    return

set_title("BMC " + lpar + " " + userid)

if on_screen("Password  ===>"):
    home()
    eraseeof()
    type(ask_password("Password"))
    enter()
    wait_unlock(3)
else:
    warn("Can't find the password prompt anywhere.")
    return

if on_screen("IKJ56425I") or on_screen("IKJ56418I"):
    warn("Userid " + userid + " is revoked on " + lpar)
    wait_unlock(3)
    clear()
    return

wait_unlock(3)
enter()
wait_unlock(3)
enter()
