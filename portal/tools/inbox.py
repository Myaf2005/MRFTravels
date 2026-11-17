#!/usr/bin/env python3
"""Hand a file to the live Advisor Studio from any Claude chat.

  python3 portal/tools/inbox.py push <file.pdf>   # encrypt + push ciphertext to the 'inbox' branch, print the import call
  python3 portal/tools/inbox.py clear             # wipe the inbox branch after the Studio imported the file(s)

Only AES-256-GCM ciphertext goes to GitHub. The key is printed for the chat to pass to
window.mrf.importFile(...) in the signed-in Studio tab; it is never written to disk or committed.
Needs: push access to Myaf2005/MRFTravels (add_repo access=push) and `pip install cryptography`.
"""
import base64, json, os, secrets, subprocess, sys, tempfile, mimetypes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TYPES = {".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".heic": "image/heic", ".webp": "image/webp"}

def git(*a, cwd):
    return subprocess.run(["git", *a], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()

def remote():
    return git("remote", "get-url", "origin", cwd=REPO)

def push_tree(files):
    """Force-push a single-commit orphan 'inbox' branch containing exactly `files` {name: bytes}."""
    with tempfile.TemporaryDirectory() as d:
        git("init", "-q", "-b", "inbox", cwd=d)
        git("config", "user.name", "MRF inbox", cwd=d); git("config", "user.email", "inbox@mrftravels.com", cwd=d)
        open(os.path.join(d, "README.md"), "w").write("Encrypted hand-off files for the Advisor Studio. Unreadable without the key; cleared after import.\n")
        for n, b in files.items():
            open(os.path.join(d, n), "wb").write(b)
        git("add", "-A", cwd=d); git("commit", "-q", "-m", "inbox", cwd=d)
        git("push", "-q", "--force", remote(), "inbox", cwd=d)

def current():
    try:
        git("fetch", "-q", "origin", "inbox", cwd=REPO)
    except subprocess.CalledProcessError:
        return {}
    names = git("ls-tree", "--name-only", "FETCH_HEAD", cwd=REPO).split()
    return {n: subprocess.run(["git", "show", f"FETCH_HEAD:{n}"], cwd=REPO, check=True, capture_output=True).stdout for n in names if n.endswith(".bin")}

def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("push", "clear"):
        sys.exit(__doc__)
    if sys.argv[1] == "clear":
        push_tree({}); print("Inbox cleared."); return
    path = sys.argv[2]
    data = open(path, "rb").read()
    if len(data) > 20 * 1024 * 1024: sys.exit("Files must be under 20 MB.")
    ext = os.path.splitext(path)[1].lower()
    if ext not in TYPES: sys.exit("Only PDF, JPG, PNG, HEIC or WEBP.")
    key, iv = AESGCM.generate_key(256), secrets.token_bytes(12)
    blob = AESGCM(key).encrypt(iv, data, None)
    fname = secrets.token_hex(12) + ".bin"
    files = current(); files[fname] = blob
    push_tree(files)
    args = {"file": fname, "key": base64.b64encode(key).decode(), "iv": base64.b64encode(iv).decode(),
            "name": os.path.basename(path), "contentType": TYPES[ext]}
    print(json.dumps(args))

if __name__ == "__main__":
    main()
