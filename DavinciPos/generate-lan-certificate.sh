#!/usr/bin/env sh
set -eu
: "${LAN_IP:=192.168.1.10}"
: "${LAN_DNS:=davincipos.local}"
: "${CERT_DIR:=.}"
mkdir -p "$CERT_DIR"
openssl genrsa -out "$CERT_DIR/davincipos-local-ca.key" 4096
openssl req -x509 -new -nodes -key "$CERT_DIR/davincipos-local-ca.key" -sha256 -days 3650 \
  -subj "/CN=DavinciPos Local Network CA" -out "$CERT_DIR/davincipos-local-ca.crt"
openssl genrsa -out "$CERT_DIR/lan-key.pem" 2048
openssl req -new -key "$CERT_DIR/lan-key.pem" -out "$CERT_DIR/lan-server.csr" \
  -subj "/CN=$LAN_DNS"
cat > "$CERT_DIR/lan-server.ext" <<EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=@alt_names
[alt_names]
DNS.1=$LAN_DNS
IP.1=$LAN_IP
IP.2=127.0.0.1
EOF
openssl x509 -req -in "$CERT_DIR/lan-server.csr" \
  -CA "$CERT_DIR/davincipos-local-ca.crt" -CAkey "$CERT_DIR/davincipos-local-ca.key" \
  -CAcreateserial -out "$CERT_DIR/lan-cert.pem" -days 825 -sha256 -extfile "$CERT_DIR/lan-server.ext"
rm -f "$CERT_DIR/lan-server.csr" "$CERT_DIR/lan-server.ext"
printf '\nCreated LAN HTTPS certificate for https://%s:3000 and https://%s:3000\n' "$LAN_IP" "$LAN_DNS"
printf 'Install davincipos-local-ca.crt as a trusted CA on every client device. Keep all .key files private.\n'
