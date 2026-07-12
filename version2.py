"""
version2.py - Stage 2: ticket classifier with confidence score.

Same gateway call as version1, but the model is instructed to answer with a
JSON object containing its reasoning, the chosen category, and a confidence
score (0-100) following a fixed rubric. classify_ticket() returns a dict:

    {"category": "Mailbox", "confidence": 85, "reasoning": "..."}

If the model output cannot be parsed, the ticket falls back to
{"category": "Other", "confidence": 0, ...} so a batch run never crashes.
"""

import json
import os
import re

import requests

# Prefer an environment variable so the token never lands in source control.
ACCESS_TOKEN = os.environ.get("GENAI_ACCESS_TOKEN", "AB123456768XXXXXX")
URL = "https://SERVER.azure-api.net/stage/services/generativeai"

CATEGORIES = [
    "Hardware",
    "Accounts",
    "Mailbox",
    "Distribution/Security Group",
    "Other",
]

MAX_LONG_DESC_CHARS = 2000

# Internal abbreviations GPT cannot know on its own - without this list it
# will confidently apply the PUBLIC meaning (e.g. IOS = Apple iOS). One term
# per line; grow this list with every jargon-driven misclassification you
# find in eval_results.csv.
COMPANY_GLOSSARY = """\
- COD = Company Owned Device (a physical device such as a laptop or phone)
- IOS = Inventory Observation System (an internal application; NOT Apple iOS or iPhone)
- DL = distribution list
- SG = security group"""

# The category definitions below are first drafts - tune them to match how
# your Service Desk actually uses each category; they are the single biggest
# lever on classification accuracy.
SYSTEM_PROMPT = """You are a ticket classifier for an IT Service Desk.

Classify each ticket into exactly one of the following categories:
- Hardware: physical devices and their performance - laptops, desktops, monitors, printers, docking stations, peripherals
- Accounts: user accounts, passwords, logins, MFA, access rights to systems or applications
- Mailbox: personal or shared mailboxes - access, permissions, size, mail delivery issues
- Distribution/Security Group: creating or changing distribution lists or security groups, adding or removing members
- Other: anything that does not clearly fit the categories above

Company-specific terminology:
These tickets come from a company that uses internal abbreviations. Wherever
one of the terms below appears in a ticket, the definition given here
OVERRIDES the common or public meaning of that term. Ticket writers are
inconsistent with casing and plurals: treat these abbreviations
case-insensitively ("DL", "dl", "Dl", "DLs" all mean distribution list) and
use the surrounding context to confirm the intended meaning:
<GLOSSARY>

Also report how confident you are in your decision as an integer from 0 to 100,
using this rubric:
- 90-100: the description explicitly and unambiguously matches one category
- 70-89: strong match, but the wording is indirect or slightly ambiguous
- 40-69: ambiguous - the ticket could plausibly fit two or more categories
- 0-39: very unclear or too little information; the choice is close to a guess

Respond with ONLY a JSON object in exactly this format, with the keys in this
order, and no markdown, code fences, or extra text:
{"reasoning": "<one short sentence explaining your choice>", "category": "<one of the category names above>", "confidence": <integer 0-100>}""".replace("<GLOSSARY>", COMPANY_GLOSSARY)


def build_user_text(short_description, long_description=None):
    """Label each field so the model knows which is which."""
    parts = ["Short Description: " + short_description.strip()]
    if long_description and long_description.strip():
        parts.append(
            "Long Description: " + long_description.strip()[:MAX_LONG_DESC_CHARS]
        )
    return "\n\n".join(parts)


def extract_content(data):
    """
    Pull the assistant's text out of the gateway response.

    The standard OpenAI shape (choices[0].message.content) is tried first;
    API Management gateways sometimes wrap it, so a few common wrapper keys
    are also checked. If your gateway uses a different envelope, run once,
    look at the printed raw response, and adjust here.
    """
    if isinstance(data, str):
        return data
    if isinstance(data, dict):
        if "choices" in data:
            return data["choices"][0]["message"]["content"]
        for key in ("modelResponse", "response", "result", "data", "body"):
            if key in data:
                return extract_content(data[key])
    raise ValueError(
        "Could not find message content in response: " + json.dumps(data)[:500]
    )


def parse_result(content):
    """
    Parse the model's JSON answer into a validated dict.

    Tolerates code fences or stray text around the JSON object. On any
    failure returns a low-confidence 'Other' so batch runs keep going;
    the raw model output is kept in 'reasoning' for troubleshooting.
    """
    match = re.search(r"\{.*\}", content, re.DOTALL)
    if match:
        try:
            data = json.loads(match.group(0))
            category = str(data.get("category", "")).strip()
            for known in CATEGORIES:
                if known.lower() == category.lower():
                    confidence = max(0, min(100, int(data.get("confidence", 0))))
                    return {
                        "category": known,
                        "confidence": confidence,
                        "reasoning": str(data.get("reasoning", "")).strip(),
                    }
        except (ValueError, TypeError):
            pass
    return {
        "category": "Other",
        "confidence": 0,
        "reasoning": f"unparseable model output: {content!r}",
    }


def classify_ticket(short_description, long_description=None):
    """Return {'category': ..., 'confidence': 0-100, 'reasoning': ...}."""
    payload = {
        "domainName": "Assistant",
        "modelName": "gpt-5.1",
        "modelPayload": {
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": build_user_text(short_description, long_description),
                        }
                    ],
                },
            ],
            "temperature": 0,
            "top_p": 0.95,
            "frequency_penalty": 0,
            "presence_penalty": 0,
            "max_tokens": 500,
            "stop": None,
        },
    }

    headers = {
        "Authorization": f"Bearer {ACCESS_TOKEN}",
        "Content-Type": "application/json",
    }
    response = requests.post(URL, headers=headers, json=payload, timeout=60)
    response.raise_for_status()

    return parse_result(extract_content(response.json()))


if __name__ == "__main__":
    test_tickets = [
        ("Laptop very slow", None),
        ("Mailbox Access", None),
        ("Access issue", None),  # deliberately vague -> expect low confidence
        ("Voice MACD", None),
        (
            "Add user to Finance DL",
            "Hi team, John Smith joined Finance last Monday and needs to be "
            "added to the Finance distribution list so he receives the "
            "monthly close reminders. Manager approved. Thanks!",
        ),
    ]

    for short_desc, long_desc in test_tickets:
        result = classify_ticket(short_desc, long_desc)
        print(
            f"{short_desc!r:30} -> {result['category']:28} "
            f"confidence={result['confidence']:3d}  ({result['reasoning']})"
        )
