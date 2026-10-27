# Bench, 2026-10-27: one reply engine, three models

**What was measured.** The reply engine of a jewellery shop's Messenger page on Oro, with the shop's rules and catalogue as they stood on 2026-10-27. Only the model changed between runs: the same engine, tools, prompt and checks. There were eight scripted customers, each in English, Burmese and Thai, so 24 turns per model:

- a price by name
- a category
- an attribute
- a budget
- how to pay
- a discount ask
- an order
- a greeting

Each turn is checked for what that customer needs: the right products, the catalogue price, the shop's payment facts, no discount granted, and the customer's own language.

| model | passed | English | Burmese | Thai | median turn | model calls | input tokens (cached) | output tokens (reasoning) |
|---|---|---|---|---|---|---|---|---|
| Claude Haiku 5.5 (baseline) | 24/24 | 8/8 | 8/8 | 8/8 | 2.6 s | 45 | 340,599 (302,615) | 9,241 (0) |
| **Muse Spark 1.3**, Meta Model API, `reasoning_effort: low` | **24/24** | 8/8 | 8/8 | 8/8 | 3.7 s | 60 | 322,872 (123,288) | 20,093 (12,258) |
| Muse Spark Open 1026, Baseten, thinking off | 3/24 | 0/8 | 3/8 | 0/8 | 6.4 s | 128 | 765,071 (719,104) | 11,287 (920) |

**What it says.** Muse Spark 1.3 answered every customer right in all three languages. It was about a second slower at the median, because it reasons before it answers: 12k of its 20k output tokens were reasoning. Muse Spark Open kept calling the catalogue tool and never wrote the reply in 21 of 24 turns. With its reasoning on, it failed 7 of 8. So the demo and the switch run on Muse Spark 1.3.

**Why the transcripts are not here.** The turn transcripts carry the shop's own contact details, payment facts and catalogue, and the private engine's internals. The numbers above are everything they say about the models.
