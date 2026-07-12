export function buildWebhookTargets(apiUrl: string) {
  const baseUrl = apiUrl.replace(/\/+$/, '');
  return {
    health: `${baseUrl}/health`,
    twilioSms: `${baseUrl}/webhooks/twilio/sms`,
    twilioWhatsapp: `${baseUrl}/webhooks/twilio/whatsapp`,
    telegram: `${baseUrl}/chat/webhooks/telegram`,
    showmojo: `${baseUrl}/webhooks/showmojo`,
  };
}
