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



3. Optional: show the SQL to the user 
 first — let your manager see and confirm the query before it runs, especially in early stages while you're building trust in the output.
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


MULTIPLE SCHEMA

SCHEMA = """
You are querying a MySQL server with multiple schemas (databases).
When writing queries, always use fully qualified table names: schema_name.table_name
Tables can be JOINed across schemas since they are on the same server.

=== Schema: computers ===

Table: computers.assets
- assetId (INT, PRIMARY KEY)
- assetTag (VARCHAR) - company asset tag e.g. "LT-001234"
- model (VARCHAR) - e.g. "ThinkPad T14", "Dell Latitude 5540"
- serialNumber (VARCHAR)
- assignedTo (INT, FK to endusers.employees.employeeId) - NULL if unassigned
- status (VARCHAR) - 'In Use', 'In Stock', 'Decommissioned', 'Under Repair'
- purchaseDate (DATE)
- warrantyExpiry (DATE)
- department (VARCHAR)

=== Schema: ticketing ===

Table: ticketing.tickets
- ticketNumber (INT, PRIMARY KEY, auto-increment)
- subject (VARCHAR) - short summary of the issue
- description (TEXT) - detailed issue description
- customerId (INT, FK to endusers.employees.employeeId)
- agent (VARCHAR) - service desk agent handling the ticket
- status (VARCHAR) - 'Open', 'In Progress', 'Resolved', 'Closed'
- priority (VARCHAR) - 'Low', 'Medium', 'High', 'Critical'
- category (VARCHAR) - 'Hardware', 'Software', 'Network', 'Access Request'
- createdWhen (DATETIME)
- resolvedWhen (DATETIME, nullable)

=== Schema: endusers ===

Table: endusers.employees
- employeeId (INT, PRIMARY KEY)
- fullName (VARCHAR)
- email (VARCHAR)
- department (VARCHAR) - e.g. 'Finance', 'HR', 'Engineering'
- jobTitle (VARCHAR)
- managerId (INT, FK to endusers.employees.employeeId, nullable)
- isActive (BOOLEAN) - whether the employee is currently active

=== Relationships ===
- ticketing.tickets.customerId → endusers.employees.employeeId
- computers.assets.assignedTo → endusers.employees.employeeId
"""


The Relationships section at the bottom is important — it tells the LLM how to JOIN across schemas. Now your manager can ask cross-schema questions naturally:

"Which employees have open tickets about hardware but have no laptop assigned?"
"Show me all laptops assigned to people in the Finance department with warranty expiring this year"
"How many tickets has the HR department raised this month?"

The LLM would generate something like:
-- "How many tickets has the HR department raised this month?"
SELECT e.department, COUNT(*) AS ticket_count
FROM ticketing.tickets t
JOIN endusers.employees e ON t.customerId = e.employeeId
WHERE e.department = 'HR'
  AND t.createdWhen >= DATE_FORMAT(NOW(), '%Y-%m-01')
GROUP BY e.department;


One practical tip — if your schemas grow to many tables, you don't need to list every column of every table in the prompt every time. You can dynamically build the schema string by querying INFORMATION_SCHEMA:


def build_schema_string(schemas: list[str]) -> str:
    """Pull actual schema definitions from MySQL automatically."""
    conn = mysql.connector.connect(host="localhost", user="you", password="pass")
    cursor = conn.cursor()

    lines = []
    for schema in schemas:
        lines.append(f"\n=== Schema: {schema} ===\n")
        cursor.execute("""
            SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, COLUMN_KEY, COLUMN_COMMENT
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = %s
            ORDER BY TABLE_NAME, ORDINAL_POSITION
        """, (schema,))

        current_table = None
        for table, col, col_type, key, comment in cursor.fetchall():
            if table != current_table:
                current_table = table
                lines.append(f"\nTable: {schema}.{table}")
            pk = " (PRIMARY KEY)" if key == "PRI" else ""
            desc = f" - {comment}" if comment else ""
            lines.append(f"  - {col} ({col_type}){pk}{desc}")

    cursor.close()
    conn.close()
    return "\n".join(lines)

# Usage
SCHEMA = build_schema_string(["computers", "ticketing", "endusers"])


This way, whenever you add a new column or table, the prompt stays in sync automatically. And if you put meaningful comments on your MySQL columns (ALTER TABLE ... MODIFY COLUMN status VARCHAR(50) COMMENT 'Open, In Progress, Resolved, Closed'), those comments flow into the LLM context too, making the generated SQL even more accurate.