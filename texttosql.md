Yes, this is absolutely possible — it's a well-established pattern called Text-to-SQL, and it works surprisingly well with modern LLMs. Here's the core idea and how to wire it up.
How It Works
The key is giving the LLM your table schema as context, then asking it to generate a SQL query from the natural language question. The LLM never sees your actual data — just the structure.


import requests
import mysql.connector
import json

# Your table schema described for the LLM
SCHEMA = """
Table: Tickets
Columns:
- TicketNumber (INT, PRIMARY KEY)
- customerId (INT, FK to Customers.customerId)
- agent (VARCHAR) - name of the service desk agent
- createdWhen (DATETIME) - when the ticket was created
- status (VARCHAR) - e.g. 'Open', 'In Progress', 'Resolved', 'Closed'
- description (TEXT)

Table: Customers
Columns:
- customerId (INT, PRIMARY KEY)
- customerName (VARCHAR)
"""

def ask_llm_for_sql(question: str) -> str:
    """Send a natural language question to the LLM, get back a SQL query."""

    system_prompt = f"""You are a SQL query generator. Given the following MySQL schema:

{SCHEMA}

Convert the user's natural language question into a valid MySQL SELECT query.
Rules:
- Return ONLY the SQL query, no explanation, no markdown backticks.
- Use proper JOIN syntax when multiple tables are needed.
- Never generate INSERT, UPDATE, DELETE, DROP, or ALTER statements.
- If the question is ambiguous, make reasonable assumptions.
- Use NOW() or CURDATE() for relative date references like "today" or "this morning".
"""

    response = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": "YOUR_API_KEY",
            "content-type": "application/json",
            "anthropic-version": "2023-06-01"
        },
        json={
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 1024,
            "system": system_prompt,
            "messages": [{"role": "user", "content": question}]
        }
    )

    data = response.json()
    sql = data["content"][0]["text"].strip()
    return sql


def run_query(sql: str):
    """Execute the generated SQL and return results."""
    conn = mysql.connector.connect(
        host="localhost", user="you", password="pass", database="servicedesk"
    )
    cursor = conn.cursor(dictionary=True)
    cursor.execute(sql)
    results = cursor.fetchall()
    cursor.close()
    conn.close()
    return results




question = "How many tickets have been created since 9AM this morning?"
sql = ask_llm_for_sql(question)

print(f"Generated SQL: {sql}")
# e.g. → SELECT COUNT(*) AS ticket_count FROM Tickets
#         WHERE createdWhen >= CONCAT(CURDATE(), ' 09:00:00')

results = run_query(sql)
print(results)



Important Safety Considerations
Since you're executing LLM-generated SQL against a real database, you'll want guardrails:
1. Use a read-only MySQL user — this is the single most important step. Create a dedicated user that only has SELECT privileges so even if the LLM hallucinates a DROP TABLE, it simply fails.



CREATE USER 'llm_reader'@'localhost' IDENTIFIED BY 'somepassword';
GRANT SELECT ON servicedesk.* TO 'llm_reader'@'localhost';


def is_safe_query(sql: str) -> bool:
    dangerous = ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE", "GRANT"]
    first_keyword = sql.strip().split()[0].upper()
    return first_keyword == "SELECT" and not any(d in sql.upper() for d in dangerous)



3. Optional: show the SQL to the user first — let your manager see and confirm the query before it runs, especially in early stages while you're building trust in the output.
Bonus: Human-Friendly Answers
You can take it one step further — send the raw results back to the LLM to get a natural language summary:

def summarize_results(question, sql, results):
    response = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={ ... },
        json={
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 1024,
            "messages": [{
                "role": "user",
                "content": f"""Original question: {question}
SQL used: {sql}
Results: {json.dumps(results, default=str)}

Summarize these results in plain English for a non-technical manager."""
            }]
        }
    )
    return response.json()["content"][0]["text"]