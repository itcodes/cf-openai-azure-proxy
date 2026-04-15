#!/bin/sh
set -eu

DEV_VARS_FILE="/app/.dev.vars"
GENERATED_VARS=0

write_var() {
  key="$1"
  value="$2"

  if [ -n "$value" ]; then
    escaped=$(printf "%s" "$value" | sed "s/'/'\\\\''/g")
    printf "%s='%s'\n" "$key" "$escaped" >> "$DEV_VARS_FILE"
    GENERATED_VARS=1
  fi
}

rm -f "$DEV_VARS_FILE"

write_var "AZURE_API_KEY" "${AZURE_API_KEY:-}"
write_var "AZURE_OAI_ENDPOINT" "${AZURE_OAI_ENDPOINT:-}"
write_var "AZURE_INFER_ENDPOINT" "${AZURE_INFER_ENDPOINT:-}"
write_var "CLIENT_API_KEYS" "${CLIENT_API_KEYS:-}"
write_var "AZURE_OAI_API_VERSION" "${AZURE_OAI_API_VERSION:-}"
write_var "AZURE_INFER_API_VERSION" "${AZURE_INFER_API_VERSION:-}"
write_var "MODEL_MAPPING" "${MODEL_MAPPING:-}"

if [ "$GENERATED_VARS" -eq 0 ]; then
  rm -f "$DEV_VARS_FILE"
fi

exec wrangler dev --local --ip 0.0.0.0 --port 8787
