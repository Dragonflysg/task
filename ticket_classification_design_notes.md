# AI-Powered Service Desk Ticket Classification — Design Notes

*Discussion summary: approach, design decisions, and module walkthrough for
LLM-based ticket routing at the service desk.*

---

## 1. The Problem

The service desk receives tickets with two fields — a **short description**
(e.g. "slow laptop", "login issue to website", "EOS request") and a **long
description** with more detail. Some tickets are resolved at first contact;
others must be evaluated and reassigned to the correct team (Local Support,
Mobile Team, Network Team, etc.).

Goal: use an LLM (via API, in Python) to classify tickets and suggest or
perform the reassignment automatically.

Two concerns raised up front:

1. Can the AI produce a **confidence score** so we know when to trust it?
2. How do we handle **company-specific terminology** (e.g. "EOS request")
   that the LLM has never seen, without training/fine-tuning a model?

---

## 2. Confidence Scores — What Works and What Doesn't

### The caveat

An LLM's self-reported confidence is **not a calibrated probability**. If
you ask "how confident are you, 0–100?", it gives a number that is *useful*
but not statistically rigorous — LLMs tend to be overconfident and cluster
around 80–95. In practice the scores are still directionally reliable:
genuinely ambiguous tickets do get lower scores, which is enough to drive a
triage workflow.

### The technique: structured output + an escape hatch

Force the model to respond in strict JSON, and explicitly give it a safe
"I don't know" option (`UNKNOWN`) plus a field to surface unfamiliar jargon:

```
Respond ONLY with JSON, no markdown fences:
{
  "team": "<one of the allowed labels, or UNKNOWN>",
  "confidence": <0-100>,
  "reasoning": "<one sentence>",
  "unfamiliar_terms": ["<any terms you didn't recognize>"]
}

Rules:
- If the short and long description conflict, trust the long description.
- If you encounter jargon not in the glossary, lower your confidence and
  list it in unfamiliar_terms.
- Never invent a mapping for terms you don't recognize — use UNKNOWN.
```

Then branch in Python:

```python
result = json.loads(response_text)
if result["team"] == "UNKNOWN" or result["confidence"] < 75:
    route_to_human_review(ticket, result)
else:
    assign_to_team(ticket, result["team"])
```

The `unfamiliar_terms` field is gold — it tells you which glossary entries
you're missing (see the feedback loop below).

### The stronger signal: self-consistency voting

Some APIs expose token **logprobs** (a truer measure of model uncertainty),
but the Anthropic API does not currently. The practical alternative:

- Call the API **3 times at temperature ~0.7** for the same ticket.
- **3/3 agreement** → high confidence.
- **2/3 agreement** → medium; cap the confidence, don't auto-assign.
- **Split vote** → send to a human.

Costs 3× tokens, but for a high-stakes routing decision it's very
effective — and with a Haiku-class model the cost is negligible anyway.

The final confidence score in the module **blends both signals**:
self-reported confidence averaged across the agreeing votes, capped or
overridden by the level of vote agreement.

---

## 3. Custom Terminology — No Training Required

Fine-tuning is off the table (and unnecessary). Options, in order of how
far to go:

### Option A: Glossary in the prompt (start here)

Inject term → team mappings directly into the system prompt:

```
Company-specific glossary (authoritative — always follow these mappings):
- "EOS request" = End-Of-Support hardware replacement → LOCAL_SUPPORT
```

A service desk typically has 50–200 special terms — trivially small for a
modern context window. **Store the glossary in a MySQL table** (or JSON
file) so the service desk maintains it without touching code; the prompt is
built dynamically at runtime.

### Option B: Few-shot examples from real tickets

Even better than definitions: include 15–30 real (anonymized) historical
tickets with their correct final assignment. LLMs learn the *pattern* of
your organization from examples faster than from rules — and you already
have this data, because every reassigned ticket tells you where it
*should* have gone.

### Option C: Retrieval (RAG) — when the glossary/examples outgrow the prompt

This is the "machine learning assisted by the LLM" pattern:

1. Embed historical tickets (short desc + final resolved team) — e.g. with
   a local sentence-transformers model on the homelab; no external calls
   needed for embeddings.
2. For each new ticket, find the 5–10 most similar historical tickets by
   cosine similarity.
3. Inject those into the prompt: "Here are similar past tickets and where
   they were correctly routed: …"
4. Ask the LLM to classify.

The system "learns" continuously — every human-corrected ticket becomes a
new retrieval example — with zero model training. This is the standard
production pattern for this class of problem.

### Option D: The feedback loop (what makes it self-improving)

- Low-confidence tickets go to a human; the decision is logged.
- `unfamiliar_terms` output is reviewed weekly → new glossary entries.
- Corrected classifications are added to the example store.
- Monthly, measure accuracy against actual final assignments — misrouted
  tickets get reassigned in the ITSM, so **ground truth is free**.

---

## 4. Design Recommendations

**Use both descriptions.** Don't classify on the short description alone —
"slow laptop" might have a long description revealing it's actually a VPN
issue. Send both; tell the model the long description wins on conflict.

**Build an eval set before deploying.** Pull 200–300 historical tickets
where the correct final team is known. Run the classifier against them and
measure accuracy per team. This shows where the confusion is (e.g. NETWORK
vs APPS) and lets you tune the prompt with evidence instead of vibes. With
existing MySQL access to ticket data, this is a half-day job.

**Start in shadow mode.** For the first few weeks, the AI classifies but
does not auto-assign — it shows a suggestion the service desk agent accepts
or overrides with one click. You collect correction data risk-free, build
trust with the other department, and only enable auto-assignment for
categories with proven accuracy (say >95%). Politically, "AI suggests,
human decides" is a much easier sell than "AI reassigns your tickets."

**Model choice.** Haiku-class models are ideal — classification with a good
glossary and examples doesn't need a frontier model, and at service desk
volumes the cost is fractions of a cent per ticket.

---

## 5. The Python Module (`ticket_triage`)

### Files

| File | Purpose |
|---|---|
| `schema.sql` | MySQL tables: teams, glossary, classification_log, corrections, unfamiliar_terms |
| `config.py` | Model choice, voting count, auto-assign threshold, DB creds (env vars) |
| `store.py` | Data access — `MySQLStore` for production, `FileStore` (JSON) for dev/testing |
| `prompt_builder.py` | Assembles the system prompt from teams + glossary + few-shot corrections |
| `classifier.py` | API calls, robust JSON parsing, 3-vote self-consistency, routing decision |
| `evaluate.py` | Accuracy eval against historical tickets (CSV in, metrics + confusion matrix out) |
| `test_offline.py` | 12 unit tests for parsing/voting/prompt logic — no API key or DB needed |
| `sample_data/` | Example knowledge JSON + eval CSV showing expected formats |

### Key design decisions

- **`teams` and `glossary` are data, not code** — the service desk
  maintains routing rules themselves; the prompt is rebuilt from the DB
  (`refresh_prompt()`, e.g. hourly cron), so glossary edits and new
  corrections take effect without a restart or deploy.
- **Corrections become few-shot examples automatically.** The 25 most
  recent rows in `corrections` are injected into every prompt. Correcting
  a ticket literally changes the model's behavior — "training" without
  training.
- **Defensive parsing.** The JSON parser handles markdown fences, preamble
  prose, invalid labels, and out-of-range confidence. A malformed model
  response degrades to `UNKNOWN` (human review) rather than crashing or
  misrouting.
- **Decision logic** (`_decide()` in `classifier.py`):
  - Unanimous 3/3 **and** average confidence ≥ 80 → **auto-assign**
  - Unanimous but confidence < 80 → suggest, human decides
  - 2/3 majority → confidence capped at 70, human decides
  - Split vote or majority-UNKNOWN → human review
- **Thresholds are tunable, not magic.** The 80/unanimity defaults are
  sensible starting points; the eval run tells you whether to loosen for
  coverage or tighten for precision.

### The feedback loop

```
new ticket ──▶ classify ──▶ high confidence ──▶ auto-assign
                   │
                   └──▶ low confidence ──▶ human decides
                                              │
                                              ▼
                                     corrections table ──▶ few-shot examples
                                                             in next prompt

unfamiliar_terms table ──▶ weekly review ──▶ glossary table ──▶ next prompt
```

Weekly maintenance query:

```sql
SELECT term, seen_count FROM unfamiliar_terms
WHERE reviewed = 0 ORDER BY seen_count DESC LIMIT 20;
```

### Building the eval set from ITSM data

The *final* assignment group on closed tickets is free ground truth:

```sql
SELECT ticket_id, short_description AS short_desc,
       long_description AS long_desc,
       final_assignment_group AS correct_team
FROM tickets
WHERE state = 'Closed'
  AND created_at >= NOW() - INTERVAL 6 MONTH
ORDER BY RAND() LIMIT 300;
```

Export to CSV (mapping assignment group names to team codes), then:

```bash
python evaluate.py historical_tickets.csv --mysql
```

Watch two numbers:

- **Auto-assign accuracy** — should be well above 95% before letting it
  route unattended.
- **Coverage** — what % of tickets clear the auto-assign bar. 60–80% is a
  realistic, valuable target; the remainder goes to humans, which is fine.

### Rollout plan

1. **Week 0:** run `evaluate.py` on 200–300 historical tickets; tune team
   descriptions and glossary until auto-assign accuracy is solid. (The
   seed team descriptions in `schema.sql` are the single biggest accuracy
   lever in the whole system.)
2. **Weeks 1–3 (shadow mode):** classify live tickets, suggestion-only;
   agents accept or override. Log everything.
3. **Go-live:** enable auto-assign only for teams with proven high
   precision; keep the rest suggestion-only.

### Quick start

```bash
pip install anthropic
export ANTHROPIC_API_KEY=sk-ant-...

python test_offline.py                      # sanity check, no API calls
python classifier.py "EOS request" ""       # one live classification
python evaluate.py sample_data/eval_sample.csv
```

### Cost note

Haiku + ~1.5k-token prompt × 3 votes ≈ fractions of a cent per ticket.
To cut it 3× later: drop `n_votes` to 1 when the short description exactly
matches a glossary term with an authoritative team mapping.
