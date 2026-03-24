#!/usr/bin/env python3
"""
Convert OPC-UA-DATAMODEL.md to a standalone HTML file
with Mermaid diagrams rendered as embedded base64 SVG images via mmdc.

Usage: python build-datamodel-html.py [input.md] [output.html]

Requires: pip install markdown
          npx @mermaid-js/mermaid-cli (auto-downloaded)
"""

import base64
import re
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    import markdown
except ImportError:
    print("Required: pip install markdown", file=sys.stderr)
    sys.exit(1)


def render_mermaid_to_base64_svg(mermaid_code: str) -> str:
    """Render Mermaid code to a base64-encoded SVG using mmdc (mermaid-cli)."""
    with tempfile.TemporaryDirectory() as tmp:
        input_file = Path(tmp) / "diagram.mmd"
        output_file = Path(tmp) / "diagram.svg"
        input_file.write_text(mermaid_code, encoding="utf-8")

        result = subprocess.run(
            ["npx", "--yes", "@mermaid-js/mermaid-cli", "-i", str(input_file), "-o", str(output_file), "-b", "transparent"],
            capture_output=True,
            text=True,
            timeout=60,
            shell=True,
        )
        if result.returncode != 0:
            print(f"mmdc error: {result.stderr}", file=sys.stderr)
            sys.exit(1)

        svg_bytes = output_file.read_bytes()

    return base64.b64encode(svg_bytes).decode("ascii")


def convert(md_text: str) -> str:
    """Convert Markdown to HTML, embedding Mermaid diagrams as base64 SVG."""
    mermaid_blocks: dict[str, str] = {}
    counter = 0

    def _extract(match: re.Match) -> str:
        nonlocal counter
        key = f"MERMAIDBLOCK{counter}PLACEHOLDER"
        mermaid_blocks[key] = match.group(1).strip()
        counter += 1
        return key

    # Pull out mermaid fenced blocks before markdown processing
    processed = re.sub(r"```mermaid\s*\n(.*?)```", _extract, md_text, flags=re.DOTALL)

    html_body = markdown.markdown(processed, extensions=["tables", "fenced_code"])

    # Replace placeholders with rendered SVG images
    for key, code in mermaid_blocks.items():
        print(f"  Rendering Mermaid diagram ({len(code)} chars)...", file=sys.stderr)
        b64 = render_mermaid_to_base64_svg(code)
        img = (
            f'<figure class="diagram">'
            f'<img src="data:image/svg+xml;base64,{b64}" alt="Diagramme de transitions">'
            f"</figure>"
        )
        # markdown wraps inline text in <p> tags
        html_body = html_body.replace(f"<p>{key}</p>", img)
        html_body = html_body.replace(key, img)

    return html_body


CSS = """\
:root {
  --bg: #ffffff;
  --fg: #1a1a2e;
  --muted: #64748b;
  --accent: #2563eb;
  --border: #e2e8f0;
  --code-bg: #f1f5f9;
  --table-stripe: #f8fafc;
}
*, *::before, *::after { box-sizing: border-box; }
html { font-size: 16px; }
body {
  max-width: 960px;
  margin: 2rem auto;
  padding: 0 1.5rem;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: var(--fg);
  background: var(--bg);
  line-height: 1.65;
}
h1 { font-size: 1.8rem; border-bottom: 2px solid var(--accent); padding-bottom: .4rem; }
h2 { font-size: 1.4rem; margin-top: 2.5rem; border-bottom: 1px solid var(--border); padding-bottom: .3rem; }
h3 { font-size: 1.15rem; margin-top: 2rem; color: var(--accent); }
table {
  width: 100%;
  border-collapse: collapse;
  margin: 1rem 0;
  font-size: .9rem;
}
th, td {
  border: 1px solid var(--border);
  padding: .45rem .65rem;
  text-align: left;
}
th { background: var(--code-bg); font-weight: 600; }
tr:nth-child(even) { background: var(--table-stripe); }
code {
  background: var(--code-bg);
  padding: .15em .35em;
  border-radius: 3px;
  font-size: .88em;
}
pre {
  background: var(--code-bg);
  padding: 1rem;
  border-radius: 6px;
  overflow-x: auto;
  font-size: .85rem;
  line-height: 1.5;
}
pre code { background: none; padding: 0; }
blockquote {
  border-left: 3px solid var(--accent);
  margin: 1rem 0;
  padding: .5rem 1rem;
  color: var(--muted);
  font-size: .9rem;
}
.diagram {
  margin: 1.5rem 0;
  text-align: center;
}
.diagram img {
  max-width: 100%;
  height: auto;
}
.doc-header {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  margin-bottom: 2rem;
  padding-bottom: 1.5rem;
  border-bottom: 2px solid var(--accent);
}
.doc-header .logo {
  height: 80px;
  width: auto;
  flex-shrink: 0;
}
.doc-header .header-desc {
  margin: 0;
  color: var(--fg);
  font-size: .95rem;
  line-height: 1.6;
}
footer {
  margin-top: 3rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
  font-size: .8rem;
  color: var(--muted);
}
"""


def embed_logo(docs_dir: Path) -> str:
    """Read the logo PNG and return a base64 data URI, or empty string if not found."""
    logo_path = docs_dir / "logo_VisuelConcept_couleurs@0.75x.png"
    if not logo_path.exists():
        print(f"  Logo not found: {logo_path}, skipping header logo", file=sys.stderr)
        return ""
    b64 = base64.b64encode(logo_path.read_bytes()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def build_page(body: str, title: str, logo_uri: str) -> str:
    header = ""
    if logo_uri:
        header = (
            '<header class="doc-header">\n'
            f'  <img src="{logo_uri}" alt="Visuel Concept" class="logo">\n'
            "  <div>\n"
            "    <p class='header-desc'>Ce document d\u00e9crit le mod\u00e8le de donn\u00e9es OPC\u00a0UA "
            "des stations d\u2019acquisition de mesure pour la ma\u00eetrise statistique des proc\u00e9d\u00e9s (SPC). "
            "Les serveurs OPC\u00a0UA sont impl\u00e9ment\u00e9s sur des syst\u00e8mes de type datalogger "
            "National Instruments ou automates Siemens.</p>\n"
            "  </div>\n"
            "</header>\n"
        )
    return (
        "<!DOCTYPE html>\n"
        '<html lang="fr">\n<head>\n'
        '<meta charset="UTF-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
        f"<title>{title}</title>\n"
        f"<style>\n{CSS}</style>\n"
        "</head>\n<body>\n"
        f"{header}"
        f"<article>\n{body}\n</article>\n"
        f"<footer>Generated from OPC-UA-DATAMODEL.md</footer>\n"
        "</body>\n</html>\n"
    )


def main() -> None:
    script_dir = Path(__file__).resolve().parent
    input_path = Path(sys.argv[1]) if len(sys.argv) > 1 else script_dir / "OPC-UA-DATAMODEL.md"
    output_path = Path(sys.argv[2]) if len(sys.argv) > 2 else input_path.with_suffix(".html")

    if not input_path.exists():
        print(f"File not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    print(f"Reading {input_path}...", file=sys.stderr)
    md_text = input_path.read_text(encoding="utf-8")

    body = convert(md_text)
    title = "Modèle de données OPC UA"

    # Extract h1 title if present and remove it from body (shown in header instead)
    m = re.search(r"<h1>(.*?)</h1>", body)
    if m:
        title = re.sub(r"<[^>]+>", "", m.group(1))
        body = body.replace(m.group(0), "", 1)

    logo_uri = embed_logo(script_dir)
    html = build_page(body, title, logo_uri)
    output_path.write_text(html, encoding="utf-8")
    print(f"Written {output_path} ({len(html):,} bytes)", file=sys.stderr)


if __name__ == "__main__":
    main()
