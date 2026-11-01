import json
def parse(reply):
    return json.loads(reply.content)
