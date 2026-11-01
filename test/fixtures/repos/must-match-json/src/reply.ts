import OpenAI from 'openai';
const client = new OpenAI();
export async function ask(prompt: string) {
  const res = await client.chat.completions.create({ model: 'gpt-6', messages: [{ role: 'user', content: prompt }] });
  return JSON.parse(res.choices[0].message.content);
}
