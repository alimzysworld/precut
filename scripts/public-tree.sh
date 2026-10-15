#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: scripts/public-tree.sh <empty destination>" >&2
  exit 2
fi

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec python3 - "$project_root" "$1" <<'PY'
import json
from pathlib import Path
import re
import shutil
import sys

source = Path(sys.argv[1]).resolve()
requested = Path(sys.argv[2]).absolute()
if requested.is_symlink():
    sys.exit("Refusing a symlink destination.")
dest = requested.resolve()
if dest == source or dest in source.parents:
    sys.exit("Destination must not be the source tree or one of its parents.")
if dest.exists() and (not dest.is_dir() or any(dest.iterdir())):
    sys.exit("Destination must be an empty directory; nothing has been overwritten.")

excluded_dirs = {"__pycache__", ".pytest_cache", "node_modules", "qa", "briefs",
                 "docs", "reference", "fixtures", "out", ".git"}
qa_scripts = {"copy-fixtures.mjs"}
entries = ["src", "pipeline", "prompts", "scripts", "build/icon.icns",
           "package.json", "package-lock.json", "electron.vite.config.ts",
           "electron-builder.yml", "README.md", "LICENSE", ".gitignore"]
entries += [p.name for p in sorted(source.glob("tsconfig*.json"))]
for entry in entries:
    directory = source / entry
    if directory.is_dir() and (dest == directory or directory in dest.parents):
        sys.exit("Destination must be outside every copied directory.")

def ignored(directory, names):
    result = []
    for name in names:
        path = Path(directory) / name
        if path.is_symlink():
            sys.exit(f"Refusing a symlink in the public tree: {path.relative_to(source)}")
        if (name in excluded_dirs or name == ".DS_Store" or name.endswith((".pyc", ".tsbuildinfo"))
                or ("scripts" in path.relative_to(source).parts
                    and (name in qa_scripts or re.match(r"(?:qa|test|check)[-_.]", name)))):
            result.append(name)
    return result

# Check the complete whitelist before creating the destination.
for entry in entries:
    if not (source / entry).exists():
        sys.exit(f"Missing required public file: {entry}")
    if (source / entry).is_symlink():
        sys.exit(f"Refusing a symlink in the public tree: {entry}")

dest.mkdir(parents=True, exist_ok=True)
for entry in entries:
    src, target = source / entry, dest / entry
    if src.is_dir():
        shutil.copytree(src, target, ignore=ignored)
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)

package_file = dest / "package.json"
package = json.loads(package_file.read_text())
package["scripts"] = {
    name: command for name, command in package.get("scripts", {}).items()
    if name not in {"build:web", "copy-fixtures"} and "copy-fixtures" not in command
}
package_file.write_text(json.dumps(package, indent=2) + "\n")

# Scan every copied file, including this scanner. Assemble sensitive patterns
# so the scanner's own source does not create an exception to its checks.
private_terms = [b"/" + b"Users/", b"alim" + b"haque", b"Alim" + b"agery",
                 b"hack" + b"ajob", b"pay" + b"back"]
extensions = ["wav", "mp4", "mov", "png", "jpg"]
media_pattern = re.compile(rb"\." + b"(?:" + b"|".join(e.encode() for e in extensions) + rb")\b", re.I)
asset = "src/renderer/src/assets/sidething-logo-tile@2x" + "." + "png"
findings = []
files = sorted(p for p in dest.rglob("*") if p.is_file())
total = 0
for file in files:
    relative = file.relative_to(dest).as_posix()
    data = file.read_bytes()
    total += len(data)
    print(f"{relative}\t{len(data)} bytes")
    for term in private_terms:
        for match in re.finditer(re.escape(term), data, re.I):
            line = data[:match.start()].count(b"\n") + 1
            findings.append(f"{relative}:{line}: private text: {term.decode()}")
    if relative != asset:
        for match in media_pattern.finditer(relative.encode()):
            findings.append(f"{relative}: media file name: {match.group().decode()}")
    if len(data) > 2 * 1024 * 1024:
        findings.append(f"{relative}: larger than 2 MB, check it is not media")

print(f"Total: {len(files)} files, {total:,} bytes ({total / 1024 / 1024:.2f} MiB)", flush=True)
if findings:
    print("Public tree scan FAILED:", file=sys.stderr)
    for finding in findings:
        print(f"  {finding}", file=sys.stderr)
    sys.exit(1)
print("Public tree scan clean.")
PY
