#!/bin/sh
#
# Generates a locally-trusted certificate for https://localhost.
#
# Needed because Google refuses to attach restricted scopes (specifically
# https://mail.google.com/) to any OAuth client that has a non-HTTPS redirect
# URI — including http://localhost. So local development has to run over TLS.
#
# Produces a tiny local CA and a leaf certificate signed by it. A bare
# self-signed leaf would work too, but browsers cannot be told to trust one
# per-site; trusting a CA is the supported path and is easy to undo.
#
#   sh scripts/make-cert.sh
#
# Output goes to .certs/ (gitignored). Trusting the CA is a separate, explicit
# step — see the instructions printed at the end.

set -e

# Git Bash rewrites arguments that look like Unix paths into Windows paths,
# which mangles openssl subjects such as /CN=localhost into C:/Program Files/...
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"

cd "$(dirname "$0")/.."
mkdir -p .certs
cd .certs

DAYS=825 # Browsers reject leaf certificates valid for much longer than this.

if [ -f ca.key ] && [ -f ca.crt ]; then
  echo "reusing the existing local CA"
else
  echo "creating a local CA..."
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout ca.key -out ca.crt -days 3650 \
    -subj "/CN=Hive local development CA/O=Hive" 2>/dev/null
fi

echo "creating the localhost certificate..."

# SANs, not just CN: every current browser ignores the Common Name entirely.
cat > san.cnf <<'CNF'
[req]
distinguished_name = dn
[dn]
[ext]
subjectAltName = @alt
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
basicConstraints = critical, CA:FALSE
[alt]
DNS.1 = localhost
IP.1 = 127.0.0.1
IP.2 = ::1
CNF

openssl req -newkey rsa:2048 -nodes \
  -keyout localhost.key -out localhost.csr \
  -subj "/CN=localhost/O=Hive" 2>/dev/null

openssl x509 -req -in localhost.csr \
  -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out localhost.crt -days "$DAYS" \
  -extfile san.cnf -extensions ext 2>/dev/null

rm -f localhost.csr san.cnf

echo ""
echo "Wrote .certs/localhost.crt and .certs/localhost.key"
echo ""
echo "One more step — trust the CA, or the browser will warn on every load:"
echo ""
echo "  Windows (no admin needed, covers Chrome and Edge):"
echo "    certutil -user -addstore Root .certs\\ca.crt"
echo ""
echo "  Firefox keeps its own store: Settings > Privacy & Security >"
echo "  Certificates > View Certificates > Authorities > Import .certs/ca.crt"
echo ""
echo "To undo later:  certutil -user -delstore Root \"Hive local development CA\""
