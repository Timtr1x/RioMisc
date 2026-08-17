# Visual / media tools

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
