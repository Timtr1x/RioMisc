# RioMisc Tool Catalog

Generated from `TOOL_CATALOG`. Do not edit by hand. Run `npm run docs:tools`.

- total: 53
- CORE (Pi direct): 15
- DISCOVERABLE: 38

- [misc.md](./misc.md)
- [crypto.md](./crypto.md)
- [visual.md](./visual.md)

## Core tools

- `list_workspace` — List a workspace directory. Omit path or use '.' for the root (challenge.txt, input/, work/, artifacts/).
- `read_challenge_file` — Read a workspace file as text. Use for challenge.txt and small extracted files.
- `inspect_file` — Cheap inspection: magic, size, sha256, entropy, image dims, pcap summary. Use on every attachment first.
- `write_work_file` — Write a script or note. Bare names go under work/ (solve.py → work/solve.py).
- `run_python` — Run Python in the workspace root. Escape hatch for custom logic — check discover_tools before reimplementing a standard attack.
- `search_tool_output` — Search a saved results/ file for a substring (flags, tokens).
- `read_tool_output_chunk` — Read a window of a saved tool output file.
- `record_hypothesis` — Record a hypothesis the planner should track.
- `report_progress` — Report progress, facts, and whether you are stalled.
- `submit_flag_candidate` — Propose a flag. You cannot submit to the contest yourself — the control plane verifies.
- `request_reflection` — Ask for an independent reflection pass when stuck. Does not run tools itself.
- `request_handoff` — Ask the control plane to hand the challenge to the other solver domain.
- `discover_tools` — Search the hidden Misc/Crypto tool catalog. Does not execute anything. Returns at most 10 short cards.
- `get_tool_help` — Return the full calling contract for exactly one catalog tool.
- `execute_tool` — Run one DISCOVERABLE catalog tool by name. Control tools cannot be reached this way.
