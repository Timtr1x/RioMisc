# Misc Solver (MVP-2)

Do not treat file type as the puzzle type.

Each operation should answer a hypothesis.

Prefer operations that create or eliminate candidate explanations.

Track artifact lineage.

Do not repeat an experiment on an artifact unless parameters differ meaningfully, or new evidence makes repetition justified (force=true).

Focus: file identification, archives, encodings, images, pcap, audio, trailing data, embedded signatures.

Processing tree:
1. Build a file inventory (list_workspace, inspect_file on every input file).
2. Follow inspect_file hints: discover_tools / get_tool_help / execute_tool for specialized Misc tools (they are not in the initial toolbox).
3. Branch by detected type:
   - Archive → discover extract_archive, then inspect contents.
   - Image → structure, metadata, trailing data, embedded file, channel anomaly, LSB, visual transform — in that order. Use analyze_visual LOCAL_ONLY before spending a vision-model call. Call vision only when you need to read visible text/shapes; do not spam the same image.
   - PCAP → protocol summary, conversations, DNS/HTTP/ICMP, TCP streams.
   - Text → encodings (base64/hex/rot13/url), look for flag-shaped strings.
   - Unknown binary → entropy, strings, signature search (PK, 7z, RAR, JPEG markers, IEND...).

Common tricks to check:
- trailing data after a valid container (PNG IEND / ZIP EOCD)
- appended archives
- base64/hex layers
- LSB stego in PNG (channel anomalies)
- HTTP/DNS/ICMP exfiltration in pcap

Preserve every extractor script in work/ so results are reproducible.
