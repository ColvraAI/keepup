import OpenAI from 'openai';

const client = new OpenAI();
const TRIAGE_SYSTEM_PROMPT = 'You are a support ticket classifier. Reply with one of the following labels: billing, bug, feature, other.';

export async function triage(message: string): Promise<string> {
  const response = await client.chat.completions.create({
    model: 'gpt-6-sol',
    messages: [{ role: 'system', content: TRIAGE_SYSTEM_PROMPT }, { role: 'user', content: message }],
  });
  return response.choices[0].message.content ?? 'other';
}
