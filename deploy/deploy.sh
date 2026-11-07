#!/usr/bin/env bash
# Redeploy the current commit of ew-account-service-api to ECS Fargate:
# build → push to ECR → register a task definition revision → roll the service → check target health.
#
#   bash deploy/deploy.sh                 # refuses to run with uncommitted changes
#   bash deploy/deploy.sh --allow-dirty   # testing only
#
# Requires: AWS CLI, Docker. One-time infrastructure setup: deploy/README.md.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
# shellcheck source=/dev/null
source "$DIR/config.env"

INCOMPLETE="$(grep -n 'SET_DURING_SETUP' "$DIR/config.env" | grep -Ev '^[0-9]+:[[:space:]]*#' || true)"
if [[ -n "$INCOMPLETE" ]]; then
  echo "ERROR: deploy/config.env is incomplete (finish the one-time setup in deploy/README.md):" >&2
  echo "$INCOMPLETE" >&2
  exit 1
fi

cd "$ROOT"

# ── 1. Which commit ──────────────────────────────────────────────────────────
if [[ "${1:-}" != "--allow-dirty" && -n "$(git status --porcelain)" ]]; then
  echo "ERROR: working tree has uncommitted changes. Commit or stash them first." >&2
  exit 1
fi
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
FULL_SHA="$(git rev-parse HEAD)"
SHA="$(git rev-parse --short HEAD)"
IMAGE="$ECR:$SHA"
echo "==> Deploying $APP  branch=$BRANCH  commit=$SHA"

# ── 2. Build and push ────────────────────────────────────────────────────────
aws ecr get-login-password --region "$R" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
docker build --platform linux/amd64 --build-arg GIT_COMMIT="$FULL_SHA" -t "$IMAGE" -t "$ECR:latest" .
docker push "$IMAGE"
docker push "$ECR:latest"

# ── 3. Render and register the task definition ──────────────────────────────
TASKDEF="$(mktemp)"
trap 'rm -f "$TASKDEF"' EXIT
sed -e "s|__APP__|$APP|g" \
    -e "s|__CPU__|$CPU|g" \
    -e "s|__MEMORY__|$MEMORY|g" \
    -e "s|__PORT__|$PORT|g" \
    -e "s|__EXEC_ROLE_ARN__|$EXEC_ROLE_ARN|g" \
    -e "s|__IMAGE__|$IMAGE|g" \
    -e "s|__AURORA_HOST__|$AURORA_HOST|g" \
    -e "s|__AURORA_PORT__|$AURORA_PORT|g" \
    -e "s|__AURORA_USER__|$AURORA_USER|g" \
    -e "s|__INDEX_DB_NAME__|$INDEX_DB_NAME|g" \
    -e "s|__GRID_DB_NAME__|$GRID_DB_NAME|g" \
    -e "s|__ROBUST_BASE_URL__|$ROBUST_BASE_URL|g" \
    -e "s|__BMS_ADAPTER_BASE_URL__|$BMS_ADAPTER_BASE_URL|g" \
    -e "s|__ACCOUNT_SERVICE_API_KEY_SECRET__|$ACCOUNT_SERVICE_API_KEY_SECRET|g" \
    -e "s|__AURORA_PASSWORD_SECRET__|$AURORA_PASSWORD_SECRET|g" \
    -e "s|__BMS_ADAPTER_API_KEY_SECRET__|$BMS_ADAPTER_API_KEY_SECRET|g" \
    -e "s|__LOG_GROUP__|$LOG_GROUP|g" \
    -e "s|__R__|$R|g" \
    "$DIR/task-definition.json" > "$TASKDEF"

if grep -q "__[A-Z_0-9]*__" "$TASKDEF"; then
  echo "ERROR: unreplaced placeholders in task definition:" >&2
  grep -o "__[A-Z_0-9]*__" "$TASKDEF" | sort -u >&2
  exit 1
fi

REVISION="$(aws ecs register-task-definition --cli-input-json "file://$TASKDEF" --region "$R" \
  --query taskDefinition.revision --output text)"
echo "==> Registered task definition $APP:$REVISION"

# ── 4. Roll the service ──────────────────────────────────────────────────────
aws ecs update-service --cluster "$CLUSTER" --service "$APP" --task-definition "$APP:$REVISION" \
  --region "$R" --query service.taskDefinition --output text
echo "==> Waiting for the service to become stable (2-5 min)..."
aws ecs wait services-stable --cluster "$CLUSTER" --services "$APP" --region "$R"

# ── 5. Verify ────────────────────────────────────────────────────────────────
# Internal-only: the hostname resolves inside the VPC only, so check the internal
# ALB's view of the targets (a /health call from a caller task is in deploy/README.md).
echo "==> Target health:"
aws elbv2 describe-target-health --target-group-arn "$TG" --region "$R" \
  --query "TargetHealthDescriptions[].{target:Target.Id,state:TargetHealth.State,reason:TargetHealth.Reason}" --output table
echo "==> Done: $APP:$REVISION ($SHA) is live at http://$HOST:8080 (VPC only)"
