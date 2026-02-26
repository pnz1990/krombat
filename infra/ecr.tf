resource "aws_ecr_repository" "backend" {
  count = var.enable_ecr ? 1 : 0
  name  = "krombat/backend"
}

resource "aws_ecr_repository" "frontend" {
  count = var.enable_ecr ? 1 : 0
  name  = "krombat/frontend"
}

resource "aws_ecr_lifecycle_policy" "backend" {
  count      = var.enable_ecr ? 1 : 0
  repository = aws_ecr_repository.backend[0].name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_ecr_lifecycle_policy" "frontend" {
  count      = var.enable_ecr ? 1 : 0
  repository = aws_ecr_repository.frontend[0].name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_iam_role_policy" "github_actions_ecr" {
  count = var.enable_ecr && var.enable_ci ? 1 : 0
  name  = "ecr-push"
  role  = aws_iam_role.github_actions[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
      ]
      Resource = "*"
    }]
  })
}
