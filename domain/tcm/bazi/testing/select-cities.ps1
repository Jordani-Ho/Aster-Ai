param([Parameter(Mandatory=$true)][string]$sourceDir)
$ErrorActionPreference = 'Stop'

$targetDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
New-Item -ItemType Directory -Force $targetDir | Out-Null
$overseas = @{
  '1732752'='柔佛新山'; '1734759'='马六甲'; '1735106'='乔治市'; '1735161'='吉隆坡'
  '1673820'='高雄'; '1668341'='台北'; '1668399'='台中'; '1668355'='台南'
  '1566083'='胡志明市'; '1819729'='香港'; '1821274'='澳门'; '1880252'='新加坡'
  '1609350'='曼谷'; '1642911'='雅加达'; '1701668'='马尼拉'; '1850147'='东京'; '1835848'='首尔'
  '2147714'='悉尼'; '2158177'='墨尔本'; '2174003'='布里斯班'; '2063523'='珀斯'; '2193733'='奥克兰'
  '5368361'='洛杉矶'; '5391959'='旧金山'; '5809844'='西雅图'; '5128581'='纽约'; '4887398'='芝加哥'
  '4699066'='休斯敦'; '5392171'='圣何塞'; '6167865'='多伦多'; '6173331'='温哥华'
  '5913490'='卡尔加里'; '6077243'='蒙特利尔'; '2643743'='伦敦'; '2988507'='巴黎'
  '2950159'='柏林'; '2925533'='法兰克福'; '3117735'='马德里'; '3169070'='罗马'; '3448439'='圣保罗'; '292223'='迪拜'
}
$cities = [System.Collections.Generic.List[object]]::new()
$audit = [System.Collections.Generic.List[string]]::new()
foreach ($file in @('CN','cities15000')) {
  $zip = [System.IO.Compression.ZipFile]::OpenRead("$sourceDir\$file.zip")
  $reader = [System.IO.StreamReader]::new($zip.GetEntry("$file.txt").Open())
  try {
    while ($null -ne ($line = $reader.ReadLine())) {
      $f = $line.Split("`t")
      $china = $file -eq 'CN' -and $f[8] -eq 'CN' -and $f[6] -eq 'P' -and $f[7] -in @('PPLC','PPLA','PPLA2') -and $f[0] -notin @('1279681','13527051','13527052')
      $abroad = $file -eq 'cities15000' -and $overseas.ContainsKey($f[0])
      if (-not ($china -or $abroad)) { continue }
      $zh = if ($abroad) { $overseas[$f[0]] } else {
        $names = @($f[3].Split(',') | Where-Object { $_ -cmatch '^[\p{IsCJKUnifiedIdeographs}]{2,12}市?$' })
        $municipal = @($names | Where-Object { $_.EndsWith('市') })
        if ($municipal.Count -gt 0) { $municipal[0] } elseif ($names.Count -gt 0) { $names[0] } else { $f[1] }
      }
      if ($f[0] -eq '13512708') { $zh = '林芝市' }
      if ($f[0] -eq '1280003') { $zh = '阿里地区' }
      $cities.Add([pscustomobject][ordered]@{nameZh=$zh;nameEn=$f[2];longitude=[double]::Parse($f[5],[cultureinfo]::InvariantCulture);timeZone=$f[17]})
      $audit.Add("$($f[0])`t$($f[7])`t$zh`t$($f[2])`t$($f[5])`t$($f[17])")
    }
  } finally { $reader.Dispose(); $zip.Dispose() }
}
$json = ConvertTo-Json -InputObject @($cities | Sort-Object timeZone,nameEn -Unique) -Depth 4
[IO.File]::WriteAllText("$targetDir\cities.json", $json + "`n", [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllLines("$sourceDir\cities-audit.tsv", $audit, [Text.UTF8Encoding]::new($false))
Write-Output "Selected $($cities.Count) cities; $((Get-Item "$targetDir\cities.json").Length) bytes"
