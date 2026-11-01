// Runs on every new ticket: picks the queue it goes to.
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

const LABELS = ['billing', 'bug', 'how-to', 'refund', 'account', 'other'] as const;
export type Label = (typeof LABELS)[number];

const ROUTER_PROMPT = `You are a support ticket router. Read the ticket and answer with exactly one label from this list: ${LABELS.join(', ')}. Answer with the label and nothing else.`;

export async function routeTicket(ticket: string): Promise<Label> {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5-5',
    max_tokens: 10,
    system: ROUTER_PROMPT,
    messages: [{ role: 'user', content: ticket }],
  });
  const block = response.content[0];
  const text = block.type === 'text' ? block.text.trim().toLowerCase() : 'other';
  return LABELS.find((label) => label === text) ?? 'other';
}
