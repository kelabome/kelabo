#!/usr/bin/env bash
# Build the SPA with the env's VITE_* values (from config), sync to the portal
# bucket and invalidate CloudFront.
# Usage: scripts/deploy-frontend.sh <env>
set -euo pipefail

ENV="${1:?usage: deploy-frontend.sh <env>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="kelabo"

eval "$(cd "$ROOT/config" && KELABO_ENV="$ENV" node --input-type=module -e "
import('./loadConfig.mjs').then((m) => {
  const c = m.loadConfig(process.env.KELABO_ENV);
  const out = {
    VITE_API_BASE_URL: c.apiBaseUrl,
    VITE_GATEWAY_BASE_URL: c.gatewayBaseUrl,
    VITE_PORTAL_URL: c.portalUrl,
    VITE_SOCIAL_PROVIDERS: (c.auth?.socialProviders ?? []).join(','),
    // Empty when the env allows any domain — the sign-in page reads that as
    // open registration, exactly as the server does.
    VITE_ALLOWED_EMAIL_DOMAIN: c.allowedEmailDomain ?? '',
    // Display only — the deployment's own name on the sign-in page and the
    // browser tab. Empty falls back to generic wording.
    VITE_ORG_NAME: c.organizationName ?? '',
    VITE_ENV: c.endpoint,
    KELABO_REGION: c.region,
  };
  for (const [k, v] of Object.entries(out)) console.log(\`export \${k}='\${v}'\`);
});
")"

PORTAL_STACK="${APP}-${ENV}-portal"
get_output() {
  aws cloudformation describe-stacks \
    --stack-name "$PORTAL_STACK" --region "$KELABO_REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

BUCKET="$(get_output PortalBucketName)"
DIST_ID="$(get_output DistributionId)"
echo ">> portal bucket: $BUCKET"
echo ">> distribution:  $DIST_ID"

echo ">> building SPA with VITE_API_BASE_URL=$VITE_API_BASE_URL VITE_GATEWAY_BASE_URL=$VITE_GATEWAY_BASE_URL VITE_PORTAL_URL=$VITE_PORTAL_URL VITE_ENV=$VITE_ENV"
(cd "$ROOT/spa" && npm install && npm run build)

echo ">> syncing spa/dist -> s3://$BUCKET"
# --only-show-errors: the per-file progress lines are noise to whoever ran
# `make frontend` — a quiet sync that speaks only when something fails is the
# useful shape. The bucket/dist echoes above are the receipt.
#
# Assets first, and `--exclude` the entry document: every filename under
# assets/ is content-hashed by Vite, so those objects are immutable by
# construction and can be cached forever. index.html is the opposite — one
# mutable name pointing at this build's hashes — and it goes up separately
# below, with headers that say so.
aws s3 sync "$ROOT/spa/dist" "s3://$BUCKET" --delete --region "$KELABO_REGION" --only-show-errors \
  --exclude "*.html" --cache-control "public,max-age=31536000,immutable"
# Then the entry document, which keeps its name forever and must NOT be cached:
# it is the file that names the current asset hashes, and the `--delete` above
# has just removed the previous build's. A stale index.html therefore does not
# merely show an old page — it names objects that no longer exist, and S3
# answers a missing object with **403** (the distribution holds no
# `s3:ListBucket`, deliberately). The symptom is a blank page logging
# `ERR_ABORTED 403 (Forbidden)` for a bundle nobody can find.
#
# The invalidation below used to be the only thing preventing that, which made
# it a single point of failure: one deploy interrupted between the sync and the
# invalidation and every visitor holding a cached document has a broken site
# until somebody notices. That happened. Revalidating means the worst a missed
# invalidation can do is cost a round trip on a 1.5KB file.
aws s3 sync "$ROOT/spa/dist" "s3://$BUCKET" --delete --region "$KELABO_REGION" --only-show-errors \
  --exclude "*" --include "*.html" --cache-control "public,max-age=0,must-revalidate"

# The speech model and its WebAssembly runtime, re-uploaded compressed.
#
# Together they are ~13.5MB, which is an order of magnitude more than the rest
# of the SPA put together, and CloudFront will not compress an object over 10MB
# however `compress: true` is set — so the runtime would ship raw. Brotli takes
# the pair from 13.54MB to 4.29MB, measured.
#
# The sync above already put them in place; this replaces them with compressed
# copies carrying the right headers. Done as a second pass rather than by
# excluding them from the sync, so that a failure here leaves the site working
# with uncompressed assets rather than with none.
#
# `immutable` is safe only because Vite content-hashes both filenames: a new
# model or a runtime upgrade is a new URL, so nothing has to be expired. Without
# it the invalidation below would make every user re-download 4.29MB on every
# deploy, for files that had not changed.
#
# These two objects are stored brotli-only, so they are served with
# `Content-Encoding: br` to every client REGARDLESS of what it said it accepts —
# S3 cannot content-negotiate, and there is no uncompressed copy to fall back
# to. That is an assumption, not a guarantee: it holds because brotli over HTTPS
# has been in Chrome since 50, Firefox 44 and Safari 11, and nothing that old
# can run WebAssembly-backed capture anyway. If that ever stops being true the
# symptom is a corrupt model, not a 404.
if command -v brotli >/dev/null 2>&1; then
  echo ">> re-uploading wasm/onnx brotli-compressed"
  for f in "$ROOT"/spa/dist/assets/*.wasm "$ROOT"/spa/dist/assets/*.onnx; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    case "$name" in
      *.wasm) ctype="application/wasm" ;;
      *) ctype="application/octet-stream" ;;
    esac
    brotli -f -q 9 -o "$f.br" "$f"
    aws s3 cp "$f.br" "s3://$BUCKET/assets/$name" \
      --region "$KELABO_REGION" --only-show-errors \
      --content-type "$ctype" \
      --content-encoding br \
      --cache-control "public,max-age=31536000,immutable"
    echo "   $name  $(du -h "$f" | cut -f1) -> $(du -h "$f.br" | cut -f1)"
    rm -f "$f.br"
  done
else
  # Not fatal: the assets are already uploaded uncompressed and work. Said out
  # loud because the difference is 9MB per first-time visitor, which is the kind
  # of regression that is invisible from a developer machine on a fast link.
  echo ">> WARNING: brotli not installed - wasm/onnx ship uncompressed (13.5MB not 4.3MB)"
fi

# Printed rather than swallowed, and last, so the line that says the deploy
# finished is preceded by proof that the step which makes it visible actually
# ran. `>/dev/null` hid exactly that.
echo ">> creating CloudFront invalidation /*"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" \
  --query "Invalidation.{id:Id,status:Status}" --output table

echo "== frontend deployed (env=$ENV) =="
