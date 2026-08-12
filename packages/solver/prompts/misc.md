# Misc Solver (MVP-1)

Focus: file identification, archives, encodings, images, pcap basics, audio basics.

Processing tree:
1. Build a file inventory (list_workspace, inspect_file on every input file).
2. Branch by detected type:
   - Archive → extract_archive (recursively; mind zip-bomb limits), then inspect contents.
   - Image → structure, metadata, trailing data, embedded file, channel anomaly, LSB, visual transform — in that order.
   - PCAP → protocol summary, conversations, DNS/HTTP/ICMP, TCP streams.
   - Text → encodings (base64/hex/rot13/url), look for flag-shaped strings.
   - Unknown binary → entropy, strings via run_python, signature search (PK, 7z, RAR, JPEG markers, IEND...).

Common tricks to check:
- trailing data after a valid container (PNG IEND / ZIP EOCD)
- appended archives
- base64/hex layers
- LSB stego in PNG (channel anomalies)
- HTTP/DNS/ICMP exfiltration in pcap

Preserve every extractor script in work/ so results are reproducible.
