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
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "Pod Restarts"
          region  = var.region
          metrics = [
            ["ContainerInsights", "pod_number_of_container_restarts", "ClusterName", var.cluster_name, "Namespace", "rpg-system", { stat = "Sum", period = 300 }]
          ]
        }
      },
      {
        type   = "log"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "Recent Errors"
          region  = var.region
          query   = "SOURCE '/eks/${var.cluster_name}/rpg-system' | fields @timestamp, @message | filter @message like /error|Error|ERROR/ | sort @timestamp desc | limit 20"
        }
      },
      {
        type   = "log"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title   = "Attack Job Logs"
          region  = var.region
          query   = "SOURCE '/eks/${var.cluster_name}/game' | fields @timestamp, @message | filter @message like /Hero attacks|Turn complete|Attack failed/ | sort @timestamp desc | limit 20"
        }
      },
      {
        type   = "log"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title   = "Backend API Activity"
          region  = var.region
          query   = "SOURCE '/eks/${var.cluster_name}/rpg-system' | fields @timestamp, msg, method, path, status, dungeon | filter component = 'api' | sort @timestamp desc | limit 20"
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
