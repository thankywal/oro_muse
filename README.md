# Oro on Muse

A Messenger shop assistant that answers customers with Meta's Muse models: it reads the shop's
catalogue and rules, hears voice notes, and finds the product in a customer's photo.
Built for the Meta Global AI Developer Hackathon (Startup track), October 2026.

This repository holds the hackathon work only. It carries no code from the Oro product; Oro
reaches these models through the same client files (copied from `packages/muse-provider`).

## What is new (built during the hackathon)

| | Before | Now |
|---|---|---|
| The assistant's model | Claude Haiku 5.5 | **Muse Spark 1.3** (Meta Model API) or **Muse Spark Open** (Baseten), behind a per-page switch |
| A customer's voice note | dropped: the assistant never heard it | **transcribed by `muse-voice-transcribe-1.0`** and answered, marked "(voice note)" in the record |
| "Do you have this?" with a photo | the model sees the photo | **SAM 3.1 finds the object**, Muse Spark describes it, the catalogue is searched, matching product pictures are sent |
| A promo image for the owner (stretch) | none | `muse-image-1.0` |

## Packages

- `packages/muse-provider` (`@oro-muse/provider`): a dependency-free client for the Meta Model API and Baseten.
  - `chat()`: Muse Spark 1.3 and Muse Spark Open. Both models **always reason** before answering (with `max_tokens=200` every token went to reasoning and `content` came back null), so the client gives the answer room and sets `reasoning_effort`. Meta's `tool_choice` takes `auto` only, so `required` becomes `auto` and `none` sends no tools.
  - `transcribe()`: `POST /v1/asr/transcribe`, multipart `request` + `audio`. The endpoint takes mono 16-bit PCM WAV at 16 or 24 kHz only; `toPcmWav()` converts anything else with ffmpeg. A 5-second note came back in 1.3 s, every word right.
  - `segment()`: SAM 3.1 through `POST /v1/responses`. The answer is special-token text (`<0f>0<|box;x1=…;c=…|><|mask;…|>`), parsed by key; the box in source pixels is what a shop needs. The phrase matters: "bracelet" missed an arm bracelet that "jewelry" found.
  - `generateImage()`: Muse Image. The bytes under `b64_json` are WebP.

## Bench: the same assistant, three models

The reply engine of a jewellery shop's Messenger page on Oro (its rules and catalogue as they stood on 2026-10-27), eight scripted customers in English, Burmese and Thai (price by name, a category, an attribute, a budget, how to pay, a discount ask, an order, a greeting), one turn each. Checks: the right products, the catalogue price, the owner's payment facts, no discount granted, the customer's language.

| model | passed | median turn |
|---|---|---|
| Claude Haiku 5.5 (the shop's model today) | 24/24 | 2.6 s |
| **Muse Spark 1.3** (Meta Model API, `reasoning_effort: low`) | **24/24** | 3.7 s |
| Muse Spark Open 1026 (Baseten, thinking off) | 3/24 | 6.4 s |

Muse Spark Open kept calling the catalogue tool and never wrote the reply in 21 of 24 turns (and in 7 of 8 with its reasoning on), so the demo runs on Muse Spark 1.3. Of Muse Spark's 20k output tokens, 12k were reasoning.

## Meta tools used

- `muse-spark-1.3` (Meta Model API) and `meta-models/muse-spark-open-1026` (Baseten): the assistant's answers, with tool calling.
- `muse-voice-transcribe-1.0`: customers' voice notes (25 languages; no Burmese, so the voice demo is in English and Thai).
- `sam-3.1`: finding the product in a customer's photo.
- `muse-image-1.0`: promo images (stretch).

## Run the checks

```bash
npm install
npm test                     # 18 unit tests, no network
npm run typecheck
META_MODEL_API_KEY=… BASETEN_API_KEY=… npx tsx scripts/live-check.ts path/to/16k-mono.wav   # the real endpoints, test data only
```

## Privacy

While the Meta key runs on free credits, Meta may use the content for product improvement. Everything sent during the hackathon is demo and test data; no real customer conversation goes to these endpoints.

## Licence

MIT.
