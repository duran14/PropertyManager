# Voice Provider Research

Research date: 2026-07-10

This document compares likely voice options for the Property Manager assistant. Pricing changes often, so verify official pricing again before committing to a provider.

## Product Need

The voice assistant should support prospect-initiated calls or voice interactions. It should sound warm, professional, and natural, while clearly disclosing that it is AI-based at an appropriate moment.

The current channel rollout preference is:

1. Telegram.
2. WhatsApp.
3. Voice.

## Important Architecture Note

Voice has at least two layers:

- AI voice agent: understands and responds in real time.
- Telephony layer: connects the assistant to phone calls.

Twilio is a likely telephony layer. Gemini, OpenAI Realtime, and ElevenLabs are AI/audio layers.

## Options

### Gemini Live / Gemini Audio

Official Google pricing currently lists Gemini 3.5 Live Translate as a low-latency real-time speech-to-speech model with an effective audio price of about USD $0.0368 per minute, based on input and output audio token consumption.

Pros:

- Attractive published effective per-minute price for speech-to-speech translation.
- Strong Google ecosystem.
- Good candidate to evaluate for low-latency multilingual voice.

Risks / questions:

- Need to validate whether the exact model fits a leasing voice-agent use case, not only translation.
- Need hands-on testing for naturalness, interruption handling, and phone-call latency.

Source:

- https://ai.google.dev/gemini-api/docs/pricing

### ElevenLabs

ElevenLabs is very strong for natural voice quality. Official plan pricing includes Free, Starter, Creator, Pro, Scale, Business, and Enterprise tiers. API usage is billed in US dollars for products such as Text to Speech and Speech to Text. Current API pricing lists Text to Speech at USD $0.10 per 1,000 characters for Multilingual v2/v3 or USD $0.05 for Flash/Turbo, and Speech to Text at USD $0.22 per hour for Scribe or USD $0.39 per hour for Scribe realtime.

ElevenLabs also offers Conversational AI / ElevenAgents. A 2025 company blog post said Conversational AI calls started at USD $0.10 per minute, with lower rates on annual Business and Enterprise plans. Verify current Conversational AI pricing before implementation.

Pros:

- Best candidate if voice naturalness and brand voice quality are the top priority.
- Strong custom voice and voice design ecosystem.
- Useful even if another model handles reasoning, because ElevenLabs can provide high-quality TTS.

Risks / questions:

- Conversational-agent pricing and architecture must be verified directly in the current account/API docs.
- If we combine ElevenLabs voice with a separate LLM, architecture becomes more complex.

Sources:

- https://elevenlabs.io/pricing
- https://elevenlabs.io/pricing/api
- https://elevenlabs.io/blog/we-cut-our-pricing-for-conversational-ai

### OpenAI Realtime

OpenAI Realtime is another strong candidate for end-to-end voice agents. Official API pricing currently lists `gpt-realtime-2.1` audio at USD $32 per 1M input tokens and USD $64 per 1M output tokens, with `gpt-realtime-2.1-mini` at USD $10 per 1M audio input tokens and USD $20 per 1M audio output tokens. OpenAI also lists realtime translate at USD $0.034 per minute and realtime whisper at USD $0.017 per minute.

Pros:

- Strong integrated realtime conversational stack.
- Good candidate for natural turn-taking and agent behavior.
- Useful if the rest of the product already uses OpenAI tooling.

Risks / questions:

- Token-based voice pricing is harder to estimate than a flat per-minute price.
- Need hands-on test for cost per actual property-management call.

Sources:

- https://developers.openai.com/api/docs/pricing
- https://openai.com/index/advancing-voice-intelligence-with-new-models-in-the-api/

### Twilio Voice

Twilio is not the AI brain. It is the telephony layer that can connect phone calls to the AI system.

Official US pricing lists local calls at about USD $0.0140 per minute to make calls and USD $0.0085 per minute to receive calls, with local numbers at USD $1.15 per month. Pricing for Canada should be verified on the Canada pricing page before launch.

Pros:

- Mature telephony infrastructure.
- Useful for inbound phone numbers, call routing, and later human handoff.

Risks / questions:

- Twilio costs are additional to AI voice costs.
- Need webhook and call-routing design.

Sources:

- https://www.twilio.com/en-us/voice/pricing/us
- https://www.twilio.com/en-us/voice/pricing/ca

## Initial Recommendation

Do not choose the final voice provider yet.

Implement channels in this order:

1. Telegram with text-first assistant.
2. WhatsApp with text-first assistant.
3. Voice prototype.

For the voice prototype, test at least:

- Gemini Live / Gemini audio,
- ElevenLabs Conversational AI or ElevenLabs voice plus separate reasoning model,
- OpenAI Realtime.

Use the same scripted leasing scenario for every provider:

1. Prospect asks about a property.
2. Prospect asks about requirements and pets.
3. Prospect asks to schedule a showing.
4. Prospect asks a legal/compliance-adjacent question.
5. Prospect asks for a human.

Measure:

- naturalness,
- latency,
- interruption handling,
- disclosure quality,
- handoff behavior,
- average cost per 5-minute and 10-minute conversation,
- ease of integrating with Twilio or another phone layer.

## MVP Leaning

For first voice experiments:

- If price and Google ecosystem matter most: start with Gemini.
- If natural voice quality matters most: start with ElevenLabs.
- If integrated realtime agent behavior matters most: start with OpenAI Realtime.

For actual phone calls, plan on a telephony layer such as Twilio regardless of the AI provider.
