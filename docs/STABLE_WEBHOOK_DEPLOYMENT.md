# Stable Webhook Deployment

Use this when the API is deployed to a stable public URL for Twilio, Telegram, and future voice callbacks.

## Required Environment

Set `API_URL` to the public API origin:

```text
API_URL=https://your-api-host.example.com
WEB_URL=https://your-web-host.example.com
```

The app exposes the current target list at:

```text
GET /webhook-config
```

## Twilio Targets

SMS inbound webhook:

```text
{API_URL}/webhooks/twilio/sms
```

WhatsApp inbound webhook:

```text
{API_URL}/webhooks/twilio/whatsapp
```

## Telegram Target

Telegram webhook or poller target:

```text
{API_URL}/chat/webhooks/telegram
```

For the current local demo, Telegram can still run through the poller.

## Health Check

```text
{API_URL}/health
```

## Notes

- Cloudflare quick tunnels are fine for local testing, but they are temporary.
- Production/staging should use a stable host such as Render, Railway, Fly.io, Cloudflare Workers/Pages plus API hosting, or another managed Node host.
- Do not commit `.env` or live provider tokens.
