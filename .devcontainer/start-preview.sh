#!/usr/bin/env bash
set -euo pipefail

if [[ "${CODESPACES:-}" != "true" || -z "${CODESPACE_NAME:-}" || -z "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]]; then
  echo 'Execute este comando dentro do GitHub Codespaces.' >&2
  exit 1
fi

port=4173
origin="https://${CODESPACE_NAME}-${port}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"

# Keep the Codespace's credentials and secrets out of the preview server's environment.
exec env -i PATH="$PATH" PORT="$port" PUBLIC_ORIGIN="$origin" node server.mjs
