param(
  [Parameter(Mandatory = $true)]
  [string]$EtherscanApiKey,

  [int]$Port = 4173
)

$env:ETHERSCAN_API_KEY = $EtherscanApiKey
$env:PORT = "$Port"
node server.js
