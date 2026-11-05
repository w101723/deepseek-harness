# SQL-created datasets: supported subset and enforcement

## Supported

```sql
SELECT amount, quantity FROM analytics.orders
WHERE region = 'east' AND amount >= 100
```

- Only one source table, an explicit list of 1–50 identifiers, and optionally up to eight AND-combined comparisons. Operators: =, <>, >=, <=, >, <.
- Literals: single-quoted strings (embedded quotes written as ''), or finite decimal numbers.
- Source schema, table, selected fields and fixed-predicate fields are verified against the configured DB's metadata before creating a dataset.
- The supplied SQL is **never executed**. It is interpreted into a restricted semantic definition. The original projection and fixed predicates are persisted.
- Every downstream query (AIPro, scheduler, dashboard and normal QuerySpec) includes those immutable predicates, plus user and role-policy filters; all values are bound parameters.
- Hidden source columns used for fixed predicates are not exposed as dimensions or metrics.
- Copying a dataset copies its fixed predicates; existing SQL datasets without predicates remain supported.

## Rejected

Arbitrary or multi-statement SQL, *, joins, CTEs, aliases, OR, expressions, grouping, ordering, inline functions, subqueries and comments. This is a deliberate safe implementation subset, not an arbitrary SQL editor.

## Security and operations

Use read-only database users. Creation-time schema validation is not a guarantee that external database schemas will never change; runtime DB errors are surfaced without secrets. Dataset policies and tenant authorization continue to apply independently. For a production-grade SQL editor, use a fully validated per-dialect AST and enforce query costs, execution time and row security separately.
