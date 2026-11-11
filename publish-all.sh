#!/usr/bin/env bash
# Publishes all seven governance packages.
#
# The npm account has 2FA enabled, so a plain `npm publish` fails with EOTP.
# Two ways through it:
#
#   OTP=123456 ./publish-all.sh      # paste the 6-digit code from your authenticator
#   ./publish-all.sh                 # if ~/.npmrc already holds an automation token
#
# An automation token (npmjs.com → Access Tokens → Granular, "Automation" type)
# bypasses 2FA entirely and is the sane choice for seven packages in a row —
# a single OTP is only valid for about 30 seconds.
set -euo pipefail
cd "$(dirname "$0")"

FLAGS=()
if [ -n "${OTP:-}" ]; then
  FLAGS+=("--otp=$OTP")
fi

# Directory name differs from package name for dsh-ticket-context.
PACKAGES=(dsh-ticket dsh-trace dsh-cost-eval dsh-policy dsh-pii dsh-rate dsh-memo)

for pkg in "${PACKAGES[@]}"; do
  name=$(node -p "require('./packages/$pkg/package.json').name")
  version=$(node -p "require('./packages/$pkg/package.json').version")
  printf '==> %s@%s\n' "$name" "$version"
  (
    cd "packages/$pkg"
    npm run build >/dev/null
    npm publish "${FLAGS[@]+"${FLAGS[@]}"}"
  )
  echo
done

echo "all seven published."
