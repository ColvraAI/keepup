from openai import OpenAI

client = OpenAI()
TRIAGE_SYSTEM_PROMPT = "You are a support ticket classifier. Reply with one of the following labels: billing, bug, feature, other."


def triage(message: str) -> str:
    response = client.chat.completions.create(
        model="gpt-6-sol",
        messages=[{"role": "system", "content": TRIAGE_SYSTEM_PROMPT}, {"role": "user", "content": message}],
    )
    return response.choices[0].message.content or "other"
