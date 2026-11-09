import json
import os
import pty
import re
import select
import sys
import time

spec = json.load(sys.stdin)
ansi = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b[=>]|\r")
pid, fd = pty.fork()
if pid == 0:
    os.chdir(spec["cwd"])
    os.execve(spec["argv"][0], spec["argv"], spec["env"])

raw = ""
eof = False


def pump(wait):
    global raw, eof
    if eof:
        return
    ready, _, _ = select.select([fd], [], [], wait)
    if not ready:
        return
    try:
        data = os.read(fd, 65536)
    except OSError:
        data = b""
    if not data:
        eof = True
        return
    raw += data.decode("utf-8", "replace")


def clean():
    return ansi.sub("", raw)


failure = None
seen = 0
for step in spec["steps"]:
    deadline = time.time() + spec.get("timeout", 20)
    pattern = re.compile(step["expect"])
    while True:
        match = pattern.search(clean(), seen)
        if match:
            seen = match.end()
            break
        if eof or time.time() > deadline:
            failure = "no match for " + step["expect"]
            break
        pump(0.1)
    if failure:
        break
    time.sleep(0.05)
    os.write(fd, step["send"].encode())

end = time.time() + spec.get("timeout", 20)
while not eof and time.time() < end:
    pump(0.1)
if not eof and failure is None:
    failure = "the process did not exit"
if not eof:
    os.kill(pid, 9)
_, status = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(status)
print(json.dumps({"code": code, "output": clean(), "failure": failure}))
