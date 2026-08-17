# Misc tools

## `analyze_pcap_overview`

- group: `MISC_PCAP`
- exposure: `DISCOVERABLE`
- cost: `NORMAL`
- signature: `{ path, force? }`

PCAP packet/protocol/HTTP/DNS/conversation overview.

**When to use**
- inspect_file says PCAP
- Need protocols before carving streams

**When not to use**
- Not for images or zip files

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| path | string | yes | Workspace-relative file. |
| force | boolean | no | Bypass ALREADY_TESTED and re-run. |

**Example**

```json
{
  "path": "input/capture.pcap"
}
```

**Output**

Packet counts, HTTP requests, DNS names.

## `analyze_visual`

- group: `MISC_IMAGE`
- exposure: `DISCOVERABLE`
- cost: `NORMAL`
- signature: `{ path, question?, mode?, force? }`

Look at an image: overview, QR, channels, bitplanes. AUTO may call a vision model with a specific question.

**When to use**
- File is PNG/JPEG/GIF
- Need QR / visible text / channel anomalies

**When not to use**
- Do not ask to 'describe the image'
- Do not re-call vision on the same bytes unless transformed or force=true

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| path | string | yes | Workspace-relative image/audio/video. |
| question | string | no | Specific question. Never 'describe the image'. |
| mode | AUTO\|LOCAL_ONLY\|VISION_MODEL | no | Prefer LOCAL_ONLY first. |
| force | boolean | no | Bypass cache / ALREADY_TESTED. |

**Example**

```json
{
  "path": "input/task.png",
  "mode": "LOCAL_ONLY"
}
```

**Output**

Local observations, optional QR text, optional vision JSON.

## `carve_files`

- group: `MISC_FILE`
- exposure: `DISCOVERABLE`
- cost: `CHEAP`
- signature: `{ path, offset, length?, destPath?, force? }`

Carve a byte range to artifacts/carved/.

**When to use**
- scan_trailing_data or scan_embedded_signatures gave an offset

**When not to use**
- Do not carve the whole file unless you have a reason

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| path | string | yes | Workspace-relative file. |
| offset | number | yes | Start byte. |
| length | number | no | Byte count. Default to EOF. |
| destPath | string | no | Default artifacts/carved/at-<offset>.bin |
| force | boolean | no | Bypass ALREADY_TESTED and re-run. |

**Example**

```json
{
  "path": "input/a.png",
  "offset": 80,
  "length": 20
}
```

**Output**

Carved file path and size.

## `extract_archive`

- group: `MISC_ARCHIVE`
- exposure: `DISCOVERABLE`
- cost: `NORMAL`
- signature: `{ path, destPath?, maxDepth? }`

Extract a zip (or gunzip) into artifacts/ with zip-bomb limits.

**When to use**
- inspect_file says ZIP/GZIP
- Nested archives after a first extract

**When not to use**
- Not for raw images or PCAPs
- Not a general unrar if the magic is not ZIP/GZIP

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| path | string | yes | Workspace-relative file. |
| destPath | string | no | Default artifacts/extracted |
| maxDepth | number | no | Nested zip depth, max 8 |

**Example**

```json
{
  "path": "input/task.zip"
}
```

**Output**

Extracted entry list and nested-archive flags.

## `extract_bitplane`

- group: `MISC_IMAGE`
- exposure: `DISCOVERABLE`
- cost: `CHEAP`
- signature: `{ path, channel, bit, force? }`

Extract one channel bit plane to a PNG.

**When to use**
- LSB stego suspicion
- Channel anomaly in analyze_visual

**When not to use**
- Not the first tool on a QR-only image

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| path | string | yes | Workspace-relative image/audio/video. |
| channel | 0\|1\|2\|3\|R\|G\|B\|A | yes | Channel. |
| bit | number | yes | 0 (LSB) .. 7 (MSB). |
| force | boolean | no | Bypass cache / ALREADY_TESTED. |

**Example**

```json
{
  "path": "input/b.png",
  "channel": "R",
  "bit": 0
}
```

**Output**

Bitplane PNG path.

## `extract_dns_activity`

- group: `MISC_PCAP`
- exposure: `DISCOVERABLE`
- cost: `CHEAP`
- signature: `{ path, force? }`

List DNS names from a PCAP.

**When to use**
- Overview showed DNS
- Suspected DNS exfil / encoded names

**When not to use**
- No DNS in the capture

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| path | string | yes | Workspace-relative file. |
| force | boolean | no | Bypass ALREADY_TESTED and re-run. |

**Example**

```json
{
  "path": "input/capture.pcap"
}
```

**Output**

DNS name list.

## `extract_http_objects`

- group: `MISC_PCAP`
- exposure: `DISCOVERABLE`
- cost: `NORMAL`
- signature: `{ path, force? }`

List HTTP requests found in a PCAP.

**When to use**
- Overview showed HTTP
- Looking for downloaded files or flags in bodies

**When not to use**
- No HTTP in the capture

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| path | string | yes | Workspace-relative file. |
| force | boolean | no | Bypass ALREADY_TESTED and re-run. |

**Example**

```json
{
  "path": "input/capture.pcap"
}
```

**Output**

HTTP request list.

## `extract_keyframes`

- group: `MISC_AUDIO_VIDEO`
- exposure: `DISCOVERABLE`
- cost: `NORMAL`
- signature: `{ path, strategy?, maxFrames? }`

Extract video/GIF/image keyframes into a contact sheet (ffmpeg for video; PNG/JPEG works without it).

**When to use**
- GIF or video that may flash a flag on one frame

**When not to use**
- Static PNG unless you just want a contact sheet

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| path | string | yes | Workspace-relative image/audio/video. |
| strategy | UNIFORM\|SCENE_CHANGE\|ALL_IF_SMALL | no | Frame pick strategy. |
| maxFrames | number | no | 1..16 |

**Example**

```json
{
  "path": "input/still.png",
  "maxFrames": 4
}
```

**Output**

Contact sheet under artifacts/visual/.

## `extract_strings_summary`

- group: `MISC_FILE`
- exposure: `DISCOVERABLE`
- cost: `CHEAP`
- signature: `{ path, force? }`

Summarize interesting strings (flags, URLs, base64). Not a full dump.

**When to use**
- Any binary or unknown file after inspect
- Look for flag-like tokens

**When not to use**
- Not a replacement for decode/crypto attacks

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| path | string | yes | Workspace-relative file. |
| force | boolean | no | Bypass ALREADY_TESTED and re-run. |

**Example**

```json
{
  "path": "input/a.bin"
}
```

**Output**

Count plus flag-like / url / b64 highlights.

## `extract_visible_text`

- group: `MISC_IMAGE`
- exposure: `DISCOVERABLE`
- cost: `NORMAL`
- signature: `{ path, force? }`

OCR visible text. Returns BACKEND_UNAVAILABLE if no OCR engine is installed.

**When to use**
- Printed text in an image and no vision model

**When not to use**
- Do not expect bundled tesseract

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| path | string | yes | Workspace-relative image/audio/video. |
| force | boolean | no | Bypass cache / ALREADY_TESTED. |

**Example**

```json
{
  "path": "input/b.png"
}
```

**Output**

Text or BACKEND_UNAVAILABLE.

## `inspect_file`

- group: `WORKSPACE`
- exposure: `CORE`
- cost: `CHEAP`
- signature: `{ path }`

Cheap inspection: magic, size, sha256, entropy, image dims, pcap summary. Use on every attachment first.

**When to use**
- First look at any new file
- After carving or extracting

**When not to use**
- Not a full stego or crypto attack

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| path | string | yes | Workspace-relative path (root, not work/). |

**Example**

```json
{
  "path": "input/task.zip"
}
```

**Output**

Magic/mime/entropy plus contextual next-tool hints.

## `list_workspace`

- group: `WORKSPACE`
- exposure: `CORE`
- cost: `CHEAP`
- signature: `{ path? }`

List a workspace directory. Omit path or use '.' for the root (challenge.txt, input/, work/, artifacts/).

**When to use**
- Start of a solve to see attachments
- After extract_archive to see new files

**When not to use**
- Do not use run_python os.listdir to find files

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| path | string | no | Directory relative to workspace root. |

**Example**

```json
{
  "path": "."
}
```

**Output**

Directory entries plus a peek into input/work/artifacts when listing root.

## `read_challenge_file`

- group: `WORKSPACE`
- exposure: `CORE`
- cost: `CHEAP`
- signature: `{ path, maxChars? }`

Read a workspace file as text. Use for challenge.txt and small extracted files.

**When to use**
- Read the problem statement
- Read a small decoded text artifact

**When not to use**
- Do not read huge binaries; inspect_file first
- Do not use this to dump PCAP/images

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| path | string | yes | Workspace-relative path (root, not work/). |
| maxChars | number | no | Inline cap (default ~12k). |

**Example**

```json
{
  "path": "challenge.txt"
}
```

**Output**

File text, possibly truncated.

## `read_tool_output_chunk`

- group: `WORKSPACE`
- exposure: `CORE`
- cost: `CHEAP`
- signature: `{ path, offset?, maxChars? }`

Read a window of a saved tool output file.

**When to use**
- Paginate a long results/ file

**When not to use**
- Small files can be read with read_challenge_file

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| path | string | yes | Workspace-relative path (root, not work/). |
| offset | number | no | Byte/char offset. |
| maxChars | number | no | Window size. |

**Example**

```json
{
  "path": "results/tool-0001.txt",
  "offset": 0
}
```

**Output**

A text window and total length.

## `render_spectrogram`

- group: `MISC_AUDIO_VIDEO`
- exposure: `DISCOVERABLE`
- cost: `NORMAL`
- signature: `{ path, mode?, maxDurationSeconds? }`

Render a spectrogram PNG from a WAV file into artifacts/visual/spectrogram.png.

**When to use**
- WAV/audio attachment
- Suspected hidden image or Morse in spectrum

**When not to use**
- Not for images or PCAPs

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| path | string | yes | Workspace-relative image/audio/video. |
| mode | AUTO\|WIDE\|DETAIL | no | Layout. |
| maxDurationSeconds | number | no | Cap duration. |

**Example**

```json
{
  "path": "input/tone.wav",
  "mode": "AUTO"
}
```

**Output**

PNG path and sample rate.

## `render_transform`

- group: `MISC_IMAGE`
- exposure: `DISCOVERABLE`
- cost: `CHEAP`
- signature: `{ path, op, force? }`

Write a transformed PNG (grayscale / invert / autocontrast / threshold / rotate).

**When to use**
- Visible text is low-contrast
- Need invert/threshold before vision or QR

**When not to use**
- Not a substitute for bitplanes

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| path | string | yes | Workspace-relative image/audio/video. |
| op | grayscale\|invert\|autocontrast\|threshold\|rotate90\|rotate180\|rotate270 | yes | Transform. |
| force | boolean | no | Bypass cache / ALREADY_TESTED. |

**Example**

```json
{
  "path": "input/b.png",
  "op": "invert"
}
```

**Output**

New PNG path.

## `request_specialist`

- group: `SPECIALIST`
- exposure: `DISCOVERABLE`
- cost: `CHEAP`
- signature: `{ kind, path?, text? }`

Run a short structured specialist (IMAGE/PCAP/ARCHIVE/RSA/PRNG). Does not occupy a worker.

**When to use**
- Need a second opinion on a file type
- RSA instance needs a cheap attack list

**When not to use**
- Not a replacement for the real attack tools

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| kind | IMAGE\|PCAP\|AUDIO\|ARCHIVE\|RSA\|PRNG\|LATTICE | yes | Specialist kind. |
| path | string | no | File to inspect. |
| text | string | no | Inline text (RSA/PRNG). |

**Example**

```json
{
  "kind": "RSA",
  "text": "n=10007*10009 e=3 c=8"
}
```

**Output**

Conclusion, facts, recommended actions.

## `request_visual_review`

- group: `MISC_IMAGE`
- exposure: `DISCOVERABLE`
- cost: `EXPENSIVE`
- signature: `{ path, question, reason }`

Queue a human look at an image. Does not block — continue other analysis.

**When to use**
- Local and vision tools are not enough
- Need a human to read a CAPTCHA-like image

**When not to use**
- Do not use as the first action on every PNG

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| path | string | yes | Workspace-relative image/audio/video. |
| question | string | yes | What the human should look for. |
| reason | string | yes | Why local/vision is not enough. |

**Example**

```json
{
  "path": "input/sign.png",
  "question": "What letters are painted?",
  "reason": "OCR backend unavailable"
}
```

**Output**

Queued. Human answer arrives later as HUMAN VISUAL OBSERVATION.

## `run_python`

- group: `WORKSPACE`
- exposure: `CORE`
- cost: `NORMAL`
- signature: `{ code?, scriptPath?, args?, timeoutMs? }`

Run Python in the workspace root. Escape hatch for custom logic — check discover_tools before reimplementing a standard attack.

**When to use**
- Custom challenge logic
- Glue tool results
- Final solve.py

**When not to use**
- Do not reimplement shipped RSA/XOR/PCAP tools before discover_tools

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| code | string | no | Inline snippet. cwd is workspace root. |
| scriptPath | string | no | Prefer work/solve.py |
| args | string[] | no | argv after the script. |
| timeoutMs | number | no | Timeout, default tens of seconds. |

**Example**

```json
{
  "code": "import os; print(os.listdir('input'))"
}
```

**Output**

stdout/stderr. Long output is saved under results/.

## `scan_embedded_signatures`

- group: `MISC_FILE`
- exposure: `DISCOVERABLE`
- cost: `CHEAP`
- signature: `{ path, force? }`

Locate ZIP/PNG/JPEG/PDF/PE/ELF/GZIP/7z/RAR/SQLite magic offsets inside a blob.

**When to use**
- Unknown binary
- High entropy file that may contain another file

**When not to use**
- Already-identified small text files

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| path | string | yes | Workspace-relative file. |
| force | boolean | no | Bypass ALREADY_TESTED and re-run. |

**Example**

```json
{
  "path": "input/blob.bin"
}
```

**Output**

List of {offset,type,confidence}.

## `scan_trailing_data`

- group: `MISC_FILE`
- exposure: `DISCOVERABLE`
- cost: `CHEAP`
- signature: `{ path, force? }`

Find bytes after PNG IEND / JPEG FFD9 / GIF trailer / ZIP EOCD.

**When to use**
- PNG/JPEG/GIF/ZIP that may hide an appended payload
- inspect_file hinted trailing bytes

**When not to use**
- Not useful on raw text or already-carved slices

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| path | string | yes | Workspace-relative file. |
| force | boolean | no | Bypass ALREADY_TESTED and re-run. |

**Example**

```json
{
  "path": "input/a.png"
}
```

**Output**

Whether trailing bytes exist, offset, size, magic.

## `search_tool_output`

- group: `WORKSPACE`
- exposure: `CORE`
- cost: `CHEAP`
- signature: `{ path, query, maxMatches? }`

Search a saved results/ file for a substring (flags, tokens).

**When to use**
- Output was truncated
- Looking for flag{ in a long dump

**When not to use**
- Do not search input binaries this way if inspect_file has not run

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| path | string | yes | Workspace-relative path (root, not work/). |
| query | string | yes | Substring to find. |
| maxMatches | number | no | Cap matches. |

**Example**

```json
{
  "path": "results/tool-0001.txt",
  "query": "flag{"
}
```

**Output**

Match offsets and snippets.

## `write_work_file`

- group: `WORKSPACE`
- exposure: `CORE`
- cost: `CHEAP`
- signature: `{ path, content }`

Write a script or note. Bare names go under work/ (solve.py → work/solve.py).

**When to use**
- Save a reproducible solve script
- Keep notes

**When not to use**
- Do not overwrite input/

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| path | string | yes | Destination. Bare names land in work/. |
| content | string | yes | File contents. |

**Example**

```json
{
  "path": "solve.py",
  "content": "print(1)\n"
}
```

**Output**

Path written.
