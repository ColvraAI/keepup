// Pulls order details out of a ticket, so the reply can look them up.
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

export type TicketDetails = { trackingNumber: string | null; shopName: string | null; urgent: boolean };

export async function extractDetails(ticket: string): Promise<TicketDetails> {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 200,
    system: 'Read the support ticket. Reply with only a JSON object with the keys trackingNumber, shopName and urgent.',
    messages: [{ role: 'user', content: ticket }],
  });
  return JSON.parse(response.content[0].text) as TicketDetails;
}
