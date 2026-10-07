#!/usr/bin/env bash
# Usage: verify-signature.sh KEY FINGERPRINT FILE SIGNATURE
# Accepts FILE only when SIGNATURE is a valid detached signature made by the
# single public key in KEY, whose primary fingerprint must equal FINGERPRINT.
set -euo pipefail
if [[ $# != 4 ]]; then
  echo 'Usage: verify-signature.sh KEY FINGERPRINT FILE SIGNATURE' >&2
  exit 2
fi
key=$1
fingerprint=${2^^}
file=$3
signature=$4
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
primary=$(gpg --batch --homedir "$work" --with-colons --show-keys "$key" 2>/dev/null |
  awk -F: '$1 == "pub" { primary = 1; next } primary && $1 == "fpr" { print $10; primary = 0 }')
if [[ $primary != "$fingerprint" ]]; then
  echo "Signing key mismatch: expected $fingerprint, found ${primary:-none}." >&2
  exit 1
fi
gpg --batch --homedir "$work" --dearmor <"$key" >"$work/keyring.gpg"
if ! gpgv --status-fd 3 --keyring "$work/keyring.gpg" "$signature" "$file" \
  3>"$work/status" 2>"$work/gpgv.log"; then
  cat "$work/gpgv.log" >&2
  echo "Signature verification failed: $file" >&2
  exit 1
fi
# VALIDSIG ends with the primary fingerprint, including for signing subkeys.
if ! grep -Eq "^\[GNUPG:\] VALIDSIG .* $fingerprint\$" "$work/status"; then
  echo "Signature was not made by $fingerprint: $file" >&2
  exit 1
fi
echo "Verified $file signature from $fingerprint."
