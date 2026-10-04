# PowerShell's own parser over a batch of bodies: the input file is a JSON array of {id, code}, the output one JSON
# array of {id, findings: [{line, construct}]}. The rule (which AST types are refused) lives here; nothing else does.
# Pipelines, not loops, so this file passes the check it serves.
param([Parameter(Mandatory = $true)][string]$InputPath)

$ErrorActionPreference = 'Stop'

$refused = @{
  IfStatementAst        = 'if'
  SwitchStatementAst    = 'switch'
  ForStatementAst       = 'for'
  ForEachStatementAst   = 'foreach'
  WhileStatementAst     = 'while'
  DoWhileStatementAst   = 'do-while'
  DoUntilStatementAst   = 'do-until'
  FunctionDefinitionAst = 'function'
  TryStatementAst       = 'try'
  TrapStatementAst      = 'trap'
  ThrowStatementAst     = 'throw'
}

$isRefused = {
  param($node)
  $refused.ContainsKey($node.GetType().Name) -or
    ($node -is [System.Management.Automation.Language.PipelineChainAst] -and $node.Operator -eq 'OrOr')
}

$bodies = Get-Content -Raw -LiteralPath $InputPath | ConvertFrom-Json
$results = @($bodies) | ForEach-Object {
  $body = $_
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($body.code, [ref]$null, [ref]$errors)
  $parseFindings = @($errors) | ForEach-Object {
    [ordered]@{ line = $_.Extent.StartLineNumber; construct = "does not parse as PowerShell: $($_.Message)" }
  }
  $nodeFindings = $ast.FindAll($isRefused, $true) | ForEach-Object {
    [ordered]@{ line = $_.Extent.StartLineNumber; construct = $refused[$_.GetType().Name] ?? '||' }
  }
  [ordered]@{ id = $body.id; findings = @(@($parseFindings) + @($nodeFindings) | Where-Object { $null -ne $_ }) }
}

ConvertTo-Json -InputObject @($results) -Depth 4 -Compress
