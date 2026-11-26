# Cost guardrails for one whole AWS account: one monthly budget + Cost Anomaly Detection.
#
# Account-wide on purpose: there is NO cost filter (no env tag filter), so the budget counts every service and every
# environment in the account. Only the root with manage_account_resources = true calls this module (demo account:
# prod root only; company account: each account's own root).
#
# Budget: monthly COST in USD, tax included (AWS Budgets counts tax by default; on an AWS India / AISPL bill that is
# GST). Credits and refunds are NOT subtracted, so promotional credits can't hide real usage.
# Alerts by email: ACTUAL spend above each threshold, plus FORECASTED spend above the top threshold.
# AWS allows at most 5 notifications per budget, so at most 4 thresholds.

terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "budget_name" {
  description = "Name of the account-level monthly budget, e.g. velza-demo-account-monthly."
  type        = string
}

variable "thresholds_usd" {
  description = "Alert thresholds in USD per month, tax included. The highest one is also the budget limit."
  type        = list(number)

  validation {
    condition     = length(var.thresholds_usd) >= 1 && length(var.thresholds_usd) <= 4 && alltrue([for t in var.thresholds_usd : t > 0])
    error_message = "Give 1 to 4 positive thresholds (AWS allows 5 notifications per budget; one is the forecast alert)."
  }
}

variable "alert_email" {
  description = "Address that receives budget and anomaly alerts."
  type        = string
}

variable "anomaly_threshold_usd" {
  description = "Send an anomaly alert when an anomaly's total cost impact is at least this many USD."
  type        = number
}

variable "anomaly_monitor_name" {
  description = "Name of the per-service anomaly monitor (AWS allows one per account)."
  type        = string
}

locals {
  limit_usd = max(var.thresholds_usd...)
}

resource "aws_budgets_budget" "account" {
  name         = var.budget_name
  budget_type  = "COST"
  limit_amount = format("%.2f", local.limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_types {
    include_tax                = true
    include_credit             = false
    include_refund             = false
    include_discount           = true
    include_support            = true
    include_other_subscription = true
    include_recurring          = true
    include_subscription       = true
    include_upfront            = true
    use_blended                = false
    use_amortized              = false
  }

  dynamic "notification" {
    for_each = toset(var.thresholds_usd)
    content {
      notification_type          = "ACTUAL"
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "ABSOLUTE_VALUE"
      subscriber_email_addresses = [var.alert_email]
    }
  }

  notification {
    notification_type          = "FORECASTED"
    comparison_operator        = "GREATER_THAN"
    threshold                  = local.limit_usd
    threshold_type             = "ABSOLUTE_VALUE"
    subscriber_email_addresses = [var.alert_email]
  }
}

resource "aws_ce_anomaly_monitor" "services" {
  name              = var.anomaly_monitor_name
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"
}

resource "aws_ce_anomaly_subscription" "daily" {
  name             = "${var.anomaly_monitor_name}-daily-email"
  frequency        = "DAILY"
  monitor_arn_list = [aws_ce_anomaly_monitor.services.arn]

  subscriber {
    type    = "EMAIL"
    address = var.alert_email
  }

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = [format("%.2f", var.anomaly_threshold_usd)]
    }
  }
}

output "budget_name" {
  value = aws_budgets_budget.account.name
}

output "anomaly_monitor_arn" {
  value = aws_ce_anomaly_monitor.services.arn
}
