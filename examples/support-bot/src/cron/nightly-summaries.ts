// Runs once a night: writes a short summary of each ticket closed that day. Nobody reads these until morning.
import Anthropic from '@anthropic-ai/sdk';
import { closedToday, saveSummary } from '../db.ts';

const anthropic = new Anthropic();

for (const ticket of await closedToday()) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5-5',
    max_tokens: 200,
    system: 'Summarise this closed support ticket in two sentences for the morning report.',
    messages: [{ role: 'user', content: ticket.body }],
  });
  const block = response.content[0];
  await saveSummary(ticket.id, block.type === 'text' ? block.text : '');
}
