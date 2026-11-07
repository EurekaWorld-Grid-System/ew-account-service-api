# Deployment on ECS Fargate (internal only)

| File | Purpose |
| --- | --- |
| `config.env` | Every ID and config value used for deployment. No secrets. |
| `task-definition.json` | Task definition template. `__PLACEHOLDERS__` are filled in from `config.env`. |
| `deploy.sh` | Redeploys the current commit: build, push, new task definition revision, roll the service, target health. Refuses to run while `config.env` still has `SET_DURING_SETUP` values. |

All commands run on the Linux Docker server, which has the AWS CLI and Docker, from the repo root.

## How it is reached

Account Service API is an **internal-only** component (EurekaWorld_Account_Service_Design_v1.0 §9, Developers Guide "Ports and exposure"): container port 8080, non-root, never reachable from the internet. Callers reach it through the existing internal ALB. During the migration out of `ew-portal-api` its hostname is `apiaccounttemp.eurekaworld.internal`; `apiaccount.eurekaworld.internal` keeps pointing to `ew-portal-api` until every account function has moved:

```
caller task (ew-portal-api, …)
  ──HTTP 8080──▶ apiaccounttemp.eurekaworld.internal      (Route 53 private zone, CNAME)
              ──▶ internal ALB ew-internal-alb, listener 8080, host-header rule
              ──▶ target group ew-account-service-api-tg (ip, port 8080, /health)
              ──▶ Fargate task, SG ew-account-service-api-ecs (inbound 8080 from the internal ALB SG only)
```

A caller can reach it only if its task security group is in the internal ALB security group's inbound 8080 rule (`INTERNAL_ALB_SG`). Callers that already call `apiaccount.eurekaworld.internal` (including `ew-portal-api`, the v1.0 caller) are in it.

## Deployed resources

| Resource | Value |
| --- | --- |
| URL | `http://apiaccounttemp.eurekaworld.internal:8080` (VPC only; `/health`) |
| ECS | cluster `default`, service `ew-account-service-api`, Fargate, 0.25 vCPU / 512 MB (`CPU`/`MEMORY`), 1 task |
| Image | ECR `ew-account-service-api`, tagged `<short sha>` and `latest`, scanned on push, last 10 kept |
| Load balancer | Internal ALB (`INTERNAL_ALB_DNS`), 8080 listener rule `LISTENER_RULE_PRIORITY` (host `$HOST`) → target group `ew-account-service-api-tg` (port 8080, `/health`) |
| Security group | `ew-account-service-api-ecs`: inbound 8080 from the internal ALB SG only |
| IAM | `ew-account-service-api-exec` (execution role: image pull and logs only). No task role. |
| Logs | CloudWatch `/ecs/ew-account-service-api`, JSON, 30-day retention |
| DNS | Private zone `eurekaworld.internal`: CNAME `apiaccounttemp` → internal ALB |
| Health checks | Container: Node HTTP check on `/health` (`node:22-alpine` has no `curl`), 30 s interval, `startPeriod` 30. Service grace period 30 s. Target group: healthy 2, unhealthy 3 |
| Rollback | Deployment circuit breaker with automatic rollback |
| Secrets | None yet. When registration is added (Aurora password, mail gateway key, JWT keys): one plain-text secret per value, `ew-account-service-api/<value>`, plus `secretsmanager:GetSecretValue` on those secrets for the execution role |

## Redeploy

```bash
git pull
bash deploy/deploy.sh
```

The script refuses to run with uncommitted changes. Every image is tagged with the commit, and `/health` reports `version: <package version>+<short sha>`.

## One-time infrastructure setup

Run once, in **one terminal**, starting with `source deploy/config.env`, after the first commit is pushed (step 2 tags the image with it). Each step prints an ID or a short confirmation; stop on any error. When done, put the printed values into `config.env` (`INTERNAL_L8080`, `INTERNAL_ZONE`, `LISTENER_RULE_PRIORITY`, `SG`, `TG`) and commit.

```bash
source deploy/config.env

# 0. Look up the shared internal pieces. Put INTERNAL_L8080, INTERNAL_ZONE and a free
#    LISTENER_RULE_PRIORITY into config.env (and keep them set in this shell).
ALB_ARN=$(aws elbv2 describe-load-balancers --region $R \
  --query "LoadBalancers[?DNSName=='$INTERNAL_ALB_DNS'].LoadBalancerArn" --output text); echo "ALB_ARN=$ALB_ARN"
INTERNAL_L8080=$(aws elbv2 describe-listeners --load-balancer-arn $ALB_ARN --region $R \
  --query "Listeners[?Port==\`8080\`].ListenerArn" --output text); echo "INTERNAL_L8080=$INTERNAL_L8080"
aws elbv2 describe-rules --listener-arn $INTERNAL_L8080 --region $R \
  --query "Rules[].{priority:Priority,hosts:Conditions[?Field=='host-header'].Values|[0]}" --output table
INTERNAL_ZONE=$(aws route53 list-hosted-zones-by-name --dns-name eurekaworld.internal \
  --query "HostedZones[?Name=='eurekaworld.internal.' && Config.PrivateZone].Id" --output text | sed 's|/hostedzone/||')
echo "INTERNAL_ZONE=$INTERNAL_ZONE"
LISTENER_RULE_PRIORITY=<a free priority from the table above>

# 1. ECR repository (scan on push, keep last 10 images)
aws ecr create-repository --repository-name $APP --region $R \
  --image-scanning-configuration scanOnPush=true --query repository.repositoryUri --output text
aws ecr put-lifecycle-policy --repository-name $APP --region $R --lifecycle-policy-text \
  '{"rules":[{"rulePriority":1,"description":"keep last 10","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":10},"action":{"type":"expire"}}]}' \
  --query repositoryName --output text

# 2. First image (deploy.sh pushes later ones)
aws ecr get-login-password --region $R | docker login --username AWS --password-stdin $REGISTRY
SHA=$(git rev-parse --short HEAD)
docker build --platform linux/amd64 --build-arg GIT_COMMIT=$(git rev-parse HEAD) -t $ECR:$SHA -t $ECR:latest .
docker push $ECR:$SHA && docker push $ECR:latest

# 3. Execution role: image pull and logs only (no secrets yet)
aws iam create-role --role-name $APP-exec --query Role.Arn --output text \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name $APP-exec \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

# 4. Log group
aws logs create-log-group --log-group-name $LOG_GROUP --region $R
aws logs put-retention-policy --log-group-name $LOG_GROUP --retention-in-days 30 --region $R

# 5. Security group: 8080 from the internal ALB only. Put the printed ID into config.env as SG=
SG=$(aws ec2 create-security-group --group-name $APP-ecs --description "$APP ECS tasks (internal only)" \
  --vpc-id $VPC --region $R --query GroupId --output text); echo "SG=$SG"
aws ec2 authorize-security-group-ingress --group-id $SG --protocol tcp --port 8080 \
  --source-group $INTERNAL_ALB_SG --region $R --query Return --output text

# 6. First task definition (rendered from the template)
TASKDEF=$(mktemp)
sed -e "s|__APP__|$APP|g" -e "s|__CPU__|$CPU|g" -e "s|__MEMORY__|$MEMORY|g" -e "s|__PORT__|$PORT|g" \
    -e "s|__EXEC_ROLE_ARN__|$EXEC_ROLE_ARN|g" -e "s|__IMAGE__|$ECR:$SHA|g" \
    -e "s|__LOG_GROUP__|$LOG_GROUP|g" -e "s|__R__|$R|g" deploy/task-definition.json > $TASKDEF
aws ecs register-task-definition --cli-input-json file://$TASKDEF --region $R \
  --query taskDefinition.taskDefinitionArn --output text
# If IAM reports the role isn't ready, wait 10 seconds and rerun the line above.

# 7. Target group + host rule on the internal ALB's 8080 listener. Put the printed ARN into config.env as TG=
TG=$(aws elbv2 create-target-group --name $APP-tg --protocol HTTP --port 8080 --vpc-id $VPC \
  --target-type ip --health-check-path /health --matcher HttpCode=200 \
  --healthy-threshold-count 2 --unhealthy-threshold-count 3 \
  --region $R --query "TargetGroups[0].TargetGroupArn" --output text); echo "TG=$TG"
aws elbv2 modify-target-group-attributes --target-group-arn $TG --region $R \
  --attributes Key=deregistration_delay.timeout_seconds,Value=30 >/dev/null
aws elbv2 create-rule --listener-arn $INTERNAL_L8080 --priority $LISTENER_RULE_PRIORITY --region $R \
  --conditions Field=host-header,Values=$HOST --actions Type=forward,TargetGroupArn=$TG \
  --query "Rules[0].RuleArn" --output text

# 8. ECS service (circuit breaker with automatic rollback).
#    assignPublicIp=ENABLED is for OUTBOUND only (ECR, CloudWatch; no NAT in use).
#    The SG allows no inbound traffic except 8080 from the internal ALB.
aws ecs create-service --cluster $CLUSTER --service-name $APP --task-definition $APP \
  --desired-count 1 --launch-type FARGATE --health-check-grace-period-seconds 30 \
  --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[$SG],assignPublicIp=ENABLED}" \
  --load-balancers "targetGroupArn=$TG,containerName=$APP,containerPort=8080" \
  --deployment-configuration "deploymentCircuitBreaker={enable=true,rollback=true},minimumHealthyPercent=100,maximumPercent=200" \
  --region $R --query service.serviceArn --output text
aws ecs wait services-stable --cluster $CLUSTER --services $APP --region $R && echo STABLE

# 9. Internal DNS: CNAME in the private zone (CREATE fails rather than overwrite an existing record)
aws route53 change-resource-record-sets --hosted-zone-id $INTERNAL_ZONE --query ChangeInfo.Status --output text \
  --change-batch "{\"Changes\":[{\"Action\":\"CREATE\",\"ResourceRecordSet\":{\"Name\":\"$HOST\",\"Type\":\"CNAME\",\"TTL\":60,
  \"ResourceRecords\":[{\"Value\":\"$INTERNAL_ALB_DNS\"}]}}]}"

# 10. Verify
aws elbv2 describe-target-health --target-group-arn $TG --region $R \
  --query "TargetHealthDescriptions[].TargetHealth.State" --output text        # healthy
```

### Verifying from inside the VPC

The hostname resolves only inside the VPC, and the internal ALB only accepts callers whose SG is in its 8080 rule. From a caller task that has ECS Exec enabled (for example ew-portal-api), or any EC2 in the VPC whose SG is in that rule:

```bash
curl -s http://apiaccounttemp.eurekaworld.internal:8080/health
# {"status":"ok","service":"ew-account-service-api","version":"0.1.0+<sha>"}
```

From a Node container without curl:

```bash
node -e "require('http').get('http://apiaccounttemp.eurekaworld.internal:8080/health',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(r.statusCode,d))})"
```

## Roll back by hand

```bash
source deploy/config.env
aws ecs list-task-definitions --family-prefix $APP --sort DESC --max-items 5 --region $R --output text
aws ecs update-service --cluster $CLUSTER --service $APP --task-definition $APP:<revision> --region $R \
  --query service.taskDefinition --output text
aws ecs wait services-stable --cluster $CLUSTER --services $APP --region $R && echo STABLE
```

## Logs

```bash
source deploy/config.env
# AWS CLI v2:  aws logs tail $LOG_GROUP --since 30m --region $R
# AWS CLI v1:
aws logs filter-log-events --log-group-name $LOG_GROUP --region $R \
  --start-time $(( ($(date +%s) - 1800) * 1000 )) --query "events[].message" --output text | tr '\t' '\n' | tail -20
```

## Troubleshooting a service that won't become stable

```bash
aws ecs describe-services --cluster $CLUSTER --services $APP --region $R --query "services[0].events[:5]"
aws elbv2 describe-target-health --target-group-arn $TG --region $R
```

- Targets `unhealthy` with `Target.Timeout`: the internal ALB can't reach the task on 8080. Check step 5 (inbound from `INTERNAL_ALB_SG`) and that the internal ALB SG's outbound rules allow 8080 to the VPC.
- A `rolloutState: FAILED` can be a stale stamp from an earlier deployment: check `runningCount`/`desiredCount` and target health before concluding anything.
