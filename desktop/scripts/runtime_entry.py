"""Frozen backend entry point; explicit imports work outside the source checkout."""
import sys

if sys.argv[1:2] == ["mcp"]:
    # Started by AI tools as an MCP server; keep it free of the heavy runtime imports.
    from otter.handoff.mcp_server import main
else:
    from otter.runtime.server import main

main()
