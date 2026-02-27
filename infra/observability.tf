# --- CloudWatch Agent IAM Role (for Container Insights) ---

resource "aws_iam_role" "cloudwatch_agent" {
  name = "${var.cluster_name}-cloudwatch-agent"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
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
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "Pod Restarts (rpg-system)"
          region  = var.region
          metrics = [
            ["ContainerInsights", "pod_number_of_container_restarts", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "PodName", "rpg-backend", { stat = "Sum", period = 300 }],
            ["ContainerInsights", "pod_number_of_container_restarts", "ClusterName", var.cluster_name, "Namespace", "rpg-system", "PodName", "rpg-frontend", { stat = "Sum", period = 300 }]
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
          query   = "SOURCE '/aws/containerinsights/${var.cluster_name}/application' | fields @timestamp, @message | filter kubernetes.namespace_name = 'rpg-system' and @message like /error|Error|ERROR/ | sort @timestamp desc | limit 20"
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
          query   = "SOURCE '/aws/containerinsights/${var.cluster_name}/application' | fields @timestamp, @message | filter @message like /Hero attacks|Turn complete|Attack failed|Backstab|Taunt|Heal/ | sort @timestamp desc | limit 20"
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
          query   = "SOURCE '/aws/containerinsights/${var.cluster_name}/application' | fields @timestamp, @message | filter kubernetes.namespace_name = 'rpg-system' and kubernetes.container_name = 'rpg-backend' | sort @timestamp desc | limit 20"
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
