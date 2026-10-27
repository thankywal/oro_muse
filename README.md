# Oro on Muse

A Messenger shop assistant that answers customers with Meta's Muse models.
Built for the Meta Global AI Developer Hackathon (Startup track), October 2026.

Work in progress. The packages here are self-contained and carry no code from the Oro product.

## Packages
- `packages/muse-provider`: a dependency-free client for Meta's Muse models: chat (Muse Spark on the Meta Model API, Muse Spark Open on Baseten), voice transcription, image generation and SAM 3.1 segmentation.

## Meta tools used
- `muse-spark-1.3` (Meta Model API) and `meta-models/muse-spark-open-1026` (Baseten): the assistant's answers.
- `muse-voice-transcribe-1.0`: customers' voice notes.
- `sam-3.1`: finding the product in a customer's photo.
- `muse-image-1.0`: promo images (stretch).
