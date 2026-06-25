# Extract mermaid code blocks from .md files and render to PNG
$diagrams = @(
    "1_use_case_diagram",
    "2_activity_diagram",
    "3_class_diagram",
    "4_data_flow_diagram",
    "5_functional_hierarchy_diagram",
    "6_swimlane_diagram",
    "7_sequence_diagram"
)

$outDir = "g:\Solar\diagrams\output"
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

foreach ($name in $diagrams) {
    $mdFile = "g:\Solar\diagrams\$name.md"
    $mmdFile = "g:\Solar\diagrams\output\$name.mmd"
    $pngFile = "g:\Solar\diagrams\output\$name.png"

    Write-Host "Processing $name..."

    # Extract mermaid code block
    $content = Get-Content $mdFile -Raw
    if ($content -match '(?s)```mermaid\r?\n(.*?)```') {
        $mermaidCode = $Matches[1]
        Set-Content -Path $mmdFile -Value $mermaidCode -NoNewline
        Write-Host "  Extracted mermaid code to $mmdFile"

        # Render with mmdc
        & "g:\Solar\tools\npm\mmdc.cmd" -i $mmdFile -o $pngFile -w 1920 -H 1080 -s 4 -b white 2>&1
        if (Test-Path $pngFile) {
            Write-Host "  SUCCESS: $pngFile"
        } else {
            Write-Host "  FAILED to render $pngFile"
        }
    } else {
        Write-Host "  ERROR: No mermaid block found in $mdFile"
    }
}

Write-Host "`nDone! Check g:\Solar\diagrams\output\"
