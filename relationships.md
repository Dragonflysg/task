RELATIONSHIPS = """
=== Relationships ===

Primary keys (preferred for JOINs - always use these when possible):
- ticketing.tickets.customerId → endusers.employees.employeeId
- computers.assets.assignedTo → endusers.employees.employeeId

Secondary/name-based links (use only when the query specifically mentions names):
- ticketing.tickets.personName matches endusers.employees.fullName
- computers.assets.custodian matches endusers.employees.fullName
- ticketing.tickets.agent matches endusers.employees.fullName

=== Important Notes ===
- Always prefer JOINs on ID columns over name columns. IDs are unique and reliable.
- Name columns may have inconsistencies (e.g. "John Smith" vs "john smith" vs "Smith, John").
- If a query can be answered using ID relationships, use those even if names are mentioned.
"""