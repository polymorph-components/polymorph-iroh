#!/usr/bin/env python3
"""Set every tracked file's mtime to the time of the last commit that touched it.

Cargo decides whether a path dependency is fresh by comparing source mtimes
against the artifact's. A CI checkout stamps every file with the checkout
time, so restored build artifacts are always older than the sources they were
built from and every in-repo crate recompiles. Commit times are stable across
runs and across machines, so the same source content gets the same mtime on
every checkout and unchanged crates stay fresh.

Files whose content differs from HEAD keep their mtimes: backdating a modified
file would hide the modification from cargo and produce a build that does not
match the source.

Each file also gets a sub-second offset derived from its path. Cargo records
a path dependency's freshness as the newest mtime in the package *and the name
of the file that carried it*, and a commit that touched several files would
otherwise give them one identical timestamp — leaving the newest file to be
decided by directory order, which differs between clones. The package then
looks changed on a machine that walked its directory differently, and every
crate above it rebuilds.

Usage: restore-mtimes.py [REPO ...]
"""

import os
import subprocess
import sys
import zlib


def git(repo, *args):
    # stderr is inherited: git's own message is the useful one when a path
    # under .deps is not a checkout.
    return subprocess.run(
        ["git", "-C", repo, "-c", "core.quotePath=false", *args],
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    ).stdout


def restore(repo):
    pending = {p for p in git(repo, "ls-files").splitlines() if p}
    pending -= {p for p in git(repo, "diff", "--name-only", "HEAD").splitlines() if p}

    log = subprocess.Popen(
        [
            "git",
            "-C",
            repo,
            "-c",
            "core.quotePath=false",
            "log",
            "--pretty=format:\x01%ct",
            "--name-only",
            "--no-renames",
        ],
        stdout=subprocess.PIPE,
        text=True,
    )

    stamped = 0
    timestamp = None
    for line in log.stdout:
        line = line.rstrip("\n")
        if line.startswith("\x01"):
            timestamp = int(line[1:])
            continue
        # A path git had to quote (embedded newline or control character)
        # cannot be recovered from this stream; leave the file alone.
        if not line or line.startswith('"') or line not in pending:
            continue
        pending.discard(line)
        path = os.path.join(repo, line)
        stamp = timestamp * 10**9 + zlib.crc32(line.encode()) % 10**9
        try:
            os.utime(path, ns=(stamp, stamp))
            stamped += 1
        except OSError:
            pass
        if not pending:
            break

    log.stdout.close()
    log.terminate()
    log.wait()
    print(f"{repo}: {stamped} files stamped", file=sys.stderr)


for repo in sys.argv[1:] or ["."]:
    restore(repo)
