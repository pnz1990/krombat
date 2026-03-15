# --- CloudWatch Agent IAM Role (for Container Insights) ---

resource "aws_iam_role" "cloudwatch_agent" {
  name = "${var.cluster_name}-cloudwatch-agent"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "pods.eks.amazonaws.com" }
      Action    = ["sts:AssumeRole", "sts:TagSession"]
    }]
  })
}

resource "aws_iam_role_policy_attachment" "cloudwatch_agent" {
  role       = aws_iam_role.cloudwatch_agent.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

# --- CloudWatch Log Groups ---

resource "aws_cloudwatch_log_group" "rpg_system" {
  name              = "/eks/${var.cluster_name}/rpg-system"
  retention_in_days = 7
}

resource "aws_cloudwatch_log_group" "game" {
  name              = "/eks/${var.cluster_name}/game"
  retention_in_days = 7
}

resource "aws_cloudwatch_log_group" "kro" {
  name              = "/eks/${var.cluster_name}/kro"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "argocd" {
  name              = "/eks/${var.cluster_name}/argocd"
  retention_in_days = 30
}

# --- CloudWatch Dashboard ---

resource "aws_cloudwatch_dashboard" "krombat" {
  dashboard_name = "${var.cluster_name}-game"
  dashboard_body = jsonencode({
    widgets = [
      # Row 1: CPU — Average + Max per pod, including kro (#474)
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "CPU Utilization (%) — Avg and Max per Pod"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          metrics = [
            ["ContainerInsights", "pod_cpu_utilization", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "PodName", "rpg-backend", { label = "Backend avg", stat = "Average" }],
            ["ContainerInsights", "pod_cpu_utilization", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "PodName", "rpg-backend", { label = "Backend max", stat = "Maximum", color = "#d62728" }],
            ["ContainerInsights", "pod_cpu_utilization", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "PodName", "rpg-frontend", { label = "Frontend avg", stat = "Average" }],
            ["ContainerInsights", "pod_cpu_utilization", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "PodName", "rpg-frontend", { label = "Frontend max", stat = "Maximum", color = "#ff7f0e" }],
            ["ContainerInsights", "pod_cpu_utilization", "ClusterName", var.cluster_name, "Namespace", "kro", { label = "kro avg", stat = "Average", color = "#9467bd" }],
            ["ContainerInsights", "pod_cpu_utilization", "ClusterName", var.cluster_name, "Namespace", "kro", { label = "kro max", stat = "Maximum", color = "#8c564b" }]
          ]
        }
      },
      # Row 1 right: Memory — Average + Max per pod, including kro (#474)
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "Memory Utilization (%) — Avg and Max per Pod"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          metrics = [
            ["ContainerInsights", "pod_memory_utilization", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "PodName", "rpg-backend", { label = "Backend avg", stat = "Average" }],
            ["ContainerInsights", "pod_memory_utilization", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "PodName", "rpg-backend", { label = "Backend max", stat = "Maximum", color = "#d62728" }],
            ["ContainerInsights", "pod_memory_utilization", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "PodName", "rpg-frontend", { label = "Frontend avg", stat = "Average" }],
            ["ContainerInsights", "pod_memory_utilization", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "PodName", "rpg-frontend", { label = "Frontend max", stat = "Maximum", color = "#ff7f0e" }],
            ["ContainerInsights", "pod_memory_utilization", "ClusterName", var.cluster_name, "Namespace", "kro", { label = "kro avg", stat = "Average", color = "#9467bd" }],
            ["ContainerInsights", "pod_memory_utilization", "ClusterName", var.cluster_name, "Namespace", "kro", { label = "kro max", stat = "Maximum", color = "#8c564b" }]
          ]
        }
      },
      # Row 2: Network and Pod Restarts (including kro, #474)
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title   = "Network Traffic (bytes/sec)"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          stat    = "Average"
          metrics = [
            ["ContainerInsights", "pod_network_rx_bytes", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "PodName", "rpg-backend", { label = "Backend RX" }],
            ["ContainerInsights", "pod_network_tx_bytes", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "PodName", "rpg-backend", { label = "Backend TX" }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title   = "Pod Restarts — Backend, Frontend, kro (#474)"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 300
          stat    = "Maximum"
          metrics = [
            ["ContainerInsights", "pod_number_of_container_restarts", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "PodName", "rpg-backend", { label = "Backend Restarts", color = "#d62728" }],
            ["ContainerInsights", "pod_number_of_container_restarts", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "PodName", "rpg-frontend", { label = "Frontend Restarts", color = "#ff7f0e" }],
            ["ContainerInsights", "pod_number_of_container_restarts", "ClusterName", var.cluster_name, "Namespace", "kro", { label = "kro Restarts", color = "#9467bd" }]
          ]
        }
      },
      # Row 3: Replica readiness (shows actual replica count, not container count, #474)
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 12
        height = 6
        properties = {
          title   = "Ready Replicas — Backend, Frontend, kro (#474)"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          stat    = "Average"
          metrics = [
            ["ContainerInsights", "replicas_ready", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "Service", "rpg-backend", { label = "Backend replicas ready" }],
            ["ContainerInsights", "replicas_ready", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "Service", "rpg-frontend", { label = "Frontend replicas ready" }],
            ["ContainerInsights", "replicas_ready", "ClusterName", var.cluster_name, "Namespace", "kro", { label = "kro replicas ready", color = "#9467bd" }]
          ]
          annotations = {
            horizontal = [{ label = "Expected minimum", value = 3, color = "#2ca02c" }]
          }
        }
      },
      # Row 3 right: Active Dungeons — live CR count from gauge metric (#475)
      {
        type   = "metric"
        x      = 12
        y      = 12
        width  = 12
        height = 6
        properties = {
          title   = "Active Dungeons (Live CR Count) (#475)"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          stat    = "Maximum"
          metrics = [
            ["Krombat/Game", "ActiveDungeons", { label = "Active Dungeons", color = "#f5c518" }]
          ]
        }
      },
      # Row 4: Victory Rate and Attacks/Actions throughput (#474)
      {
        type   = "metric"
        x      = 0
        y      = 18
        width  = 12
        height = 6
        properties = {
          title   = "Victory Rate (Boss Defeats / 5 min) (#474)"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 300
          stat    = "Sum"
          metrics = [
            ["Krombat/Business", "DungeonVictory", { label = "Victories", color = "#2ca02c" }],
            ["Krombat/Business", "DungeonDefeat", { label = "Defeats", color = "#d62728" }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 18
        width  = 12
        height = 6
        properties = {
          title   = "Attacks & Actions per 5 min (#474)"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 300
          stat    = "Sum"
          metrics = [
            ["Krombat/Game", "AttackCount", { label = "Attacks", color = "#1f77b4" }],
            ["Krombat/Game", "ActionCount", { label = "Actions", color = "#ff7f0e" }]
          ]
        }
      },
      # Row 5: Backend API Logs and Errors (#474)
      {
        type   = "log"
        x      = 0
        y      = 24
        width  = 12
        height = 6
        properties = {
          title  = "Backend API Logs"
          region = var.region
          query  = "SOURCE '/eks/${var.cluster_name}/rpg-system' | fields @timestamp, level, msg, method, path, status, duration_ms | filter ispresent(method) | sort @timestamp desc | limit 50"
        }
      },
      {
        type   = "log"
        x      = 12
        y      = 24
        width  = 12
        height = 6
        properties = {
          title  = "Backend Errors (#474)"
          region = var.region
          query  = "SOURCE '/eks/${var.cluster_name}/rpg-system' | fields @timestamp, level, msg, path, status | filter level = \"error\" or level = \"ERROR\" or msg like /error/i | sort @timestamp desc | limit 20"
        }
      },
      # Row 6: Reaper Activity (#474)
      {
        type   = "log"
        x      = 0
        y      = 30
        width  = 12
        height = 6
        properties = {
          title  = "Dungeon Reaper Activity (#474)"
          region = var.region
          query  = "SOURCE '/eks/${var.cluster_name}/rpg-system' | fields @timestamp, @message | filter @message like /reaper/ | sort @timestamp desc | limit 20"
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 30
        width  = 12
        height = 6
        properties = {
          title   = "Reaper Success Count (#474)"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 600
          stat    = "Sum"
          metrics = [
            ["Krombat/Game", "ReaperSuccess", { label = "Reaper runs succeeded", color = "#2ca02c" }]
          ]
        }
      }
    ]
  })
}

# --- CloudWatch Alarms ---

resource "aws_cloudwatch_metric_alarm" "backend_restarts" {
  alarm_name          = "${var.cluster_name}-backend-restarts"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "pod_number_of_container_restarts"
  namespace           = "ContainerInsights"
  period              = 300
  statistic           = "Sum"
  threshold           = 3
  alarm_description   = "Backend pod restarted more than 3 times in 5 minutes"
  dimensions = {
    ClusterName = var.cluster_name
    Namespace   = "rpg-system"
  }
}

# --- Log Metric Filters ---

# Counts dungeon CR create events emitted by the Go backend
resource "aws_cloudwatch_log_metric_filter" "dungeon_created" {
  name           = "${var.cluster_name}-dungeon-created"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  pattern        = "dungeon created"

  metric_transformation {
    name          = "DungeonCreated"
    namespace     = "Krombat/Game"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

# Counts dungeon CR delete / cleanup events
resource "aws_cloudwatch_log_metric_filter" "dungeon_deleted" {
  name           = "${var.cluster_name}-dungeon-deleted"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  pattern        = "dungeon deleted"

  metric_transformation {
    name          = "DungeonDeleted"
    namespace     = "Krombat/Game"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

# Counts each successful reaper cleanup run logged by the reaper CronJob
resource "aws_cloudwatch_log_metric_filter" "reaper_success" {
  name           = "${var.cluster_name}-reaper-success"
  log_group_name = aws_cloudwatch_log_group.game.name
  pattern        = "reaper complete"

  metric_transformation {
    name          = "ReaperSuccess"
    namespace     = "Krombat/Game"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

# Extracts attack handler duration_ms for P95 latency tracking.
# Log line emitted by processCombat: attack_processed dungeon=<n> target=<t> duration_ms=<v>
resource "aws_cloudwatch_log_metric_filter" "attack_latency" {
  name           = "${var.cluster_name}-attack-latency"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  pattern        = "[timestamp, level, msg=\"attack_processed\", dungeon, target, duration]"

  metric_transformation {
    name      = "AttackDurationMs"
    namespace = "Krombat/Game"
    value     = "$duration"
    unit      = "Milliseconds"
  }
}

# Extracts action handler duration_ms for P95 latency tracking.
# Log line emitted by processAction: action_processed dungeon=<n> action=<a> duration_ms=<v>
resource "aws_cloudwatch_log_metric_filter" "action_latency" {
  name           = "${var.cluster_name}-action-latency"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  pattern        = "[timestamp, level, msg=\"action_processed\", dungeon, action, duration]"

  metric_transformation {
    name      = "ActionDurationMs"
    namespace = "Krombat/Game"
    value     = "$duration"
    unit      = "Milliseconds"
  }
}

# Counts each processed attack event for game-event throughput tracking.
resource "aws_cloudwatch_log_metric_filter" "attack_count" {
  name           = "${var.cluster_name}-attack-count"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  pattern        = "attack_processed"

  metric_transformation {
    name          = "AttackCount"
    namespace     = "Krombat/Game"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

# Counts each processed action event for game-event throughput tracking.
resource "aws_cloudwatch_log_metric_filter" "action_count" {
  name           = "${var.cluster_name}-action-count"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  pattern        = "action_processed"

  metric_transformation {
    name          = "ActionCount"
    namespace     = "Krombat/Game"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

# --- Additional CloudWatch Alarms ---

# Alert if active dungeon count (running game-namespace pods) exceeds 50
# Uses the ContainerInsights cluster-level pod count as a proxy;
# tune the dimension to match your dungeon namespace naming convention if needed.
resource "aws_cloudwatch_metric_alarm" "too_many_dungeons" {
  alarm_name          = "krombat-too-many-dungeons"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "namespace_number_of_running_pods"
  namespace           = "ContainerInsights"
  period              = 60
  statistic           = "Maximum"
  threshold           = 50
  treat_missing_data  = "notBreaching"
  alarm_description   = "More than 50 dungeon pods active — possible runaway test loop"
  dimensions = {
    ClusterName = var.cluster_name
  }
}

# Alert if the dungeon-reaper CronJob hasn't logged a successful run in 15 minutes.
# The metric is fed by the reaper_success log metric filter above.
resource "aws_cloudwatch_metric_alarm" "reaper_failure" {
  alarm_name          = "krombat-reaper-not-running"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3 # 3 × 5-minute periods = 15 minutes
  metric_name         = "ReaperSuccess"
  namespace           = "Krombat/Game"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_description   = "Dungeon reaper has not completed successfully in 15 minutes — possible CronJob failure"
}

# --- New Log Metric Filters (Issue #356) ---

# Counts HTTP 4xx/5xx errors logged by the access-log middleware.
resource "aws_cloudwatch_log_metric_filter" "http_errors" {
  name           = "${var.cluster_name}-http-errors"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  pattern        = "{ $.msg = \"http_request\" && $.status >= 400 }"

  metric_transformation {
    name          = "HttpErrors"
    namespace     = "Krombat/Game"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

# Counts frontend errors reported via POST /api/v1/client-error.
resource "aws_cloudwatch_log_metric_filter" "frontend_errors" {
  name           = "${var.cluster_name}-frontend-errors"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  pattern        = "frontend_error"

  metric_transformation {
    name          = "FrontendErrors"
    namespace     = "Krombat/Game"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

# Counts Web Vital reports where LCP rating = "poor".
resource "aws_cloudwatch_log_metric_filter" "web_vital_poor_lcp" {
  name           = "${var.cluster_name}-poor-lcp"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  pattern        = "{ $.msg = \"web_vital\" && $.name = \"LCP\" && $.rating = \"poor\" }"

  metric_transformation {
    name          = "PoorLCP"
    namespace     = "Krombat/Game"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

# Counts Web Vital reports where CLS rating = "poor".
resource "aws_cloudwatch_log_metric_filter" "web_vital_poor_cls" {
  name           = "${var.cluster_name}-poor-cls"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  pattern        = "{ $.msg = \"web_vital\" && $.name = \"CLS\" && $.rating = \"poor\" }"

  metric_transformation {
    name          = "PoorCLS"
    namespace     = "Krombat/Game"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

# Counts WebSocket connection events.
resource "aws_cloudwatch_log_metric_filter" "ws_connected" {
  name           = "${var.cluster_name}-ws-connected"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  pattern        = "websocket connected"

  metric_transformation {
    name          = "WsConnected"
    namespace     = "Krombat/Game"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

# Counts WebSocket disconnection events.
resource "aws_cloudwatch_log_metric_filter" "ws_disconnected" {
  name           = "${var.cluster_name}-ws-disconnected"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  pattern        = "websocket disconnected"

  metric_transformation {
    name          = "WsDisconnected"
    namespace     = "Krombat/Game"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

# Counts 429 rate-limit responses.
resource "aws_cloudwatch_log_metric_filter" "rate_limited" {
  name           = "${var.cluster_name}-rate-limited"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  pattern        = "{ $.status = 429 }"

  metric_transformation {
    name          = "RateLimited"
    namespace     = "Krombat/Game"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

# #475: Active dungeon count gauge — emitted every 30s by pollGameMetrics.
# Uses $.count from the structured log so the metric reflects the actual live CR count.
resource "aws_cloudwatch_log_metric_filter" "active_dungeons" {
  name           = "${var.cluster_name}-active-dungeons"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  pattern        = "{ $.msg = \"active_dungeons\" }"

  metric_transformation {
    name          = "ActiveDungeons"
    namespace     = "Krombat/Game"
    value         = "$.count"
    default_value = "0"
    unit          = "Count"
  }
}

# =============================================================================
# Issue #357 — CloudWatch Alarms (application + K8s infrastructure)
# =============================================================================

resource "aws_cloudwatch_metric_alarm" "high_http_error_rate" {
  alarm_name          = "${var.cluster_name}-high-http-error-rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "HttpErrors"
  namespace           = "Krombat/Game"
  period              = 300
  statistic           = "Sum"
  threshold           = 20
  treat_missing_data  = "notBreaching"
  alarm_description   = "HTTP error rate > 20 per 5 min — API degradation"
}

resource "aws_cloudwatch_metric_alarm" "frontend_errors" {
  alarm_name          = "${var.cluster_name}-frontend-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "FrontendErrors"
  namespace           = "Krombat/Game"
  period              = 300
  statistic           = "Sum"
  threshold           = 5
  treat_missing_data  = "notBreaching"
  alarm_description   = "Frontend JS errors > 5 per 5 min — possible crash loop"
}

resource "aws_cloudwatch_metric_alarm" "kro_pod_oom" {
  alarm_name          = "${var.cluster_name}-kro-pod-oom"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "pod_number_of_container_restarts"
  namespace           = "ContainerInsights"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_description   = "kro pod restarted — possible OOM"
  dimensions = {
    ClusterName = var.cluster_name
    Namespace   = "kro"
  }
}

resource "aws_cloudwatch_metric_alarm" "node_disk_full" {
  alarm_name          = "${var.cluster_name}-node-disk-full"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "node_filesystem_utilization"
  namespace           = "ContainerInsights"
  period              = 300
  statistic           = "Maximum"
  threshold           = 85
  treat_missing_data  = "notBreaching"
  alarm_description   = "Node disk utilization > 85% — disk pressure before eviction"
  dimensions = {
    ClusterName = var.cluster_name
  }
}

# =============================================================================
# Issue #357 — Dashboard 1: krombat-application
# =============================================================================

resource "aws_cloudwatch_dashboard" "krombat_application" {
  dashboard_name = "${var.cluster_name}-application"
  dashboard_body = jsonencode({
    widgets = [
      # Row 1 — HTTP Traffic
      {
        type   = "log"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "HTTP Request Rate"
          region = var.region
          query  = "SOURCE '/eks/${var.cluster_name}/rpg-system' | filter msg = \"http_request\" | stats count(*) as requests by bin(1m) | sort @timestamp desc"
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "HTTP Error Rate (4xx/5xx)"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          stat    = "Sum"
          metrics = [
            ["Krombat/Game", "HttpErrors", { label = "HTTP Errors", color = "#d62728" }]
          ]
          annotations = {
            horizontal = [{ value = 10, label = "Alert threshold", color = "#ff9900" }]
          }
        }
      },
      # Row 2 — Latency
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title   = "Attack Latency (ms)"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          metrics = [
            ["Krombat/Game", "AttackDurationMs", { stat = "p50", label = "P50" }],
            ["Krombat/Game", "AttackDurationMs", { stat = "p95", label = "P95" }],
            ["Krombat/Game", "AttackDurationMs", { stat = "p99", label = "P99" }]
          ]
          annotations = {
            horizontal = [{ value = 200, label = "200ms target", color = "#ff9900" }]
          }
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title   = "Action Latency (ms)"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          metrics = [
            ["Krombat/Game", "ActionDurationMs", { stat = "p50", label = "P50" }],
            ["Krombat/Game", "ActionDurationMs", { stat = "p95", label = "P95" }],
            ["Krombat/Game", "ActionDurationMs", { stat = "p99", label = "P99" }]
          ]
        }
      },
      # Row 3 — WebSocket & Rate Limiting
      {
        type   = "log"
        x      = 0
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "WebSocket Connections (events)"
          region = var.region
          query  = "SOURCE '/eks/${var.cluster_name}/rpg-system' | filter msg = \"websocket connected\" or msg = \"websocket disconnected\" | stats count(*) as events by msg, bin(1m) | sort @timestamp desc"
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 12
        width  = 12
        height = 6
        properties = {
          title   = "Rate Limited Requests (429)"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          stat    = "Sum"
          metrics = [
            ["Krombat/Game", "RateLimited", { label = "Rate Limited", color = "#ff7f0e" }]
          ]
        }
      },
      # Row 4 — Frontend Health
      {
        type   = "metric"
        x      = 0
        y      = 18
        width  = 12
        height = 6
        properties = {
          title   = "Frontend Error Rate"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          stat    = "Sum"
          metrics = [
            ["Krombat/Game", "FrontendErrors", { label = "JS Errors", color = "#d62728" }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 18
        width  = 12
        height = 6
        properties = {
          title   = "Web Vitals — Poor Ratings"
          region  = var.region
          view    = "timeSeries"
          stacked = true
          period  = 300
          stat    = "Sum"
          metrics = [
            ["Krombat/Game", "PoorLCP", { label = "Poor LCP", color = "#d62728" }],
            ["Krombat/Game", "PoorCLS", { label = "Poor CLS", color = "#ff7f0e" }]
          ]
        }
      },
      # Row 5 — Backend Pod Health
      {
        type   = "metric"
        x      = 0
        y      = 24
        width  = 12
        height = 6
        properties = {
          title   = "CPU Utilization per Pod"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          stat    = "Average"
          metrics = [
            ["ContainerInsights", "pod_cpu_utilization", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "PodName", "rpg-backend", { label = "Backend" }],
            ["ContainerInsights", "pod_cpu_utilization", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "PodName", "rpg-frontend", { label = "Frontend" }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 24
        width  = 12
        height = 6
        properties = {
          title   = "Memory Utilization per Pod"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          stat    = "Average"
          metrics = [
            ["ContainerInsights", "pod_memory_utilization", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "PodName", "rpg-backend", { label = "Backend" }],
            ["ContainerInsights", "pod_memory_utilization", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "PodName", "rpg-frontend", { label = "Frontend" }]
          ]
        }
      },
      # Row 6 — Logs
      {
        type   = "log"
        x      = 0
        y      = 30
        width  = 12
        height = 6
        properties = {
          title  = "Backend API Logs"
          region = var.region
          query  = "SOURCE '/eks/${var.cluster_name}/rpg-system' | fields @timestamp, level, msg, method, path, status, duration_ms | filter ispresent(method) | sort @timestamp desc | limit 50"
        }
      },
      {
        type   = "log"
        x      = 12
        y      = 30
        width  = 12
        height = 6
        properties = {
          title  = "Frontend Error Logs"
          region = var.region
          query  = "SOURCE '/eks/${var.cluster_name}/rpg-system' | filter msg = \"frontend_error\" | fields @timestamp, message, url, context | sort @timestamp desc | limit 20"
        }
      }
    ]
  })
}

# =============================================================================
# Issue #357 — Dashboard 2: krombat-kubernetes
# =============================================================================

resource "aws_cloudwatch_dashboard" "krombat_kubernetes" {
  dashboard_name = "${var.cluster_name}-kubernetes"
  dashboard_body = jsonencode({
    widgets = [
      # Row 1 — Cluster Node Overview
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "Node CPU Utilization by Node"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          stat    = "Average"
          metrics = [
            ["ContainerInsights", "node_cpu_utilization", "ClusterName", var.cluster_name, { label = "All Nodes (avg)" }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "Node Memory Utilization"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          stat    = "Average"
          metrics = [
            ["ContainerInsights", "node_memory_utilization", "ClusterName", var.cluster_name, { label = "All Nodes (avg)" }]
          ]
        }
      },
      # Row 2 — Pod Distribution
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title   = "Running Pods per Namespace"
          region  = var.region
          view    = "timeSeries"
          stacked = true
          period  = 60
          stat    = "Average"
          metrics = [
            ["ContainerInsights", "namespace_number_of_running_pods", "ClusterName", var.cluster_name, "Namespace", "rpg-system", { label = "rpg-system" }],
            ["ContainerInsights", "namespace_number_of_running_pods", "ClusterName", var.cluster_name, "Namespace", "kro", { label = "kro" }],
            ["ContainerInsights", "namespace_number_of_running_pods", "ClusterName", var.cluster_name, "Namespace", "argocd", { label = "argocd" }],
            ["ContainerInsights", "namespace_number_of_running_pods", "ClusterName", var.cluster_name, "Namespace", "default", { label = "default (attacks)" }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title   = "Pod Restarts (all workloads)"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 300
          stat    = "Maximum"
          metrics = [
            ["ContainerInsights", "pod_number_of_container_restarts", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "PodName", "rpg-backend", { label = "Backend", color = "#d62728" }],
            ["ContainerInsights", "pod_number_of_container_restarts", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "PodName", "rpg-frontend", { label = "Frontend", color = "#ff7f0e" }],
            ["ContainerInsights", "pod_number_of_container_restarts", "ClusterName", var.cluster_name, "Namespace", "kro", { label = "kro", color = "#2ca02c" }]
          ]
        }
      },
      # Row 3 — kro Controller
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 12
        height = 6
        properties = {
          title   = "kro Pod CPU/Memory"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          stat    = "Average"
          metrics = [
            ["ContainerInsights", "pod_cpu_utilization", "ClusterName", var.cluster_name, "Namespace", "kro", { label = "CPU %" }],
            ["ContainerInsights", "pod_memory_utilization", "ClusterName", var.cluster_name, "Namespace", "kro", { label = "Memory %" }]
          ]
        }
      },
      {
        type   = "log"
        x      = 12
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "kro Reconcile Activity"
          region = var.region
          query  = "SOURCE '/eks/${var.cluster_name}/kro' | filter @message like /reconcil|error|Reconcil/ | stats count(*) as reconcile_events by bin(1m) | sort @timestamp desc"
        }
      },
      # Row 4 — ArgoCD Sync Health
      {
        type   = "log"
        x      = 0
        y      = 18
        width  = 12
        height = 6
        properties = {
          title  = "ArgoCD Sync Events"
          region = var.region
          query  = "SOURCE '/eks/${var.cluster_name}/argocd' | filter @message like /Synced|OutOfSync|sync.*error|Progressing/ | fields @timestamp, @message | sort @timestamp desc | limit 30"
        }
      },
      {
        type   = "log"
        x      = 12
        y      = 18
        width  = 12
        height = 6
        properties = {
          title  = "ArgoCD Error Logs"
          region = var.region
          query  = "SOURCE '/eks/${var.cluster_name}/argocd' | filter @message like /error|Error|failed|Failed/ | fields @timestamp, @message | sort @timestamp desc | limit 20"
        }
      },
      # Row 5 — Node Disk & Network
      {
        type   = "metric"
        x      = 0
        y      = 24
        width  = 12
        height = 6
        properties = {
          title   = "Node Network RX/TX (bytes)"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          stat    = "Sum"
          metrics = [
            ["ContainerInsights", "pod_network_rx_bytes", "ClusterName", var.cluster_name, "Namespace", "rpg-system", { label = "rpg-system RX" }],
            ["ContainerInsights", "pod_network_tx_bytes", "ClusterName", var.cluster_name, "Namespace", "rpg-system", { label = "rpg-system TX" }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 24
        width  = 12
        height = 6
        properties = {
          title   = "Node Disk Utilization (%)"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 300
          stat    = "Maximum"
          metrics = [
            ["ContainerInsights", "node_filesystem_utilization", "ClusterName", var.cluster_name, { label = "Disk Utilization %" }]
          ]
          annotations = {
            horizontal = [{ value = 80, label = "80% warning", color = "#ff9900" }]
          }
        }
      },
      # Row 6 — Dungeon Reaper & Infra Events
      {
        type   = "log"
        x      = 0
        y      = 30
        width  = 12
        height = 6
        properties = {
          title  = "Dungeon Reaper Activity"
          region = var.region
          query  = "SOURCE '/eks/${var.cluster_name}/game' | fields @timestamp, @message | filter @message like /reaper|dungeon.*delete|expired.*dungeon|cleanup/ | sort @timestamp desc | limit 20"
        }
      },
      {
        type   = "log"
        x      = 12
        y      = 30
        width  = 12
        height = 6
        properties = {
          title  = "Kubernetes Events (Warnings)"
          region = var.region
          query  = "SOURCE '/aws/containerinsights/${var.cluster_name}/application' | filter @message like /Warning|BackOff|Evicted|OOMKilled|Unhealthy/ | fields @timestamp, @message | sort @timestamp desc | limit 20"
        }
      }
    ]
  })
}

# =============================================================================
# Issue #358 — Business Metric Log Filters (namespace: Krombat/Business)
# =============================================================================

resource "aws_cloudwatch_log_metric_filter" "dungeon_started_business" {
  name           = "${var.cluster_name}-dungeon-started-business"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  pattern        = "dungeon_started"

  metric_transformation {
    name          = "DungeonStarted"
    namespace     = "Krombat/Business"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "dungeon_victory" {
  name           = "${var.cluster_name}-dungeon-victory"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  pattern        = "{ $.msg = \"dungeon_ended\" && $.outcome = \"victory\" }"

  metric_transformation {
    name          = "DungeonVictory"
    namespace     = "Krombat/Business"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "dungeon_defeat" {
  name           = "${var.cluster_name}-dungeon-defeat"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  pattern        = "{ $.msg = \"dungeon_ended\" && $.outcome = \"defeat\" }"

  metric_transformation {
    name          = "DungeonDefeat"
    namespace     = "Krombat/Business"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "dungeon_abandoned" {
  name           = "${var.cluster_name}-dungeon-abandoned"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  pattern        = "{ $.msg = \"dungeon_ended\" && $.outcome = \"in-progress\" }"

  metric_transformation {
    name          = "DungeonAbandoned"
    namespace     = "Krombat/Business"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "monster_kills" {
  name           = "${var.cluster_name}-monster-kills"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  pattern        = "monster_killed"

  metric_transformation {
    name          = "MonsterKills"
    namespace     = "Krombat/Business"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "boss_kills" {
  name           = "${var.cluster_name}-boss-kills"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  pattern        = "boss_killed"

  metric_transformation {
    name          = "BossKills"
    namespace     = "Krombat/Business"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "room1_clears" {
  name           = "${var.cluster_name}-room1-clears"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  pattern        = "room_cleared"

  metric_transformation {
    name          = "Room1Clears"
    namespace     = "Krombat/Business"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "room2_entries" {
  name           = "${var.cluster_name}-room2-entries"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  pattern        = "room2_entered"

  metric_transformation {
    name          = "Room2Entries"
    namespace     = "Krombat/Business"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "loot_drops_business" {
  name           = "${var.cluster_name}-loot-drops-business"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  pattern        = "loot_dropped"

  metric_transformation {
    name          = "LootDrops"
    namespace     = "Krombat/Business"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "items_used" {
  name           = "${var.cluster_name}-items-used"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  pattern        = "item_used"

  metric_transformation {
    name          = "ItemsUsed"
    namespace     = "Krombat/Business"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "heal_ability_used" {
  name           = "${var.cluster_name}-heal-ability-used"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  pattern        = "{ $.msg = \"ability_used\" && $.ability = \"heal\" }"

  metric_transformation {
    name          = "HealAbilityUsed"
    namespace     = "Krombat/Business"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "taunt_ability_used" {
  name           = "${var.cluster_name}-taunt-ability-used"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  pattern        = "{ $.msg = \"ability_used\" && $.ability = \"taunt\" }"

  metric_transformation {
    name          = "TauntAbilityUsed"
    namespace     = "Krombat/Business"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "backstab_ability_used" {
  name           = "${var.cluster_name}-backstab-ability-used"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  pattern        = "{ $.msg = \"ability_used\" && $.ability = \"backstab\" }"

  metric_transformation {
    name          = "BackstabAbilityUsed"
    namespace     = "Krombat/Business"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "new_game_plus_starts" {
  name           = "${var.cluster_name}-new-game-plus-starts"
  log_group_name = aws_cloudwatch_log_group.rpg_system.name
  # run_count > 0 means it's a NG+ run; simple presence-based filter on the field
  pattern = "{ $.msg = \"dungeon_started\" && $.run_count > 0 }"

  metric_transformation {
    name          = "NewGamePlusStarts"
    namespace     = "Krombat/Business"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

# =============================================================================
# Issue #358 — Business Alarms
# =============================================================================

resource "aws_cloudwatch_metric_alarm" "no_new_dungeons" {
  alarm_name          = "${var.cluster_name}-no-new-dungeons"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3
  metric_name         = "DungeonStarted"
  namespace           = "Krombat/Business"
  period              = 3600
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_description   = "No new dungeons started in 3 hours — possible frontend or backend outage"
}

resource "aws_cloudwatch_metric_alarm" "very_high_defeat_rate" {
  alarm_name          = "${var.cluster_name}-very-high-defeat-rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "DungeonDefeat"
  namespace           = "Krombat/Business"
  period              = 3600
  statistic           = "Sum"
  threshold           = 20
  treat_missing_data  = "notBreaching"
  alarm_description   = "Abnormally high defeat count — game may be unplayably hard or bugged"
}

# =============================================================================
# Issue #358 — Dashboard 3: krombat-business
# =============================================================================

resource "aws_cloudwatch_dashboard" "krombat_business" {
  dashboard_name = "${var.cluster_name}-business"
  dashboard_body = jsonencode({
    widgets = [
      # Row 1 — Engagement Funnel
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Dungeon Funnel"
          region = var.region
          view   = "bar"
          period = 86400
          stat   = "Sum"
          metrics = [
            ["Krombat/Business", "DungeonStarted", { label = "Started" }],
            ["Krombat/Business", "Room1Clears", { label = "Room 1 Cleared" }],
            ["Krombat/Business", "Room2Entries", { label = "Room 2 Entered" }],
            ["Krombat/Business", "DungeonVictory", { label = "Victory" }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "Outcome Breakdown (rolling 24h)"
          region  = var.region
          view    = "bar"
          period  = 86400
          stat    = "Sum"
          stacked = true
          metrics = [
            ["Krombat/Business", "DungeonVictory", { label = "Victory", color = "#2ca02c" }],
            ["Krombat/Business", "DungeonDefeat", { label = "Defeat", color = "#d62728" }],
            ["Krombat/Business", "DungeonAbandoned", { label = "Abandoned", color = "#7f7f7f" }]
          ]
        }
      },
      # Row 2 — Class & Difficulty Popularity
      {
        type   = "log"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Dungeons Started by Hero Class"
          region = var.region
          query  = "SOURCE '/eks/${var.cluster_name}/rpg-system' | filter msg = \"dungeon_started\" | stats count(*) as runs by hero_class | sort runs desc"
        }
      },
      {
        type   = "log"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Dungeon Outcomes by Difficulty"
          region = var.region
          query  = "SOURCE '/eks/${var.cluster_name}/rpg-system' | filter msg = \"dungeon_ended\" | stats count(*) as total, sum(outcome=\"victory\") as victories by difficulty | sort difficulty"
        }
      },
      # Row 3 — Combat Economy
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 12
        height = 6
        properties = {
          title   = "Monster & Boss Kills per Hour"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 3600
          stat    = "Sum"
          metrics = [
            ["Krombat/Business", "MonsterKills", { label = "Monster Kills", color = "#1f77b4" }],
            ["Krombat/Business", "BossKills", { label = "Boss Kills", color = "#d62728" }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 12
        width  = 12
        height = 6
        properties = {
          title   = "Ability Usage"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 3600
          stat    = "Sum"
          metrics = [
            ["Krombat/Business", "HealAbilityUsed", { label = "Mage Heal", color = "#2ca02c" }],
            ["Krombat/Business", "TauntAbilityUsed", { label = "Warrior Taunt", color = "#1f77b4" }],
            ["Krombat/Business", "BackstabAbilityUsed", { label = "Rogue Backstab", color = "#9467bd" }]
          ]
        }
      },
      # Row 4 — Loot Economy
      {
        type   = "log"
        x      = 0
        y      = 18
        width  = 12
        height = 6
        properties = {
          title  = "Loot Drops by Rarity"
          region = var.region
          query  = "SOURCE '/eks/${var.cluster_name}/rpg-system' | filter msg = \"loot_dropped\" | stats count(*) as drops by item_rarity | sort drops desc"
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 18
        width  = 12
        height = 6
        properties = {
          title   = "Items Dropped vs Used"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 3600
          stat    = "Sum"
          metrics = [
            ["Krombat/Business", "LootDrops", { label = "Loot Drops", color = "#ff7f0e" }],
            ["Krombat/Business", "ItemsUsed", { label = "Items Used", color = "#2ca02c" }]
          ]
        }
      },
      # Row 5 — Retention & New Game+
      {
        type   = "metric"
        x      = 0
        y      = 24
        width  = 12
        height = 6
        properties = {
          title   = "New Game+ Activity"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 3600
          stat    = "Sum"
          metrics = [
            ["Krombat/Business", "NewGamePlusStarts", { label = "NG+ Starts", color = "#9467bd" }]
          ]
        }
      },
      {
        type   = "log"
        x      = 12
        y      = 24
        width  = 12
        height = 6
        properties = {
          title  = "Average Turns to Victory"
          region = var.region
          query  = "SOURCE '/eks/${var.cluster_name}/rpg-system' | filter msg = \"dungeon_ended\" and outcome = \"victory\" | stats avg(total_turns) as avg_turns, pct(total_turns, 50) as median_turns, pct(total_turns, 95) as p95_turns by bin(1h)"
        }
      },
      # Row 6 — Kill Breakdown
      {
        type   = "log"
        x      = 0
        y      = 30
        width  = 12
        height = 6
        properties = {
          title  = "Monster Kill Distribution by Type"
          region = var.region
          query  = "SOURCE '/eks/${var.cluster_name}/rpg-system' | filter msg = \"monster_killed\" | stats count(*) by target_type | sort count desc"
        }
      },
      {
        type   = "log"
        x      = 12
        y      = 30
        width  = 12
        height = 6
        properties = {
          title  = "Boss Kills by Room and Difficulty"
          region = var.region
          query  = "SOURCE '/eks/${var.cluster_name}/rpg-system' | filter msg = \"boss_killed\" | stats count(*) by room, difficulty"
        }
      }
    ]
  })
}

# =============================================================================
# Issue #476 — Dashboard 5: krombat-kro (kro operator observability)
# =============================================================================

resource "aws_cloudwatch_dashboard" "krombat_kro" {
  dashboard_name = "${var.cluster_name}-kro"
  dashboard_body = jsonencode({
    widgets = [
      # Row 1: kro CPU and Memory utilisation
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "kro CPU Utilization (%)"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          metrics = [
            ["ContainerInsights", "pod_cpu_utilization", "ClusterName", var.cluster_name, "Namespace", "kro", { label = "kro avg", stat = "Average", color = "#9467bd" }],
            ["ContainerInsights", "pod_cpu_utilization", "ClusterName", var.cluster_name, "Namespace", "kro", { label = "kro max", stat = "Maximum", color = "#8c564b" }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "kro Memory Utilization (%)"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          metrics = [
            ["ContainerInsights", "pod_memory_utilization", "ClusterName", var.cluster_name, "Namespace", "kro", { label = "kro avg", stat = "Average", color = "#9467bd" }],
            ["ContainerInsights", "pod_memory_utilization", "ClusterName", var.cluster_name, "Namespace", "kro", { label = "kro max", stat = "Maximum", color = "#8c564b" }]
          ]
        }
      },
      # Row 2: kro Pod Restarts and Replicas Ready
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title   = "kro Pod Restarts"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          stat    = "Sum"
          metrics = [
            ["ContainerInsights", "pod_number_of_container_restarts", "ClusterName", var.cluster_name, "Namespace", "kro", { label = "kro Restarts", color = "#d62728" }]
          ]
          annotations = {
            horizontal = [{ label = "Alert threshold", value = 1, color = "#d62728" }]
          }
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title   = "kro Ready Replicas"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          stat    = "Average"
          metrics = [
            ["ContainerInsights", "replicas_ready", "ClusterName", var.cluster_name, "Namespace", "kro", { label = "kro replicas ready", color = "#9467bd" }]
          ]
          annotations = {
            horizontal = [{ label = "Expected", value = 1, color = "#2ca02c" }]
          }
        }
      },
      # Row 3: kro Reconcile Errors and CEL Evaluation Errors (log widgets)
      {
        type   = "log"
        x      = 0
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "kro Reconcile Errors"
          region = var.region
          query  = "SOURCE '/eks/${var.cluster_name}/kro' | fields @timestamp, @message | filter @message like /error/i or @message like /failed/i | sort @timestamp desc | limit 50"
        }
      },
      {
        type   = "log"
        x      = 12
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "kro CEL Evaluation Errors"
          region = var.region
          query  = "SOURCE '/eks/${var.cluster_name}/kro' | fields @timestamp, @message | filter @message like /cel/i or @message like /expression/i or @message like /CEL/i | sort @timestamp desc | limit 50"
        }
      },
      # Row 4: RGD Status events (acceptance, rejection, reconciliation)
      {
        type   = "log"
        x      = 0
        y      = 18
        width  = 24
        height = 6
        properties = {
          title  = "RGD Status (acceptance / rejection / reconcile events)"
          region = var.region
          query  = "SOURCE '/eks/${var.cluster_name}/kro' | fields @timestamp, @message | filter @message like /ResourceGraphDefinition/i or @message like /rgd/i or @message like /reconcil/i | sort @timestamp desc | limit 50"
        }
      }
    ]
  })
}
