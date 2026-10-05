# PowerShell's own parser over a batch of bodies: the input file is a JSON array of {id, code}, the output one JSON
# array of {id, findings: [{line, construct, outer}]}, every construct with the nearest construct enclosing it (null
# at the top level). The rule (which AST types are constructs) lives here; the depth judgment is judge.ts's.
# Pipelines and single constructs only, so this file passes the check it serves.
param([Parameter(Mandatory = $true)][string]$InputPath)

$ErrorActionPreference = 'Stop'

$constructs = @{
  IfStatementAst        = 'if'
  SwitchStatementAst    = 'switch'
  ForStatementAst       = 'for'
  ForEachStatementAst   = 'foreach'
  WhileStatementAst     = 'while'
  DoWhileStatementAst   = 'do-while'
  DoUntilStatementAst   = 'do-until'
  TryStatementAst       = 'try'
  FunctionDefinitionAst = 'function'
}

# A `||` chain is one construct: a chain node directly under another is the same chain.
$labelOf = {
  param($node)
  $isOrChain = $node -is [System.Management.Automation.Language.PipelineChainAst] -and $node.Operator -eq 'OrOr'
  $chained = $isOrChain -and $node.Parent -is [System.Management.Automation.Language.PipelineChainAst] -and $node.Parent.Operator -eq 'OrOr'
  $byType = $constructs[$node.GetType().Name]
  if ($chained) { $null } elseif ($isOrChain) { '||' } else { $byType }
}

$ancestorsOf = {
  param($node)
  $parent = $node.Parent
  while ($null -ne $parent) { $parent; $parent = $parent.Parent }
}

$bodies = Get-Content -Raw -LiteralPath $InputPath | ConvertFrom-Json
$results = @($bodies) | ForEach-Object {
  $body = $_
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($body.code, [ref]$null, [ref]$errors)
  $parseFindings = @($errors) | ForEach-Object {
    [ordered]@{ line = $_.Extent.StartLineNumber; construct = "does not parse as PowerShell: $($_.Message)"; outer = $null }
  }
  $nodeFindings = $ast.FindAll({ param($n) $null -ne (& $labelOf $n) }, $true) | ForEach-Object {
    $outer = @(& $ancestorsOf $_ | ForEach-Object { & $labelOf $_ } | Where-Object { $null -ne $_ }) | Select-Object -First 1
    [ordered]@{ line = $_.Extent.StartLineNumber; construct = (& $labelOf $_); outer = $outer }
  }
  [ordered]@{ id = $body.id; findings = @(@($parseFindings) + @($nodeFindings) | Where-Object { $null -ne $_ }) }
}

ConvertTo-Json -InputObject @($results) -Depth 4 -Compress
