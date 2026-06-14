#!/usr/bin/env python3
"""Publish the recorder to GitHub Pages (HTTPS — needed for geolocation on phones).

Shallow-clones the gh-pages branch into a temp dir, wipes it (keeping .git),
copies the static files in, stamps the service-worker cache version, commits and
pushes. Auto-creates gh-pages if missing.

Prerequisites: this folder must be a git repo with an `origin` remote, e.g.
    git init && git add -A && git commit -m init
    git remote add origin git@github.com:<you>/aisee-gardens-recorder.git
Then: python3 deploy.py   (optionally set CNAME via env: CNAME=recorder.example.com)
"""
import os, shutil, subprocess, tempfile, time, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
FILES = ["index.html", "styles.css", "app.js", "manifest.webmanifest", "icon.svg", "sw.js"]
VERSION = time.strftime("%Y%m%d-%H%M%S")


def run(cmd, cwd=None):
    print(">", " ".join(cmd))
    subprocess.run(cmd, cwd=cwd, check=True)


def main():
    try:
        origin = subprocess.check_output(["git", "-C", ROOT, "remote", "get-url", "origin"]).decode().strip()
    except subprocess.CalledProcessError:
        sys.exit("No `origin` remote. See the prerequisites in this file's docstring.")

    tmp = tempfile.mkdtemp(prefix="recorder-ghp-")
    try:
        try:
            run(["git", "clone", "--depth", "1", "--branch", "gh-pages", origin, tmp])
        except subprocess.CalledProcessError:
            run(["git", "clone", "--depth", "1", origin, tmp])
            run(["git", "checkout", "--orphan", "gh-pages"], cwd=tmp)
            run(["git", "rm", "-rf", "."], cwd=tmp)

        for n in os.listdir(tmp):
            if n != ".git":
                p = os.path.join(tmp, n)
                shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)

        for f in FILES:
            shutil.copy(os.path.join(ROOT, f), os.path.join(tmp, f))

        # Cache-bust the service worker for this deploy.
        swp = os.path.join(tmp, "sw.js")
        with open(swp) as fh:
            sw = fh.read().replace("BUILD_VERSION_PLACEHOLDER", VERSION)
        with open(swp, "w") as fh:
            fh.write(sw)

        open(os.path.join(tmp, ".nojekyll"), "w").close()
        cname = os.environ.get("CNAME")
        if cname:
            with open(os.path.join(tmp, "CNAME"), "w") as fh:
                fh.write(cname + "\n")

        run(["git", "add", "-A"], cwd=tmp)
        run(["git", "commit", "-m", f"Deploy {VERSION}"], cwd=tmp)
        run(["git", "push", "origin", "gh-pages"], cwd=tmp)
        print(f"\nDeployed {VERSION} to gh-pages.")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
