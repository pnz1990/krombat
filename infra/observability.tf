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
      # Row 1: CPU and Memory
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "CPU Utilization (%)"
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
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "Memory Utilization (%)"
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
      # Row 2: Network and Pod Health
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
          title   = "Pod Restarts & Status"
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 300
          stat    = "Maximum"
          metrics = [
            ["ContainerInsights", "pod_number_of_container_restarts", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "PodName", "rpg-backend", { label = "Backend Restarts", color = "#d62728" }],
            ["ContainerInsights", "pod_number_of_container_restarts", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "PodName", "rpg-frontend", { label = "Frontend Restarts", color = "#ff7f0e" }],
            ["ContainerInsights", "pod_number_of_running_containers", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "PodName", "rpg-backend", { label = "Backend Running", color = "#2ca02c" }],
            ["ContainerInsights", "pod_number_of_running_containers", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "PodName", "rpg-frontend", { label = "Frontend Running", color = "#1f77b4" }]
          ]
        }
      },
      # Row 3: Game activity (running pods = active dungeons) and cluster overview
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 12
        height = 6
        properties = {
          title   = "Running Pods by Namespace (Active Dungeons)"
          region  = var.region
          view    = "timeSeries"
          stacked = true
          period  = 60
          stat    = "Average"
          metrics = [
            ["ContainerInsights", "namespace_number_of_running_pods", "ClusterName", var.cluster_name, "Namespace", "rpg-system", { label = "rpg-system" }],
            ["ContainerInsights", "namespace_number_of_running_pods", "ClusterName", var.cluster_name, "Namespace", "default", { label = "default (attacks)" }]
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
          title  = "Backend Availability (Running Containers)"
          region = var.region
          view   = "singleValue"
          period = 60
          stat   = "Average"
          metrics = [
            ["ContainerInsights", "pod_number_of_running_containers", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "PodName", "rpg-backend", { label = "Backend" }],
            ["ContainerInsights", "pod_number_of_running_containers", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "PodName", "rpg-frontend", { label = "Frontend" }],
            ["ContainerInsights", "replicas_ready", "ClusterName", var.cluster_name, "Namespace", "rpg-system", { label = "Ready Replicas" }]
          ]
        }
      },
      # Row 4: Active Dungeons count and Victory Rate
      {
        type   = "log"
        x      = 0
        y      = 18
        width  = 12
        height = 6
        properties = {
          title  = "Active Dungeons (Live Count)"
          region = var.region
          query  = "SOURCE '/eks/${var.cluster_name}/rpg-system' | fields @timestamp, @message | filter @message like /dungeon.*created|namespace.*dungeon/ | stats count() as created by bin(5m) | sort @timestamp desc"
        }
      },
      {
        type   = "log"
        x      = 12
        y      = 18
        width  = 12
        height = 6
        properties = {
          title  = "Victory Rate (Boss Defeated Events / 5 min)"
          region = var.region
          query  = "SOURCE '/eks/${var.cluster_name}/game' | fields @timestamp, @message | filter @message like /boss.*defeated|bossHP.*0|victory|dungeon.*complete/ | stats count() as victories by bin(5m) | sort @timestamp desc"
        }
      },
      # Row 5: Attack Latency and Logs
      {
        type   = "log"
        x      = 0
        y      = 24
        width  = 12
        height = 6
        properties = {
          title  = "Attack Job Latency P95 (seconds)"
          region = var.region
          query  = "SOURCE '/eks/${var.cluster_name}/game' | fields @timestamp, @message | filter @message like /Turn complete|Attack complete|attack.*duration/ | parse @message /duration[=: ]+(?<duration_sec>[0-9.]+)/ | stats pct(duration_sec, 95) as p95_latency, avg(duration_sec) as avg_latency, count() as total_attacks by bin(5m) | sort @timestamp desc"
        }
      },
      {
        type   = "log"
        x      = 12
        y      = 24
        width  = 12
        height = 6
        properties = {
          title  = "Backend API Logs"
          region = var.region
          query  = "SOURCE '/aws/containerinsights/${var.cluster_name}/application' | fields @timestamp, @message | filter @logStream like /rpg-backend/ | sort @timestamp desc | limit 20"
        }
      },
      # Row 6: Error logs and Reaper activity
      {
        type   = "log"
        x      = 0
        y      = 30
        width  = 12
        height = 6
        properties = {
          title  = "Errors & Attack Jobs"
          region = var.region
          query  = "SOURCE '/aws/containerinsights/${var.cluster_name}/application' | fields @timestamp, @message | filter @message like /error|Error|Hero attacks|Turn complete|Attack failed/ | sort @timestamp desc | limit 20"
        }
      },
      {
        type   = "log"
        x      = 12
        y      = 30
        width  = 12
        height = 6
        properties = {
          title  = "Dungeon Reaper Activity"
          region = var.region
          query  = "SOURCE '/eks/${var.cluster_name}/game' | fields @timestamp, @message | filter @message like /reaper|dungeon.*delete|expired.*dungeon|cleanup/ | sort @timestamp desc | limit 20"
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
