#!/usr/bin/env bash
# Creates the virtualenv the e2e oracle runs in. Kept out of the default test
# path so contributors and CI are not forced to install Anki to run `bun test`.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
./.venv/bin/pip install --quiet --upgrade pip
./.venv/bin/pip install --quiet -r requirements.txt
echo "e2e oracle ready: anki $(./.venv/bin/python -c 'import anki.buildinfo; print(anki.buildinfo.version)')"
