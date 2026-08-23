#!/usr/bin/env bash
# Manage an environment's `allowIps` — the source addresses that may reach the
# deployment at all (docs 07).
#
# Usage: scripts/allowlist.sh <env> list
#        scripts/allowlist.sh <env> add <cidr|this>
#        scripts/allowlist.sh <env> rm  <cidr>
#
# Two things hold the list, and both are written here so they cannot drift:
#
#   config/kelabo.json   the source of truth. CDK reads it, so a deploy always
#                        re-asserts exactly this.
#   AWS                  the WAF IPSets (CloudFront) and the ALB listener rules
#                        (Gateway), edited live so an address works in seconds
#                        rather than after a CloudFormation update.
#
# The live edit is skipped, with a message, when the environment is not locked
# yet: going from an open deployment to a locked one adds a stack and turns the
# ALB's default action into a 403, and neither is something a rule edit can do.
# That first transition needs a deploy; every addition after it does not — up to
# the point where the list outgrows the rules CDK made, since an ALB rule holds
# five addresses and a sixth needs a new rule, which is also a deploy.
set -euo pipefail

ENV="${1:?usage: allowlist.sh <env> <list|add|rm> [cidr]}"
CMD="${2:?usage: allowlist.sh <env> <list|add|rm> [cidr]}"
ARG="${3:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$ROOT/config/kelabo.json"

read -r APP ENDPOINT REGION LOCKED <<EOF
$(cd "$ROOT/config" && KELABO_ENV="$ENV" node --input-type=module -e "
import('./loadConfig.mjs').then((m) => {
  const c = m.loadConfig(process.env.KELABO_ENV);
  console.log([c.app, c.endpoint, c.region, c.allowIps.length ? 'locked' : 'open'].join(' '));
}).catch((e) => { console.error(e.message); process.exit(1); });
")
EOF

PREFIX="$APP-$ENDPOINT"

# --- reading the config list -------------------------------------------------

config_list() {
  node -e "
    const c = require('$CONFIG');
    console.log((c.environments['$ENV'].allowIps || []).join('\n'));
  "
}

# Writes the list back, preserving the rest of the file. node rather than jq:
# jq is not a dependency of anything else here, and a missing one would fail
# halfway through a change.
config_write() {
  node -e "
    const fs = require('fs');
    const c = JSON.parse(fs.readFileSync('$CONFIG', 'utf8'));
    // filter(Boolean): an empty bash array expands to one empty argument, and
    // writing [\"\"] would put an address that matches nothing into the list.
    c.environments['$ENV'].allowIps = process.argv.slice(1).filter(Boolean);
    fs.writeFileSync('$CONFIG', JSON.stringify(c, null, 2) + '\n');
  " "$@"
}

stack_output() {
  aws cloudformation describe-stacks --stack-name "$1" --region "$2" \
    --query "Stacks[0].Outputs[?OutputKey=='$3'].OutputValue" --output text 2>/dev/null || true
}

# --- what AWS currently holds ------------------------------------------------

live_ipset() { # <name> <id> -> addresses, one per line
  aws wafv2 get-ip-set --name "$1" --id "$2" --scope CLOUDFRONT --region us-east-1 \
    --query 'IPSet.Addresses[]' --output text 2>/dev/null | tr '\t' '\n' || true
}

rule_arns() { # -> the gateway's allowIps listener rule ARNs, one per line
  stack_output "$PREFIX-gateway" "$REGION" GatewayAllowIpRuleArns | tr ',' '\n' | grep -v '^$' || true
}

live_rule_cidrs() { # -> cidrs the gateway ALB currently admits, one per line
  local arn
  while read -r arn; do
    [ -z "$arn" ] && continue
    aws elbv2 describe-rules --rule-arns "$arn" --region "$REGION" \
      --query 'Rules[0].Conditions[?Field==`source-ip`].SourceIpConfig.Values[]' \
      --output text 2>/dev/null | tr '\t' '\n' | grep -v '^None$' || true
  done < <(rule_arns)
}

# --- applying live -----------------------------------------------------------

apply_live() {
  local v4=() v6=() all=() cidr
  while read -r cidr; do
    [ -z "$cidr" ] && continue
    all+=("$cidr")
    case "$cidr" in *:*) v6+=("$cidr");; *) v4+=("$cidr");; esac
  done < <(config_list)

  local arns=()
  mapfile -t arns < <(rule_arns)
  local v4id v4name v6id v6name
  v4id="$(stack_output "$PREFIX-waf" us-east-1 AllowIpSetV4Id)"
  v4name="$(stack_output "$PREFIX-waf" us-east-1 AllowIpSetV4Name)"
  v6id="$(stack_output "$PREFIX-waf" us-east-1 AllowIpSetV6Id)"
  v6name="$(stack_output "$PREFIX-waf" us-east-1 AllowIpSetV6Name)"

  if [ -z "$v4id" ] || [ "${#arns[@]}" -eq 0 ]; then
    echo
    echo "  Config updated, AWS not touched: $ENV is not locked yet."
    echo "  Locking adds the WAF stack and turns the Gateway ALB's default"
    echo "  action into a 403, which only a deploy can do:  make deploy env=$ENV"
    return 0
  fi

  update_ipset "$v4name" "$v4id" "${v4[@]:-}"
  update_ipset "$v6name" "$v6id" "${v6[@]:-}"
  sync_rules "${#arns[@]}" "${all[@]:-}" || return 1
  echo "  Live: WAF IPSets and ${#arns[@]} Gateway ALB rule(s) now match the config."
}

update_ipset() { # <name> <id> <cidr...>
  local name="$1" id="$2"; shift 2
  local token
  token="$(aws wafv2 get-ip-set --name "$name" --id "$id" --scope CLOUDFRONT \
    --region us-east-1 --query LockToken --output text)"
  # As JSON rather than shell words, because one family is routinely empty (an
  # IPv4-only network has nothing to put in the v6 set) and `--addresses` with
  # no values is a CLI error, not an empty list.
  local addrs
  addrs="$(printf '%s\n' "$@" | node -e "
    let d = '';
    process.stdin.on('data', (c) => (d += c))
      .on('end', () => console.log(JSON.stringify(d.split('\n').map(s => s.trim()).filter(Boolean))));
  ")"
  # A lock token is a compare-and-swap: if anything else changed the set since
  # the read, this call is rejected rather than silently clobbering it.
  aws wafv2 update-ip-set --name "$name" --id "$id" --scope CLOUDFRONT \
    --region us-east-1 --lock-token "$token" --addresses "$addrs" >/dev/null
}

# Rewrites the rules' source-ip conditions to exactly the config list. A
# replace rather than an add-what-is-missing diff, because a rule condition is
# a set: `rm` needs no separate revoke step, and a rule cannot drift.
#
# The chunking must match gateway-ecs-stack.js — five addresses per rule, in
# config order — or an address would land in a rule the next deploy rewrites
# with something else.
sync_rules() { # <rule-count> <cidr...>
  local count="$1"; shift
  local all=() a
  for a in "$@"; do [ -n "$a" ] && all+=("$a"); done

  local need=$(( (${#all[@]} + 4) / 5 ))
  if [ "$need" -gt "$count" ]; then
    echo
    echo "  Config updated, AWS not touched: $need ALB rules are needed and only"
    echo "  $count exist. A rule holds five addresses, and making another one is"
    echo "  CDK's:  make gateway env=$ENV"
    return 1
  fi

  local arns=(); mapfile -t arns < <(rule_arns)
  local i chunk values
  for (( i = 0; i < count; i++ )); do
    chunk=("${all[@]:$((i * 5)):5}")
    # An emptied rule cannot have zero values — ALB rejects that — so it is
    # parked on a documentation-only address that matches nothing real.
    [ "${#chunk[@]}" -eq 0 ] && chunk=("192.0.2.0/32")
    values="$(printf '%s,' "${chunk[@]}")"
    aws elbv2 modify-rule --rule-arn "${arns[$i]}" --region "$REGION" \
      --conditions "Field=source-ip,SourceIpConfig={Values=[${values%,}]}" >/dev/null
  done
}

# --- this device's public addresses ------------------------------------------

this_device() {
  local v4 v6
  # checkip is AWS's own, so this adds no third party to a security control.
  v4="$(curl -4 -s --max-time 8 https://checkip.amazonaws.com || true)"
  v6="$(curl -6 -s --max-time 8 https://checkip.amazonaws.com || true)"
  [ -n "$v4" ] && echo "${v4//[$'\r\n ']/}/32"
  # Absent on an IPv4-only network, which is normal and not an error. It is
  # still worth adding when present: CloudFront answers on IPv6, so a browser
  # that prefers it arrives from an address the IPv4 entry does not cover.
  [ -n "$v6" ] && echo "${v6//[$'\r\n ']/}/128"
}

# --- commands ----------------------------------------------------------------

case "$CMD" in
  list)
    echo
    echo "  $PREFIX — $LOCKED"
    echo
    echo "  config/kelabo.json:"
    config_list | sed 's/^/    /' | grep -v '^ *$' || echo "    (empty — open to everyone)"
    v4id="$(stack_output "$PREFIX-waf" us-east-1 AllowIpSetV4Id)"
    if [ -n "$v4id" ]; then
      echo
      echo "  live (CloudFront WAF):"
      { live_ipset "$(stack_output "$PREFIX-waf" us-east-1 AllowIpSetV4Name)" "$v4id"
        live_ipset "$(stack_output "$PREFIX-waf" us-east-1 AllowIpSetV6Name)" \
                   "$(stack_output "$PREFIX-waf" us-east-1 AllowIpSetV6Id)"; } \
        | grep -v '^$' | sed 's/^/    /' || echo "    (none)"
      echo
      echo "  live (Gateway ALB listener rules):"
      live_rule_cidrs | grep -v '^$' | sed 's/^/    /' || echo "    (none)"
      echo "    (plus /internal/* from anywhere — the control plane's own"
      echo "     server-to-server calls, authenticated by the internal JWT)"
    else
      echo
      echo "  live: no WAF stack — this environment is open."
    fi
    echo
    echo "  this device: $(this_device | tr '\n' ' ')"
    echo
    ;;

  add)
    [ -n "$ARG" ] || { echo "usage: allowlist.sh $ENV add <cidr|this>" >&2; exit 1; }
    if [ "$ARG" = "this" ]; then mapfile -t adding < <(this_device); else adding=("$ARG"); fi
    mapfile -t current < <(config_list | grep -v '^$' || true)
    for cidr in "${adding[@]}"; do
      if printf '%s\n' "${current[@]:-}" | grep -qxF "$cidr"; then
        echo "  already listed: $cidr"
      else
        current+=("$cidr")
        echo "  added: $cidr"
      fi
    done
    config_write "${current[@]}"
    apply_live
    ;;

  rm)
    [ -n "$ARG" ] || { echo "usage: allowlist.sh $ENV rm <cidr>" >&2; exit 1; }
    mapfile -t current < <(config_list | grep -v '^$' | grep -vxF "$ARG" || true)
    config_write "${current[@]:-}"
    echo "  removed: $ARG"
    if [ "${#current[@]}" -eq 0 ]; then
      echo
      echo "  The list is now empty, which means OPEN TO EVERYONE — and that"
      echo "  takes a deploy, because the WAF stack and the ALB's default 403"
      echo "  are CDK's:  make deploy env=$ENV"
    else
      # No revoke step: sync_rules replaces each rule's condition set, so the
      # removed address is gone the moment the rules match the config again.
      apply_live
    fi
    ;;

  *)
    echo "usage: allowlist.sh <env> <list|add|rm> [cidr]" >&2
    exit 1
    ;;
esac
