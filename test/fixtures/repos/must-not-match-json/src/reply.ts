import OpenAI from 'openai';
export async function ask(prompt: string) {
  const res = await client.chat.completions.create({
    response_format: { type: 'json_schema', json_schema: schema },
  });
  return JSON.parse(res.choices[0].message.content);
}
